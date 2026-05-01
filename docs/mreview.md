# mreview — Markdown Discussion/Review Slash Command for omp

## Key Implementation Insight: Fetch-API Adapter Pattern

The plannotator Pi extension Node.js review server already solves the Bun→Node.js adaptation:
- `packages/ai/endpoints.ts` handlers accept Fetch `Request`, return Fetch `Response`
- `apps/pi-extension/server/helpers.ts` has `toWebRequest(IncomingMessage): Request` (~20 lines)
- Node server pipes Response body back via `Readable.fromWeb(webRes.body).pipe(res)`

We copy `toWebRequest` verbatim. No custom adapter module needed — inline it in `server.ts`.

## Goal

Add `/mreview <file.md>` as a built-in slash command to oh-my-pi (`aws-corp` branch).

Opens any markdown file in a **browser UI with two panels side-by-side**:
- **Left**: rendered markdown with inline annotation tools (highlight, comment, delete/insert/replace blocks)
- **Right sidebar**: AI chat panel — back-and-forth conversation with the LLM, primed with the file content and any annotations made

The user can:
1. Annotate the markdown visually in the browser
2. Chat with the LLM about the file without leaving the browser
3. Hit **Send Feedback** → structured feedback + conversation injected back into omp terminal
4. Repeat as many times as needed (omp terminal ↔ browser loop)

This is NOT restricted to plan-mode or any particular omp mode. Any `.md` file, any time.

---

## IMPORTANT: Build HTML Assets First

The plannotator HTML assets are NOT committed to the repo — they are build artifacts.
**Before copying HTML files, the executor MUST build them:**

```bash
# In D:/.ai/research/omp/.plannotator
bun install
bun run build:pi
```

`build:pi` = `build:review` + `build:hook` + `apps/pi-extension build`

This produces:
- `apps/hook/dist/index.html` → copied to `apps/pi-extension/plannotator.html` (plan editor SPA)
- `apps/hook/dist/review.html` → copied to `apps/pi-extension/review-editor.html` (review editor SPA with AI sidebar)

We need **`review-editor.html`** for the AI chat sidebar.

---

## Architecture

### What we borrow from plannotator

**HTML asset**:
- `apps/pi-extension/review-editor.html` — the review editor SPA. Has: diff viewer (we serve an empty diff), AI chat sidebar (`ReviewSidebar` with `AITab`), annotation tools, `Send Feedback` / `Approve` / `Exit` buttons.
- The review editor fetches `/api/diff` for content. We return the markdown as fake "new file" content with empty old content, producing a rendered view.

**AI layer** (`packages/ai/`):
- `providers/pi-sdk-node.ts`: `PiSDKNodeProvider` — spawns `pi --mode rpc` via `node:child_process.spawn`. This is fully Node.js compatible (no Bun). Each AI session spawns a fresh pi subprocess, sends the system prompt (file content + annotations), then streams query responses as SSE.
- `endpoints.ts`: `createAIEndpoints(deps)` — pure handler factory. Returns route handlers for `/api/ai/capabilities`, `/api/ai/session`, `/api/ai/query` (SSE), `/api/ai/abort`, `/api/ai/permission`, `/api/ai/sessions`. Works with `node:http` via adapted wiring (see below).
- `context.ts`: `buildSystemPrompt()` for `annotate` context mode — primes LLM with file path + content + user annotations.
- `session-manager.ts`: `SessionManager` — tracks active AI sessions.

**IMPORTANT**: plannotator's `packages/ai/endpoints.ts` uses `Bun.serve` `Request`/`Response` objects. We need `node:http`. We adapt by wrapping the route handlers: convert `node:http` req/res to fetch-style Request/Response, call the handler, write the Response back. This is ~40 lines of adapter code.

**Node.js review server reference**:
- `apps/pi-extension/server/serverReview.ts` — the Pi extension's own Node.js review server. This is our primary reference for how to wire the review editor with `node:http` instead of `Bun.serve`.

### AI session lifecycle in the browser

1. Browser loads `review-editor.html`, fetches `/api/ai/capabilities` → returns `{ available: true, providers: [...] }`
2. User opens AI sidebar, types a question → browser POSTs `/api/ai/session` with `{ context: { mode: "annotate", annotate: { content: <markdown>, filePath: <path> } } }` → server creates a `PiSDKNodeSession`, spawns `pi --mode rpc`, injects system prompt
3. Browser POSTs `/api/ai/query` with `{ sessionId, prompt }` → server streams SSE back
4. Conversation continues; on each query the browser may send `contextUpdate` with new annotations
5. When user hits Send Feedback → `POST /api/feedback` → server resolves the decision promise → omp receives feedback

### How `/api/diff` returns markdown

The review editor expects:
```json
GET /api/diff → { rawPatch, gitRef, origin, diffType, base, hideWhitespace, gitContext }
```

We return a synthetic unified diff that shows the entire markdown file as "new" (added lines), with `diffType: "markdown"` or a suitable label. The review editor renders this as an "added file" diff — all lines shown in green. This gives a readable view of the markdown while still being compatible with the existing annotation infrastructure.

Alternative: return `rawPatch: ""` and `error: undefined` — the review editor may show an empty state. Check `serverReview.ts` for how it handles empty diffs.

**Actually better**: check what the review editor does when `rawPatch` is empty vs content. Given the `annotate` mode context, we should use the **annotate server** (`plannotator.html`) for the markdown view, and add AI endpoints to it. The `plannotator.html` (plan editor) renders markdown natively and cleanly. The `review-editor.html` shows git diffs.

**REVISED ARCHITECTURE DECISION**: Use `plannotator.html` (plan editor) for the markdown view + add the AI endpoints (`/api/ai/*`) to the annotate server. The plan editor currently has no AI tab, but the `packages/ai/endpoints.ts` endpoints are designed to be added to ANY server — they're side-channel to the annotation flow.

Wait — confirmed: the plan editor (`packages/editor/App.tsx`) does NOT render an AI sidebar. No `useAIChat` hook, no `AITab` component. Adding AI endpoints to the annotate server would serve the endpoints but the UI wouldn't display them.

**FINAL ARCHITECTURE**: Use `review-editor.html` with a synthetic markdown diff. The review editor has the AI sidebar natively. The diff view will show the markdown as a new-file addition. This is the only path that provides both annotation + AI chat in a single HTML without modifying the plannotator source.

To make `rawPatch` readable as markdown: generate a standard unified diff header + `+` prefix on every line:

```
--- /dev/null
+++ b/<filename>
@@ -0,0 +1,N @@
+line 1
+line 2
...
```

The review editor renders this as a standard "new file" diff. All lines selectable for annotation. AI sidebar available on the right. This works.

---

## Files to Create/Modify

### New files (in `packages/coding-agent/src/tools/mreview/`)

**1. `review-editor.html`** *(copied from plannotator build output)*
- Source: `D:/.ai/research/omp/.plannotator/apps/pi-extension/review-editor.html` (after `bun run build:pi`)
- Self-contained SPA, ~1-3 MB

**2. `ai-adapter.ts`** — Adapts plannotator's `@plannotator/ai` endpoints (which use Fetch API `Request`/`Response`) to work with `node:http` `IncomingMessage`/`ServerResponse`.

```ts
// Minimal adapter: reads node:http req body → builds fetch Request → calls handler → writes fetch Response to node:http res
export async function handleWithFetchHandler(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (req: Request) => Promise<Response>
): Promise<void>
```

**3. `server.ts`** — Self-contained `node:http` mreview server.

Exports:
```ts
startMReviewServer(options: {
  markdown: string;
  filePath: string;
  htmlContent: string;
  piExecutablePath?: string;   // defaults to "omp" or the binary that launched us
  cwd: string;
}) → Promise<{ url: string; waitForDecision(): Promise<MReviewDecision>; stop(): void }>

type MReviewDecision = {
  feedback: string;
  annotations: unknown[];
  exit?: boolean;
  approved?: boolean;
}
```

Routes implemented (all in `node:http`):
```
GET  /api/diff              → synthetic unified diff of the markdown file
GET  /api/capabilities      → { canStageFiles: false }  (disables stage button)
GET  /api/ai/capabilities   → { available: true, providers: [...] }
POST /api/ai/session        → create PiSDKNodeSession
POST /api/ai/query          → SSE stream
POST /api/ai/abort          → abort session
GET  /api/ai/sessions       → list sessions
POST /api/feedback          → resolve decision({ feedback, annotations })
POST /api/approve           → resolve decision({ approved: true })
POST /api/exit              → resolve decision({ exit: true })
GET  /api/image             → serve local image by path param
GET  /api/doc               → serve linked .md file by path param
GET  /api/draft, POST, DELETE → in-memory no-op (200 OK)
GET  /favicon.svg           → minimal inline SVG
*                           → serve review-editor.html
```

AI wiring:
```ts
import "@plannotator/ai/providers/pi-sdk-node";  // registers factory
import { ProviderRegistry, createProvider, SessionManager, createAIEndpoints } from "@plannotator/ai";
```

Wait — `@plannotator/ai` is NOT installed in omp. We cannot import it.

**REVISED: vendor the AI layer**. We copy (or inline) only what we need from `packages/ai/`:
- `types.ts` — AI types
- `base-session.ts` — BaseSession
- `session-manager.ts` — SessionManager
- `provider.ts` — ProviderRegistry, createProvider
- `context.ts` — buildSystemPrompt, buildEffectivePrompt
- `endpoints.ts` — createAIEndpoints (adapted for node:http)
- `providers/pi-events.ts` — mapPiEvent
- `providers/pi-sdk-node.ts` — PiSDKNodeProvider, PiSDKNodeSession

These files have NO external dependencies beyond `node:child_process`, `node:crypto` (for session IDs), and each other. They are self-contained TypeScript that we copy into `src/tools/mreview/ai/`.

Total: ~8 files, ~600 lines of vendored code.

**4. `index.ts`** — Orchestration module.

```ts
export function hasMReviewHtml(): boolean
export async function openMReviewSession(
  ctx: { openInBrowser(url: string): void; cwd: string; notify(msg: string, type?: string): void },
  filePath: string,
  markdown: string,
): Promise<MReviewDecision>
```

### Modified files

**5. `packages/coding-agent/src/slash-commands/builtin-registry.ts`**

Add to `BUILTIN_SLASH_COMMAND_REGISTRY`:
```ts
{
  name: "mreview",
  description: "Open a markdown file in the browser review UI with AI chat",
  inlineHint: "<file.md>",
  allowArgs: true,
  handle: async (command, runtime) => {
    const args = command.args.trim();
    if (!args) {
      runtime.ctx.showStatus("Usage: /mreview <file.md>");
      runtime.ctx.editor.setText("");
      return;
    }
    if (!hasMReviewHtml()) {
      runtime.ctx.showWarning("mreview: review-editor.html asset missing. Run bun run build:pi in .plannotator.");
      runtime.ctx.editor.setText("");
      return;
    }
    // Resolve path relative to cwd
    const filePath = resolve(runtime.ctx.session.cwd ?? process.cwd(), args);
    let markdown: string;
    try {
      markdown = readFileSync(filePath, "utf-8");
    } catch {
      runtime.ctx.showWarning(`mreview: cannot read file: ${args}`);
      runtime.ctx.editor.setText("");
      return;
    }
    const result = await openMReviewSession(runtime.ctx, filePath, markdown);
    if (result.exit) {
      runtime.ctx.showStatus("mreview closed.");
    } else if (result.approved) {
      runtime.ctx.showStatus("Approved.");
    } else if (result.feedback?.trim()) {
      runtime.ctx.editor.setText(result.feedback);
    }
    runtime.ctx.editor.setText(runtime.ctx.editor.getText?.() ?? "");  // trigger re-render
  }
}
```

---

## AI vendoring — file mapping

Files to copy from `research/omp/.plannotator/packages/ai/` into `src/tools/mreview/ai/`:

| Source | Destination | Notes |
|--------|-------------|-------|
| `types.ts` | `ai/types.ts` | No changes |
| `base-session.ts` | `ai/base-session.ts` | No changes |
| `session-manager.ts` | `ai/session-manager.ts` | No changes |
| `provider.ts` | `ai/provider.ts` | No changes |
| `context.ts` | `ai/context.ts` | No changes |
| `providers/pi-events.ts` | `ai/pi-events.ts` | No changes |
| `providers/pi-sdk-node.ts` | `ai/pi-sdk-node.ts` | Fix import paths |
| `endpoints.ts` | `ai/endpoints.ts` | **Adapt**: change from Fetch `Request`/`Response` to node:http |

**Adapting `endpoints.ts`**: The plannotator AI endpoints return `Response.json(...)` and SSE `Response` objects (Fetch API). We need to rewrite the `createAIEndpoints` function to accept and return `node:http` compatible handlers instead. This is ~60 lines of adaptation.

**pi executable path**: `PiSDKNodeProvider.createSession()` needs `piExecutablePath`. In omp, the binary is `omp-aws-corp.exe` (local) or whatever `process.argv[0]` is. We detect it: `process.execPath` gives the running Node binary, but we want the omp binary. Pass it from the slash command handler via `process.argv[0]` or a resolved path from settings.

Actually simpler: the `PiSDKNodeSession` spawns `pi --mode rpc` in RPC mode. In omp, the equivalent is spawning itself: `process.execPath --mode rpc` or the omp binary path. Let omp resolve the correct executable: check `settings.get("piExecutablePath")` or fall back to a well-known path (e.g. `%LOCALAPPDATA%\omp\omp.exe`). The binary path is needed to spawn a fresh session.

**Alternative AI approach** — avoid spawning a subprocess entirely: route AI queries through omp's existing agent session using the event bus (`session.settings.eventBus`). This would be cleaner but requires deeper omp integration. **Reject for now** — too coupled. Use subprocess spawn as plannotator does.

---

## Synthetic diff format

```ts
function markdownToUnifiedDiff(markdown: string, filePath: string): string {
  const lines = markdown.split("\n");
  const header = [
    `--- /dev/null`,
    `+++ b/${basename(filePath)}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ].join("\n");
  const body = lines.map(l => `+${l}`).join("\n");
  return `${header}\n${body}\n`;
}
```

Return from `/api/diff`:
```json
{
  "rawPatch": "<unified diff>",
  "gitRef": "<filename>",
  "origin": "omp",
  "diffType": "uncommitted",
  "base": "HEAD",
  "hideWhitespace": false,
  "gitContext": { "branch": "", "availableDiffTypes": [], "availableBases": [] }
}
```

---

## Handling `omp` executable path for AI subprocess

The PiSDKNodeProvider needs to spawn `omp --mode rpc`. Resolve in order:
1. `process.env.OMP_EXECUTABLE` (if set)
2. `process.execPath` (the Node.js binary — wrong for Bun/omp bundle)
3. `process.argv[0]` (the actual omp binary path when running as a bundle)
4. Fallback: `%LOCALAPPDATA%\omp\omp.exe` on Windows

Use option 3 as primary on Windows: `process.argv[0]` when it ends in `.exe` is the omp binary.

Pass to `startMReviewServer` as `piExecutablePath: detectOmpBinary()`.

Expose `detectOmpBinary()` as a helper in `index.ts`.

---

## File paths (absolute, for executor)

### Create
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/review-editor.html` *(copy from plannotator build)*
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/ai/types.ts`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/ai/base-session.ts`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/ai/session-manager.ts`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/ai/provider.ts`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/ai/context.ts`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/ai/pi-events.ts`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/ai/pi-sdk-node.ts`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/ai/endpoints.ts` *(adapted for node:http)*
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/server.ts`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/index.ts`

### Modify
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/slash-commands/builtin-registry.ts` *(add /mreview, /review, /discuss entries)*
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/config/settings-schema.ts` *(add 5 mreview.* settings)*
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/prompt-engine/prompt-loader.ts` *(add "review", "discuss", "mreview" to RESERVED_NAMES)*

---

## Pre-flight checks for executor

1. **Build plannotator**: `cd D:/.ai/research/omp/.plannotator && bun install && bun run build:pi` — verify `apps/pi-extension/review-editor.html` exists
2. **Copy HTML**: copy `review-editor.html` to omp `src/tools/mreview/review-editor.html`
3. **Copy AI files**: copy the 7 AI source files from `packages/ai/` to `src/tools/mreview/ai/` — fix relative import paths within the ai/ subdir
4. **Adapt `endpoints.ts`**: rewrite from Fetch API to `node:http` handlers — this is the main adaptation work
5. **Write `server.ts`**: wire all routes using `node:http createServer()`, reference the `ai/` subdir
6. **Write `index.ts`**: exports `hasMReviewHtml()` + `openMReviewSession()`
7. **Edit `builtin-registry.ts`**: add `/mreview` entry
8. **Typecheck**: `bun run typecheck` in `packages/coding-agent` — must pass
9. **Smoke test**: start omp, run `/mreview docs/omp-setup/build.md`

---

## Edge cases

- **HTML asset missing**: `hasMReviewHtml()` returns false → warn + early return
- **File not found**: try/catch `readFileSync`, show warning
- **omp binary not found**: `detectOmpBinary()` returns best guess; if PI subprocess fails to start, AI sidebar shows "AI unavailable" (endpoint returns `available: false`)
- **Port 0**: OS assigns random port, no collisions
- **Large file**: synthetic diff may be large but the SPA handles it client-side
- **Windows paths in diff**: use `basename()` for the diff header, `filePath` for API response
- **Multiple concurrent mreview**: independent servers on distinct ports, no shared state
- **Feedback loop**: after `/api/feedback` resolves, server stays up for 1500ms then stops — browser shows "session ended" if user tries to interact after

---

## Risks

- **`review-editor.html` expects git diff features**: The SPA has buttons for staging files, switching diff types, etc. Most will no-op (our server returns 404 or stub responses). The AI sidebar and annotation/feedback flow still work. Worst case: some UI elements appear but do nothing.
- **`Bun.sleep` in vendored ai code**: `packages/ai/` files use standard `await new Promise(r => setTimeout(r, ms))` or similar — no Bun-specific APIs found. Safe to vendor.
- **`import.meta.url` in vendored files**: If any vendored file uses `import.meta.url`, it resolves to omp's source path correctly since we're compiling with tsc/bun. No issue.
- **API endpoint shape mismatch**: The review editor SPA may call endpoints we haven't implemented (agent jobs, PR endpoints, etc.). These return 404. The SPA should degrade gracefully — needs smoke-test verification.


---

## Browser Path Configuration

### Requirement
The user needs to specify which browser to launch for the mreview UI (e.g. a specific Chrome profile, a non-default browser).

### Design
Add `"mreview.browser"` to `SETTINGS_SCHEMA` — a string, `default: undefined`, UI tab: `"tools"`.

```
"mreview.browser": {
  type: "string",
  default: undefined,
  ui: {
    tab: "tools",
    label: "mreview: Browser path",
    description: "Executable path (or app name on macOS) to open the mreview UI in. Leave blank to use the system default browser."
  }
};
```

### Implementation in `index.ts`

Replace the bare `ctx.openInBrowser(url)` call with `openMReviewInBrowser(url, browserPath)`:

```ts
function openMReviewInBrowser(url: string, browserPath: string | undefined): void {
  if (!browserPath) {
    // Fall back to omp's built-in openPath (platform default)
    openPath(url);
    return;
  }
  // Custom browser path: use same pattern as plannotator's PLANNOTATOR_BROWSER
  try {
    if (process.platform === "win32") {
      // cmd.exe /c start "" "<browser>" <url>
      Bun.spawn(["cmd.exe", "/c", "start", "", browserPath, url], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore"
      });
    } else if (process.platform === "darwin") {
      // app name or path
      if (browserPath.includes("/") && !browserPath.endsWith(".app")) {
        Bun.spawn([browserPath, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      } else {
        Bun.spawn(["open", "-a", browserPath, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      }
    } else {
      Bun.spawn([browserPath, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // Best-effort: fall back to default
    openPath(url);
  }
}
```

Import `openPath` from `../../utils/open` in `index.ts`.

### Slash command handler change

Pass `settings.get("mreview.browser" as SettingPath) as string | undefined` to `openMReviewSession`:

```ts
const browserPath = runtime.ctx.settings.get("mreview.browser" as SettingPath) as string | undefined;
const result = await openMReviewSession(
  { openInBrowser: (url) => openMReviewInBrowser(url, browserPath), cwd: ..., notify: ... },
  filePath,
  markdown,
);
```

### Modified files (additions)
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/config/settings-schema.ts` — add `mreview.enabled`, `mreview.browser`, `mreview.ompExecutable`, `mreview.aiModel`, `mreview.aiMaxTurns`
- `D:/.ai/research/omp/.oh-my-pi/packages/coding-agent/src/tools/mreview/index.ts` — add `openMReviewInBrowser()`, `detectOmpBinary()`, `openMReviewSession()` with config param

---

## Settings Audit — All Configurable Parameters

Systematic review of every tunable value across the full stack. Each item is assessed for whether it warrants a `SETTINGS_SCHEMA` entry.

### Include in `SETTINGS_SCHEMA`

| Setting key | Type | Default | Rationale |
|----|----|----|-----|
| `mreview.enabled` | `boolean` | `true` | Consistent with every other tool/command — allows disabling via Settings UI |
| `mreview.browser` | `string` | `undefined` | Already planned. Custom browser executable/app name |
| `mreview.ompExecutable` | `string` | `undefined` | Path to the omp binary used to spawn the AI subprocess. Required when `process.argv[0]` is not the omp binary (e.g. running via `bun run` in dev). Fallback chain: setting → `process.argv[0]` → `%LOCALAPPDATA%\omp\omp.exe` |
| `mreview.aiModel` | `string` | `undefined` | Model override passed to `CreateSessionOptions.model`. Lets user pin a specific model (e.g. `"anthropic/claude-opus-4-5"`) for mreview AI chat instead of the provider default |
| `mreview.aiMaxTurns` | `number` | `10` | `CreateSessionOptions.maxTurns` — bounds agentic turns in the AI chat sidebar to control cost. 10 is a reasonable default |

### Explicitly excluded (with reason)

| Parameter | Reason excluded |
|----|-----|
| `mreview.port` | Fixed port would cause conflicts on concurrent mreview calls; random port (OS-assigned) is strictly better here. Unlike plannotator remote mode, we have no SSH tunnel scenario |
| `mreview.aiMaxBudgetUsd` | Redundant with `mreview.aiMaxTurns` for omp use; adds settings UI noise. Can add later if needed |
| `mreview.aiReasoningEffort` | Codex-only. Not applicable since we use the omp/pi provider |
| `mreview.sharingEnabled` | We disable sharing entirely (no plannotator paste service). Not configurable |
| `mreview.remoteMode` | No SSH/remote scenario in omp's current context. Can add later |

### Settings schema additions (final)

```ts
"mreview.enabled": {
  type: "boolean",
  default: true,
  ui: { tab: "tools", label: "MReview", description: "Enable the /mreview command for browser-based markdown review with AI chat" },
},

"mreview.browser": {
  type: "string",
  default: undefined,
  ui: {
    tab: "tools",
    label: "MReview: Browser path",
    description: "Executable path (or app name on macOS) for the browser used to open the mreview UI. Leave blank for system default.",
    submenu: true,
  },
},

"mreview.ompExecutable": {
  type: "string",
  default: undefined,
  ui: {
    tab: "tools",
    label: "MReview: omp executable path",
    description: "Path to the omp binary spawned for AI chat sessions in mreview. Auto-detected if blank.",
    submenu: true,
  },
},

"mreview.aiModel": {
  type: "string",
  default: undefined,
  ui: {
    tab: "tools",
    label: "MReview: AI model",
    description: "Model string for the mreview AI chat sidebar (e.g. anthropic/claude-opus-4-5). Blank = provider default.",
    submenu: true,
  },
},

"mreview.aiMaxTurns": {
  type: "number",
  default: 10,
  ui: {
    tab: "tools",
    label: "MReview: AI max turns",
    description: "Maximum agentic turns per AI chat session in mreview (limits cost). Default: 10.",
    submenu: true,
  },
},
```

### Impact on `detectOmpBinary()` in `index.ts`

Revised resolution order (reads from settings first):
1. `settings.get("mreview.ompExecutable")` (if non-empty string)
2. `process.argv[0]` (if ends in `.exe` or is an absolute path to a binary)
3. `%LOCALAPPDATA%\omp\omp.exe` on Windows
4. `"omp"` (PATH lookup fallback)

The slash command handler reads `settings` and passes the resolved values to `openMReviewSession(ctx, filePath, markdown, { browserPath, ompExecutable, aiModel, aiMaxTurns })`.

### Updated `openMReviewSession` signature

```ts
export async function openMReviewSession(
  ctx: { openInBrowser(url: string): void; cwd: string; ui: { notify(msg: string, type?: string): void } },
  filePath: string,
  markdown: string,
  config: {
    browserPath?: string;
    ompExecutable?: string;
    aiModel?: string;
    aiMaxTurns?: number;
  } = {},
): Promise<MReviewDecision>
```

---

## Plannotator Diff Engine — What We Borrow

The plannotator diff engine (`packages/ui/utils/planDiffEngine.ts`) is a substantial piece of engineering. We borrow it wholesale via the built HTML asset. Understanding it is required to correctly generate synthetic diffs.

### Two-pass hierarchical algorithm

**Outer pass — block-level** (`diffLines` from the `diff` npm package):
- Pre-pass: collapses every fenced code block to a single-line sentinel so `diffLines` treats the whole block atomically (prevents the `}` / blank-line fragmentation problem)
- Runs `diffLines(old, new)` on sentinel-substituted text
- Groups consecutive `remove+add` pairs into `modified` blocks (rather than showing discrete deletions then additions)

**Inner pass — word-level** (`diffWordsWithSpace` from `diff`):
- Applied only to `modified` blocks that pass the qualification gate (single-block prose: paragraph, heading, list-item)
- Four sentinel substitution passes before word-diffing, in order: inline code spans → markdown links → balanced emphasis pairs → infix hyphens — each preventing `diffWordsWithSpace`'s word-boundary tokenizer from fragmenting those constructs mid-diff
- Post-word-diff coalescing pass: adjacent change sites separated only by "thin" unchanged tokens (whitespace + punctuation) are merged into phrase-level swaps, eliminating noisy alternating red/green word fragments

### Our usage of this engine
We generate a **synthetic unified diff** (git patch format) from the markdown file and feed it to the review editor as `rawPatch`. The review editor's `DiffViewer` component renders it using its own diff parsing, NOT `planDiffEngine.ts` directly. `planDiffEngine.ts` is used only for plan-version-history diffs (the PlanDiff badge/viewer). For our mreview use case, the synthetic unified diff is sufficient — the review editor shows the file as a clean new-file addition, all lines selectable for annotation.

The AI chat is primed with the raw markdown content (not the diff), via `buildSystemPrompt()` with `mode: "annotate"` context.

---

## Attribution — Required Credit Block

A credit block must appear in the mreview source files. It MUST be generous, specific, and accurate.

### Location
Place in two locations:
1. **`src/tools/mreview/index.ts`** — top-of-file JSDoc block
2. **`src/tools/mreview/ai/` directory** — a `ATTRIBUTION.md` file alongside the vendored code

### Content (verbatim, use this text)

```
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
```

### `ai/ATTRIBUTION.md` content

```markdown
# Attribution

The files in this directory are vendored from Plannotator by backnotprop.

- Source: https://github.com/backnotprop/plannotator
- License: MIT / Apache-2.0 (dual license)
- Copyright (c) 2025 backnotprop

Files copied from `packages/ai/` with minimal modifications (import path fixes only):
- `types.ts`, `base-session.ts`, `session-manager.ts`, `provider.ts`, `context.ts`
- `pi-events.ts` (from `providers/pi-events.ts`)
- `pi-sdk-node.ts` (from `providers/pi-sdk-node.ts`)
- `endpoints.ts` (from `endpoints.ts`, adapted from Fetch API to node:http)

Plannotator's design of a provider-agnostic AI backbone with SSE streaming,
session management, and system-prompt-based context injection is the direct
foundation for mreview's AI chat feature.
```

---

## Interface Surface Decision: `/mreview` vs Skill vs Prompt Template

### The three surfaces in omp

**1. Builtin slash command (`/mreview`)** — human-only, zero agent context pollution
- Lives in `BUILTIN_SLASH_COMMAND_REGISTRY`, invoked by the human typing `/mreview <file>`
- The agent NEVER sees the command or its description — it is not injected anywhere
- Zero token cost when not in use
- Cannot be invoked BY the agent

**2. Skill (`SKILL.md` file in `~/.omp/agent/skills/` or `.omp/skills/`)** — agent-context content
- A `SKILL.md` file whose body is injected into the agent's system prompt (or sent as a message on activation via a prompt template's `skill:` field)
- Loaded at session start and remains in context the whole session → **always pollutes context**
- The agent can be given instructions about how to use mreview, but the injection cost is permanent

**3. Prompt template (`.md` file in `~/.omp/agent/commands/` or `.omp/commands/`)** — lazy-load via `/dot-command`
- A `.md` file with optional frontmatter (`role:`, `model:`, `skill:`, `thinking:`, `restore: true`)
- Registers as a `/command-name` slash command at session start
- **Key property**: the prompt content is NOT in context until the user types the command
- When invoked, `pi.sendUserMessage(content)` sends the rendered template as a user message → triggers an agent turn
- The `skill:` field can inject a SKILL.md as a side-message when the command is typed
- This is the `.\ ` prefix convention the user refers to: files in `.omp/commands/` produce slash commands

### Analysis

The user's question is about **context pollution when not employed**. The answer:

| Surface | Context cost when idle | Agent can call it | Human-only |
|---------|----------------------|------------------|------------|
| Builtin `/mreview` | **Zero** — not in context at all | No | Yes |
| Skill (always-on) | Full SKILL.md in every prompt | N/A | N/A |
| Prompt template `.md` | Zero (template not injected until invoked) | No | Yes |

Both builtin slash command and prompt template have **zero idle cost**. The difference:
- **Builtin**: hardcoded in omp source, no file required
- **Prompt template**: a `.md` file the user can customize (swap model, add skill, change thinking level, modify the prompt)

### Decision: Builtin slash command PLUS an optional companion prompt template

**Primary interface: `/mreview <file>`** (builtin slash command, as planned)
- Zero context pollution
- Direct, instant — no agent turn required
- Opens browser immediately

**Optional companion: a prompt template for agent-initiated review**
- A prompt template file can be dropped into `.omp/commands/mreview.md` (or shipped with omp)
- Template content: `Please review the file at $1 — I'll run /mreview to open it in the browser`
- This gives the agent a way to SUGGEST a review and have it sent as a user message
- Still zero idle cost (template body not injected until invoked)
- The `skill:` frontmatter field can attach mreview usage instructions as context only when invoked

**The `.` prefix convention** the user mentions: prompt template files live in `.omp/commands/` and produce slash commands. The 'dot' refers to the `.omp` directory, not a command prefix. There is no dedicated `.command` syntax separate from `/command` — all prompt templates register as `/name` commands.

### Revised plan: keep builtin `/mreview` as primary, note the optional template pattern

No change to implementation. The builtin slash command IS the zero-pollution interface.
The prompt template companion is out of scope for this implementation — document it as a follow-on.

### Note on agent-initiated mreview

The ONLY way the agent can trigger a mreview session is if:
1. The human has a prompt template that sends `Let's review X` as a user message, which then the human confirms by typing `/mreview X`
2. Or we add an LLM-callable tool (`BUILTIN_TOOLS` entry) — which DOES pollute context with its schema

Option 2 is explicitly out of scope (the user confirmed mreview is human-initiated). Option 1 is the prompt template companion pattern above.

**Summary**: `/mreview` builtin slash command = zero context pollution = correct choice.

---

## `@mention` Intent Detection — Natural Language Trigger

### How `@filepath` works in omp (confirmed from source)

- `utils/file-mentions.ts`: `extractFileMentions(text)` runs regex `/@([^\s@]+)/g` on every user message before the agent turn
- `agent-session.ts` line 2901: `generateFileMentionMessages()` is called, injecting file content as `FileMentionMessage` into the messages array BEFORE `before_agent_start` fires
- This means `@requirements.md` in `"let's discuss @requirements.md"` already auto-reads the file into context

### What the user wants: natural trigger

When the user types `"let's review @design.md"` or `"let's discuss @tasks.md"`, the intent is to open mreview on that file — not just inject it as context for the agent.

The dot-commands in `AGENTS.md` (`.spec`, `.vibe`, etc.) are instruction-level: the agent reads `AGENTS.md` as context and acts on them. They are NOT code-level hooks.

For mreview, we want a **code-level intercept**: before submitting the message to the agent, check if the text matches a review/discuss intent with an `@file` mention, and open mreview instead of (or in addition to) the normal agent turn.

### Design: Pre-submit input intercept in builtin slash commands

The cleanest hook point is the **slash command parser** — before the text reaches the agent session, `executeBuiltinSlashCommand` is called. We add a new builtin that matches natural phrases:

**Option A — Keyword prefix detection in the slash command dispatcher**
Add handling in `handleSubmit` / the input processing flow to detect `review @file` or `discuss @file` patterns and route to `/mreview` automatically.

**Option B — A special-case builtin that matches `review` and `discuss` as aliases**
Add `"review"` and `"discuss"` as command names whose handler checks for an `@file` arg and launches mreview.
- `"/review @design.md"` → extract `design.md`, call `openMReviewSession()`
- `"/discuss @requirements.md"` → same

**Option C — Natural language: intercept at the pre-send level**
Before the message reaches the agent, scan for the pattern:
`(let'?s?\s+)?(review|discuss|comment on|talk about)\s+@([^\s]+)`
If matched and the file exists: launch mreview with the resolved file. The agent turn still proceeds (the user's message + auto-read file content go to the agent for additional context).

**Chosen: Option B + `.spec`-style dot-command**

Add two additional slash command names as aliases of `/mreview`:
- `/review <file>` — shorthand: `"/review @design.md"` or `"/review design.md"`
- `/discuss <file>` — shorthand: `"/discuss @requirements.md"`

Both strip the `@` prefix if present, resolve the path, and call `openMReviewSession()`.

Additionally, document in `AGENTS.md` a new dot-command:
- `.review <file>` → `review the spec file at <file> using /mreview` (agent-level instruction to prompt the human to run `/mreview`)

This way:
- Human says `"/review @design.md"` → instant browser open, zero agent turn
- Human says `"let's review @design.md"` → goes to agent, agent has file in context, agent can respond BUT also knows (via AGENTS.md) to suggest the human run `/review design.md`

### `.spec` workflow integration

At any phase gate in spec-driven-dev (after requirements, after design, after tasks), the agent pauses and asks for approval. At that point the human can type:
- `/review .kiro/private/specs/my-feature/requirements.md` → opens browser to annotate and discuss requirements
- `/review .kiro/private/specs/my-feature/design.md` → discuss architecture decisions
- `/review .kiro/private/specs/my-feature/tasks.md` → comment on task breakdown

Feedback from the browser `Send Annotations` → pre-fills the editor → human sends → agent iterates.
This is the natural loop: review in browser → feedback to agent → agent revises → review again.

### Updated slash command aliases to add

In `BUILTIN_SLASH_COMMAND_REGISTRY` (alongside `/mreview`):
```ts
{
  name: "review",
  description: "Open a markdown file in the browser review UI with AI chat (alias for /mreview)",
  inlineHint: "<file.md>",
  allowArgs: true,
  handle: /* same as /mreview handler */
},
{
  name: "discuss",
  description: "Open a markdown file for browser-based AI discussion (alias for /mreview)",
  inlineHint: "<file.md>",
  allowArgs: true,
  handle: /* same as /mreview handler */
},
```

Both share the same handler. The handler strips a leading `@` from the args if present.

### `AGENTS.md` addition

Add to the Dot-Commands section:
```
- `.review <file>` → Prompt the user to run `/review <file>` to open it in the browser annotation and AI discussion UI
```

This keeps the agent aware of the capability without injecting any implementation context.

### Updated file list

Additional entry in `BUILTIN_SLASH_COMMAND_REGISTRY`:
- `/review` — alias for `/mreview`
- `/discuss` — alias for `/mreview`

Both share the handler; strip leading `@` from args.

---

## AGENTS.md and Semantic Context — External Setup Only

### Confirmed: AGENTS.md is user-maintained, not extension-core

The `agents-md.ts` discovery provider walks up from `cwd` looking for `AGENTS.md` files. These are user/project files, not owned by the extension. Adding `.review <file>` awareness belongs in **setup documentation** (e.g., `docs/omp-setup/build.md` or a new `docs/mreview.md`), not hardcoded into any file the extension writes.

The `research/pi/setup/AGENTS.md` edit previously planned is removed from the implementation scope. It becomes **setup instructions** the user applies manually.

### Can `/` commands appear in agent semantic context?

The system prompt template (`prompts/system/system-prompt.md`) confirms the following are injected:
- `contextFiles` (AGENTS.md) — full content
- `skills` — name + description list (the `Skills:` section)
- `toolInfo` — tool names + descriptions (the `Tools:` section)
- **NOT** slash commands — they have no presence in the system prompt at all

This means **slash command names are invisible to the agent** unless explicitly put in context via one of:

**Option 1 — `AGENTS.md` (user-maintained, external setup)**
The user adds to their `AGENTS.md`:
```
- .review <file> → Run /review <file> to open it in the browser annotation UI
```
Zero implementation work. Documented in setup guide.

**Option 2 — A companion `mreview` skill (`~/.omp/agent/skills/mreview/SKILL.md`)**
A skill file that the agent loads (if present) to gain awareness of the command.
The `Skills:` line in the system prompt already renders: `mreview: <description>`.
If the skill is installed, the agent sees it. If not, nothing changes.
This is the cleanest lazy-load semantic injection: **zero cost if skill absent, light description if present**.

Content of the skill:
```markdown
---
name: mreview
description: Browser-based markdown review and AI discussion via /review, /discuss, /mreview
---

Use the /review command (or its aliases /discuss, /mreview) to open any markdown file
in a browser UI for visual annotation and AI-assisted discussion.

Syntax: /review <file.md> or /review @file.md

Workflow during spec phases:
- After requirements: /review .kiro/private/specs/<name>/requirements.md
- After design: /review .kiro/private/specs/<name>/design.md
- After tasks: /review .kiro/private/specs/<name>/tasks.md

When the user asks you to review or discuss a markdown file, suggest:
  /review <file>
```

**Option 3 — Inline in a context file (e.g., a project `.omp/AGENTS.md`)**
The user creates `.omp/AGENTS.md` (or a project-level `AGENTS.md`) with the `.review` entry.
Picked up automatically when omp starts in that directory. No extension change needed.

### Decision

**No implementation change required.** The semantic context question is solved by user-side configuration:
1. Document the skill file in setup instructions (Option 2 — recommended)
2. Or add to their `AGENTS.md` (Option 1)

Remove `research/pi/setup/AGENTS.md` from the modified files list.

### Updated modify list

**Removed**: `research/pi/setup/AGENTS.md` — not extension-core; document in setup guide instead.

**No new additions**: the semantic context solution is external configuration, not code.

---

## Final Architecture Summary: Slash Commands + Skill

### Slash commands: YES, keep them — they cost nothing

Builtin slash commands (`/mreview`, `/review`, `/discuss`) have **zero runtime cost** at all times:
- Not injected into any system prompt
- Not part of any tool schema
- Not visible to the agent
- Available instantly when the human types them

They are the correct mechanism regardless of whether the skill is installed. The skill teaches the
AGENT about them; the commands serve the HUMAN directly. These are orthogonal concerns.

### Companion skill: NOT bundled — sample in docs only

The `mreview` skill (`SKILL.md`) is NOT part of the compiled omp binary or any pre-built package.
Rationale: different users have very different workflows, invocation preferences, and prompt styles.
A bundled skill would be one-size-fits-none.

**What ships:**
- `/mreview`, `/review`, `/discuss` slash commands — in omp core (hardcoded, always available, zero cost)
- A **sample skill file** at `D:/.ai/docs/omp-setup/mreview-skill-sample.md` — NOT installed,
  just a reference for users to copy/customize to `~/.omp/agent/skills/mreview/SKILL.md`

**What does NOT ship:**
- No AGENTS.md modification
- No pre-installed skill
- No prompt template

### Skill sample content (for `docs/omp-setup/mreview-skill-sample.md`)

```markdown
---
name: mreview
description: Browser-based markdown review and AI discussion via /review, /discuss, /mreview
---

Use /review (aliases: /discuss, /mreview) to open any markdown file in a browser UI
for visual annotation and AI-assisted discussion.

Syntax:
  /review <file.md>
  /review @file.md

Spec workflow phase gates:
  /review .kiro/private/specs/<name>/requirements.md
  /review .kiro/private/specs/<name>/design.md
  /review .kiro/private/specs/<name>/tasks.md

When the user says 'review', 'discuss', or 'comment on' a markdown file, suggest:
  /review <file>
```

### New file to create (docs only)
- `D:/.ai/docs/omp-setup/mreview-skill-sample.md` — sample skill for users to install if desired

---

## Bootstrap: Directory Structure + Plan Dump (Git-Visible)

Create the minimal skeleton in `oh-my-pi` aws-corp branch before full implementation.
All files are git-tracked. No implementation code yet — structure, stubs, and the plan document only.

### Notes on the plan file

- Stored as `docs/mreview.md` in the repo — plain markdown, git-visible
- `.index` dot-command (`py D:/.ai/scripts/md2html.py`) can index it into `.index.html` on demand
- `.index.html` is already gitignored (`**/.index.html` in `.gitignore`) — git-invisible as required
- `docs/` already contains 50+ upstream `.md` docs; `mreview.md` fits naturally there

### Directory tree to create

```
packages/coding-agent/src/tools/mreview/
├── README.md          # attribution header + link to docs/mreview.md
└── ai/
    └── .gitkeep       # placeholder; vendored plannotator AI layer lands here

docs/
└── mreview.md         # full implementation plan/spec (this document, adapted)

docs/skills/mreview/
└── SKILL.md           # sample companion skill — copy to ~/.omp/agent/skills/mreview/ to install
```

No `.gitkeep` at `mreview/` root — `README.md` anchors the directory.

### File contents

**`packages/coding-agent/src/tools/mreview/README.md`**
```markdown
# mreview

Browser-based markdown review and AI discussion for omp.

Built on [Plannotator](https://github.com/backnotprop/plannotator) by backnotprop.
Licensed MIT / Apache-2.0.

See [docs/mreview.md](../../../../../docs/mreview.md) for the full implementation plan,
architecture decisions, and attribution.

## Commands

- `/mreview <file.md>` — open markdown file in browser review UI with AI chat
- `/review <file.md>` — alias
- `/discuss <file.md>` — alias

The `ai/` subdirectory will contain code vendored from Plannotator's `packages/ai/` layer.
See `ai/ATTRIBUTION.md` once vendored.
```

**`packages/coding-agent/src/tools/mreview/ai/.gitkeep`** — empty

**`docs/mreview.md`** — full plan content
Strip plan-mode header from `local://PLAN.md`; keep everything from `## Goal` onward.
This is the living spec for the feature.

**`docs/skills/mreview/SKILL.md`**
```markdown
---
name: mreview
description: Browser-based markdown review and AI discussion via /review, /discuss, /mreview
---

Use /review (aliases: /discuss, /mreview) to open any markdown file in a browser UI
for visual annotation and AI-assisted discussion.

Syntax: /review <file.md>  or  /review @file.md

Spec workflow phase gates:
  /review .kiro/private/specs/<name>/requirements.md
  /review .kiro/private/specs/<name>/design.md
  /review .kiro/private/specs/<name>/tasks.md

When the user asks to review or discuss a markdown file, suggest /review <file>.

---
To install: copy this directory to ~/.omp/agent/skills/mreview/
```

### Bootstrap executor steps

1. Create `packages/coding-agent/src/tools/mreview/README.md` (content above)
2. Create `packages/coding-agent/src/tools/mreview/ai/.gitkeep` (empty)
3. **Create `docs/mreview.md`**: read `local://PLAN.md` (resolves to filesystem path), write its full
   content verbatim to `D:/.ai/research/omp/.oh-my-pi/docs/mreview.md`. No stripping required —
   the plan file IS the spec document. The plan-mode system header at the top of `local://PLAN.md`
   is NOT present in the file itself (it is injected by the system); the file starts at line 1 with
   `# mreview — Markdown Discussion/Review Slash Command for omp` which is already clean markdown.
4. Create `docs/skills/mreview/SKILL.md` (content above)
5. `cd D:/.ai/research/omp/.oh-my-pi && git add -A`
6. `git commit -m 'mreview: bootstrap directory structure and implementation plan'`
7. `git push fork aws-corp`

### Gitignore verification
- `*.html` — NOT globally ignored (only `out.html`, `pi-*.html`, `**/.index.html` excluded)
- `review-editor.html` will be tracked once built and copied
- `docs/mreview.md` — tracked (plain `.md`)
- `docs/skills/mreview/SKILL.md` — tracked
- `.gitkeep` — tracked