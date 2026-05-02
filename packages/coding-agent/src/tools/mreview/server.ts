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

import { createProvider, ProviderRegistry } from "./ai/provider";
import { SessionManager } from "./ai/session-manager";
import { createAIEndpoints } from "./ai/endpoints";
import type { PiSDKConfig } from "./ai/types";
import "./ai/pi-sdk-node"; // registers "pi-sdk" factory

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
  piExecutablePath: string;
  cwd: string;
}

function markdownToUnifiedDiff(markdown: string, filePath: string): string {
  const lines = markdown.split("\n");
  const header = `--- /dev/null\n+++ b/${basename(filePath)}\n@@ -0,0 +1,${lines.length} @@`;
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
  // Set up AI layer
  let registry: ProviderRegistry | null = null;
  let sessionManager: SessionManager | null = null;
  let aiHandlers: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {};

  try {
    registry = new ProviderRegistry();
    const provider = await createProvider({
      type: "pi-sdk",
      piExecutablePath: options.piExecutablePath,
      cwd: options.cwd,
    } as PiSDKConfig);
    registry.register(provider, "pi-sdk");
    sessionManager = new SessionManager();
    aiHandlers = createAIEndpoints({
      registry,
      sessionManager,
      getCwd: () => options.cwd,
    });
  } catch {
    // AI unavailable — endpoints will return 503
    registry = null;
    sessionManager = null;
    aiHandlers = {};
  }

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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
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
      // AI endpoints
      if (pathname in aiHandlers) {
        await aiHandlers[pathname](req, res);
        return;
      }

      // Fallback AI capabilities when AI layer failed to init
      if (pathname === "/api/ai/capabilities" && Object.keys(aiHandlers).length === 0) {
        sendJson(res, 200, { available: false, providers: [], defaultProvider: null });
        return;
      }

      switch (true) {
        case pathname === "/api/diff" && req.method === "GET": {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
          res.end(diffResponse);
          break;
        }

        case pathname === "/api/capabilities" && req.method === "GET": {
          sendJson(res, 200, { canStageFiles: false, canSwitchDiffType: false, canSwitchBase: false });
          break;
        }

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
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(options.htmlContent);
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

  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    waitForDecision: () => decisionPromise,
    stop: () => {
      server.close();
      sessionManager?.disposeAll();
    },
  };
}
