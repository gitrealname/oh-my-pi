/**
 * mreview — Markdown Review & AI Discussion for omp
 *
 * Built on Plannotator by backnotprop (https://github.com/backnotprop/plannotator).
 * Licensed MIT / Apache-2.0 (dual license, at your option).
 *
 * What we borrow from Plannotator:
 *   - The review editor UI (packages/review-editor → review-editor.html):
 *     the complete browser SPA including the DiffViewer, AI chat sidebar (AITab),
 *     annotation tools, Send Feedback / Approve / Exit flow, and all styling.
 *   - The AI provider layer (packages/ai/): the provider-agnostic AI backbone
 *     including PiSDKNodeProvider, SessionManager, ProviderRegistry, endpoint
 *     handlers, and the annotate-mode context/system-prompt builder.
 *   - The Fetch→Node.js adapter pattern from apps/pi-extension/server/: the
 *     toWebRequest() helper and Response-piping approach that makes the
 *     Fetch-API-based AI endpoints work with node:http.
 *   - The two-pass markdown diff engine (packages/ui/utils/planDiffEngine.ts)
 *     is present in the bundled HTML asset and drives annotation rendering.
 *
 * Key differences from Plannotator's own use:
 *   - Scope: Plannotator is designed for plan/code review in agent plan-mode.
 *     mreview operates on ANY markdown file at ANY point in an omp session —
 *     architecture docs, research notes, specs, changelogs, anything.
 *   - Integration depth: mreview is a first-class built-in omp slash command,
 *     not a plugin. Settings live in omp's settings schema. The AI subprocess
 *     is the same omp binary the user is already running.
 *   - Conversation model: the AI sidebar is primed with the full document
 *     content and any annotations, enabling back-and-forth discussion about
 *     the artifact itself — not gated to plan approval/rejection cycles.
 *   - No sharing, no paste service, no plannotator.ai cloud dependencies.
 *     Entirely local.
 */
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createSidecar, sidecarPath } from "../../utils/m-utils";

// mreview-ui.html is embedded at compile time via Bun's asset import.
// HTMLBundle is Bun's type for *.html imports; with { type: "text" } returns
// the raw string at runtime despite the type mismatch.
import mreviewUiHtmlAsset from "./mreview-ui.html" with { type: "text" };
const EMBEDDED_HTML = mreviewUiHtmlAsset as unknown as string;

import { startMReviewServer } from "./server";

export type { MReviewDecision } from "./server";

const resolveHtmlContent = createSidecar(sidecarPath("mreview-editor.ui.html"), EMBEDDED_HTML);

/** Always true — HTML is embedded in the binary. */
export function hasMReviewHtml(): boolean {
	return true;
}

/**
 * Detect the omp binary path for spawning AI subprocesses.
 * Resolution order:
 *   1. Explicit setting value (if non-empty)
 *   2. process.argv[0] if it looks like an omp binary (.exe or absolute path)
 *   3. %LOCALAPPDATA%\omp\omp.exe (Windows)
 *   4. "omp" (PATH fallback)
 */
export function detectOmpBinary(ompExecutable?: string): string {
  if (ompExecutable?.trim()) return ompExecutable.trim();
  const arg0 = process.argv[0];
  if (arg0 && (arg0.endsWith(".exe") || /^[A-Za-z]:[\\/]/.test(arg0))) return arg0;
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData) {
    const candidate = resolvePath(localAppData, "omp", "omp.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "omp";
}

export interface MReviewConfig {
  /** Custom browser path for opening the UI (platform-specific). Blank = system default. */
  browserPath?: string;
  /** Agent instance from the main omp session for direct AI routing. */
  agent?: any;
}

export interface MReviewCtx {
  cwd: string;
  openInBrowser(url: string): void;
  showStatus(msg: string): void;
  showWarning(msg: string): void;
}

/**
 * Open a markdown file in the browser-based mreview UI and wait for user feedback.
 * Returns the decision when the user hits Send Feedback, Approve, or Exit.
 */
export async function openMReviewSession(
  ctx: MReviewCtx,
  filePath: string,
  markdown: string,
  config: MReviewConfig = {},
  signal?: AbortSignal,
): Promise<import("./server").MReviewDecision> {
  const server = await startMReviewServer({
    markdown,
    filePath,
    htmlContent: resolveHtmlContent(),
    cwd: ctx.cwd,
    agent: config.agent,
  });

  // Stop server immediately if the tool is aborted
  signal?.addEventListener("abort", () => server.stop(), { once: true });

  ctx.openInBrowser(server.url);
  ctx.showStatus(`mreview: opened ${server.url} - waiting for feedback (close browser tab or hit Exit to cancel)...`);

  const decision = await server.waitForDecision();

  // Give browser time to receive the response before stopping the server
  await new Promise(r => setTimeout(r, 1500));
  server.stop();

  return decision;
}
