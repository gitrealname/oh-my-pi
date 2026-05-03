/**
 * mreview HTTP server — self-contained node:http server for browser-based
 * markdown review with AI chat sidebar.
 *
 * Vendored and adapted AI layer from Plannotator by backnotprop.
 * https://github.com/backnotprop/plannotator
 * License: MIT / Apache-2.0
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { URL } from "node:url";

import type { PiSDKConfig } from "./ai/types";

export interface MReviewDecision {
  feedback: string;
  annotations: unknown[];
  exit?: boolean;
  approved?: boolean;
}

export interface MReviewServerOptions {
  markdown: string;
  filePath: string;
  htmlContent: string;
  cwd: string;
  agent?: any; // Agent instance from the main omp session
}

function markdownToUnifiedDiff(markdown: string, filePath: string): string {
  const name = basename(filePath);
  const lines = markdown.split("\n");
  const header = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@`;
  const body = lines.map(l => `+${l}`).join("\n");
  return `${header}\n${body}\n`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(payload);
}

export async function startMReviewServer(
  options: MReviewServerOptions,
): Promise<{ url: string; waitForDecision(): Promise<MReviewDecision>; stop(): void }> {
  // AI: wire directly to the main omp agent session (no subprocess)
  const agent = options.agent;
  const aiAvailable = !!agent;

  const rawPatch = markdownToUnifiedDiff(options.markdown, options.filePath);
  const diffResponse = JSON.stringify({
    rawPatch,
    gitRef: basename(options.filePath),
    origin: "omp",
    diffType: "uncommitted",
    base: "HEAD",
    hideWhitespace: false,
    gitContext: { branch: "", availableDiffTypes: [], availableBases: [] },
  });

  let decisionResolve: ((d: MReviewDecision) => void) | null = null;
  const decisionPromise = new Promise<MReviewDecision>(r => { decisionResolve = r; });

  // Idle timeout: if no requests for 60s, assume browser closed
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (decisionResolve) decisionResolve({ feedback: "", annotations: [], exit: true });
    }, 600000);
  }

  // Inject CSS to hide plannotator UI elements that don't apply to mreview
  const hideCSS = `<style id="mreview-overrides">
    /* Hide git/PR-related toolbar buttons */
    button:has(> span:only-child) { }
    [class*="toolbar"] button[title="Git Add"],
    [class*="toolbar"] button[title="Stage"] { display: none !important; }
    /* Hide via button text content matching */
  </style>
  <script>
    // Remove UI elements by text content after DOM loads
    document.addEventListener('DOMContentLoaded', () => {
      const hide = (sel, texts) => {
        const observer = new MutationObserver(() => {
          document.querySelectorAll(sel).forEach(el => {
            const t = el.textContent?.trim();
            if (texts.includes(t)) el.style.display = 'none';
          });
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // Run once immediately after a delay for initial render
        setTimeout(() => {
          document.querySelectorAll(sel).forEach(el => {
            const t = el.textContent?.trim();
            if (texts.includes(t)) el.style.display = 'none';
          });
        }, 500);
      };
      hide('button', ['Git Add', 'Viewed', 'Copy Diff', '+ Git Add']);
      // Hide settings gear icon (last button in toolbar with gear SVG)
      setTimeout(() => {
        document.querySelectorAll('button').forEach(btn => {
          if (btn.querySelector('svg') && btn.getAttribute('aria-label')?.includes('Settings')) {
            btn.style.display = 'none';
          }
        });
      }, 500);
    });
  </script>`;
  const injectedHtml = options.htmlContent + hideCSS;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    resetIdleTimer();
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    try {
      // AI endpoints — routed through the main omp agent session
      if (pathname === "/api/ai/capabilities") {
        sendJson(res, 200, {
          available: aiAvailable,
          providers: aiAvailable ? [{ id: "omp", name: "omp", capabilities: { streaming: true, tools: true, fork: false, resume: false }, models: [{ id: "default", label: "Session Model", default: true }] }] : [],
          defaultProvider: aiAvailable ? "omp" : null,
        });
        return;
      }

      if (pathname === "/api/ai/session" && req.method === "POST") {
        // No-op session creation — we use the existing agent session
        sendJson(res, 200, { sessionId: "main", mode: "annotate", providerId: "omp" });
        return;
      }

      if (pathname === "/api/ai/query" && req.method === "POST" && agent) {
        let body: any;
        try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        const { prompt } = body;
        if (!prompt) { sendJson(res, 400, { error: "Missing prompt" }); return; }

        // SSE stream
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        let fullText = "";
        let ended = false;
        const finish = () => {
          if (ended) return;
          ended = true;
          res.write(`data: ${JSON.stringify({ type: "done", text: fullText })}\n\n`);
          res.end();
          unsub();
        };
        const unsub = agent.subscribe((e: any) => {
          if (ended) return;
          if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
            const delta = e.assistantMessageEvent.delta;
            fullText += delta;
            try { res.write(`data: ${JSON.stringify({ type: "text_delta", delta, text: fullText })}\n\n`); } catch {}
          }
          // agent_end signals the full turn is complete (including any tool calls)
          if (e.type === "agent_end") { finish(); }
        });

        // Wait for agent to be idle before prompting
        const waitForIdle = async (maxWait = 10000) => {
          const start = Date.now();
          while (agent.state?.isStreaming && Date.now() - start < maxWait) {
            await new Promise(r => setTimeout(r, 200));
          }
        };

        try {
          await waitForIdle();
          await agent.prompt(prompt);
          finish();
        } catch (err: unknown) {
          if (!ended) {
            try { res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`); } catch {}
            try { res.end(); } catch {}
            unsub();
          }
        }
        return;
      }

      if (pathname === "/api/ai/abort" && req.method === "POST" && agent) {
        agent.abort?.();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/ai/sessions") {
        sendJson(res, 200, { sessions: aiAvailable ? [{ id: "main", mode: "annotate", providerId: "omp" }] : [] });
        return;
      }

      if (pathname === "/api/ai/permission" && req.method === "POST") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Critical API routes — handled before switch to avoid any pattern-matching edge cases
      if (pathname === "/api/doc-content" && req.method === "GET") {
        sendJson(res, 200, { markdown: options.markdown, filePath: options.filePath });
        return;
      }

      if (pathname === "/api/diff" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(diffResponse);
        return;
      }
      if (pathname === "/api/capabilities" && req.method === "GET") {
        sendJson(res, 200, { canStageFiles: false, canSwitchDiffType: false, canSwitchBase: false });
        return;
      }
      switch (true) {
        case pathname === "/api/feedback" && req.method === "POST": {
          let body: { feedback?: string; annotations?: unknown[] } = {};
          try { body = JSON.parse(await readBody(req)); } catch { /* use defaults */ }
          sendJson(res, 200, { ok: true });
          // Resolve after response is sent
          setTimeout(() => {
            decisionResolve?.({
              feedback: typeof body.feedback === "string" ? body.feedback : "",
              annotations: Array.isArray(body.annotations) ? body.annotations : [],
            });
          }, 50);
          break;
        }

        case pathname === "/api/approve" && req.method === "POST": {
          sendJson(res, 200, { ok: true });
          setTimeout(() => decisionResolve?.({ feedback: "", annotations: [], approved: true }), 50);
          break;
        }

        case pathname === "/api/exit" && req.method === "POST": {
          sendJson(res, 200, { ok: true });
          setTimeout(() => decisionResolve?.({ feedback: "", annotations: [], exit: true }), 50);
          break;
        }

        case pathname === "/api/image" && req.method === "GET": {
          const imgPath = url.searchParams.get("path");
          if (!imgPath || !existsSync(imgPath)) {
            res.writeHead(404); res.end("Not found"); break;
          }
          const ext = imgPath.split(".").pop()?.toLowerCase() ?? "";
          const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
            : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : "application/octet-stream";
          const data = readFileSync(imgPath);
          res.writeHead(200, { "Content-Type": mime });
          res.end(data);
          break;
        }

        case pathname === "/api/doc" && req.method === "GET": {
          const docPath = url.searchParams.get("path");
          if (!docPath || !existsSync(docPath)) {
            res.writeHead(404); res.end("Not found"); break;
          }
          const content = readFileSync(docPath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(content);
          break;
        }

        case pathname === "/api/draft": {
          sendJson(res, 200, {});
          break;
        }

        case pathname === "/favicon.svg": {
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">M</text></svg>`;
          res.writeHead(200, { "Content-Type": "image/svg+xml" });
          res.end(svg);
          break;
        }

        default: {
          if (pathname.startsWith("/api/")) {
            sendJson(res, 404, { error: "Not found" });
            break;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(injectedHtml);
          break;
        }
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(err instanceof Error ? err.message : String(err));
      }
    }
  });

  // Bind on random port
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  resetIdleTimer();
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    waitForDecision: () => decisionPromise,
    stop: () => {
      server.close();
      decisionResolve?.({ feedback: "", annotations: [], exit: true });
    },
  };
}
