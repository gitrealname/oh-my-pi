# pi-prompt-template-model: Integration Analysis
# Branch: feature/prompt-template-integration
# Date: 2026-05-09
# Status: Analysis only — no code changes

---

## 1. Executive Summary

The extension is well-structured and largely compatible with OMP. There are **4 hard blockers**,
**2 medium risks**, and **1 false alarm** (Vue — not used at all). The blockers are all solvable
with targeted adapter code; none require rewriting the extension internals.

| Area | Status | Effort |
|---|---|---|
| Import namespace (@mariozechner/* → shim) | RESOLVED by legacy-pi-compat | 0 |
| Vue / runtime deps | NOT NEEDED — extension uses pi-tui | 0 |
| Export shape mismatch | BLOCKER — must write adapter | 30 min |
| `model_select` event missing from API | BLOCKER — add to OMP types or use workaround | 1h |
| `ctx.signal` (AbortSignal) missing | BLOCKER — need to surface or mock | 1h |
| Subagent runtime (external binary) | BLOCKER — different architecture | 2–4h |
| @mariozechner/lemmy not shimmed | MEDIUM — used only as a type | 30 min |
| Model restore: setModel() API shape | MEDIUM — verify return type + error path | 30 min |

---

## 2. False Alarm: Vue

**No Vue dependency exists.** The extension uses `@mariozechner/pi-tui` (OMP's own TUI
component system: Box, Container, Text, Spacer, etc.) for all UI rendering. State is plain
closure variables. No reactive primitives, no signals, no DOM. The `.index.html` file is an
unrelated static docs viewer from the OMP index skill — not extension runtime.

Risk: **NONE.**

---

## 3. Blocker 1: Export Shape Mismatch

**Current extension export:**
```typescript
// index.ts line 1:
export default function promptModelExtension(pi: ExtensionAPI) {
    // synchronous, returns void
}
```

**OMP loader expects:**
```typescript
// extensibility/extensions/loader.ts
const mod = await import(path);
await mod.default(api); // async factory, returns Promise<void>
```

The extension's `default` export is a sync function (returns `void`, not `Promise<void>`).
`await` of a non-Promise resolves immediately so the loader would call it, await the void,
and proceed — the extension would be "loaded" but the loader would not know it's done
initialising. Since the extension registers its handlers synchronously this is actually fine
in practice, but TypeScript types will reject it and the loader may have a runtime guard.

**Fix options:**
- A: Wrap in async adapter: `export default async (api) => { promptModelExtension(api); }`
  — zero change to the extension source, pure shim at entry point.
- B: Change the extension's export to `async` — trivial 1-word change.

**Recommendation:** Option B — change `export default function` to
`export default async function`. 1-word change, no logic touched.

---

## 4. Blocker 2: `model_select` Event Missing from ExtensionAPI

**What the extension uses:**
```typescript
// index.ts
pi.on('model_select', async (ctx) => {
    // fires when user switches model interactively
    // updates internal state: currentModel = ctx.newModel
});
```

**OMP's `ExtensionAPI` event overloads:** `session_start`, `before_agent_start`, `agent_end`,
`session_before_tree`. No `model_select` overload exists.

**What this event does in the extension:** tracks the currently active model so it can
restore it after template execution. Without `model_select`, if the user switches models
manually mid-session, the extension's internal `currentModel` state goes stale and the
"restore after template" path restores to the wrong model.

**Severity:** MEDIUM-HIGH. Template execution still works; model restore may misbehave
if the user switches models between template runs.

**Fix options:**
- A: Add `model_select` to `ExtensionAPI` types and emit it from OMP's model-switch path.
  Requires finding where OMP switches models and adding an EventBus emit. 1–2 hours.
- B: In the adapter, replace `pi.on('model_select', ...)` with a periodic polling approach
  (`pi.on('before_agent_start', ...)` which fires every turn — check current model there).
- C: Accept the stale-state risk for now; add a `getModel()` call at the start of every
  template execution to snapshot current model (bypass the tracked state). Low effort.

**Recommendation:** Option C first (unblock integration), Option A later as a proper fix.
Add `getModel()` snapshot at execution start:
```typescript
// in template execution, always snapshot fresh:
const currentModel = api.getModel?.() ?? trackedModel;
```
Check if `getModel()` exists on `ExtensionAPI`.

---

## 5. Blocker 3: `ctx.signal` (AbortSignal) Missing

**What the extension uses:**
```typescript
// index.ts, throughout executeSubagentPromptStep:
await executeSubagentPromptStep(pi, ctx, request, ctx.signal);
// and:
ctx.signal.addEventListener('abort', cleanup);
```

`ctx.signal` is an `AbortSignal` that fires when the user cancels a command execution.
`ExtensionCommandContext` in OMP's `types.ts` does not have a `signal` property.

**Severity:** HIGH. Without `ctx.signal`, subagent cleanup and cancellation are broken.
A running chain that the user tries to cancel would run until completion or hang.

**Impact scope:** Used in `subagent-step.ts` and throughout `index.ts` chain execution.
The `signal` is threaded through 4+ call levels.

**Fix options:**
- A: Add `signal: AbortSignal` to `ExtensionCommandContext` in OMP and wire it to the
  session's abort controller. Requires understanding how OMP cancels commands.
- B: Create a mock `AbortSignal` in the adapter that never fires, making cancellation
  a no-op. Subagents run to completion but at least don't crash.
- C: Create a real `AbortSignal` tied to `pi.on('agent_end', ...)` — when the session
  ends, fire the abort. Not true mid-execution cancel but prevents leaks.

**Recommendation:** Option B initially (mock AbortSignal = `new AbortController().signal`
never aborted). Cancellation degrades to "run until done" — acceptable for initial
integration. Option A is the proper fix.

---

## 6. Blocker 4: Subagent Runtime — Architecture Mismatch

This is the most significant issue.

**What the extension expects:**
```typescript
// subagent-runtime.ts
const agentsModule = await import(agentsPath);
// agentsPath = ~/.pi/agent/extensions/subagent/agents.ts (or .js)
```
It dynamically loads an `agents.ts` from `~/.pi/agent/extensions/subagent/` — an external
**subagent runner binary** that listens on `pi.events` for `PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT`
and handles parallel task execution.

**The EventBus IPC pattern:**
```
main extension  →  pi.events.emit(REQUEST_EVENT, {tasks: [...], requestId})
subagent runner →  pi.events.on(REQUEST_EVENT) → spawns agents → emits(RESPONSE_EVENT)
main extension  ←  pi.events.on(RESPONSE_EVENT, handler filtered by requestId)
```

This is an in-process message-passing architecture that assumes a SECOND extension
(the subagent runner) is also loaded and listening on the same EventBus.

**What exists vs what's needed:**
- The event channels and EventBus: ✓ present in OMP
- The subagent runner extension: ✗ NOT in the `.pi-prompt-template-model` directory
- The `agents.ts` file at `~/.pi/agent/extensions/subagent/`: ✗ does not exist

**Severity:** HIGH for the subagent/parallel/workers features. LOW for the core
model/skill/thinking/chain features — those don't use subagents.

**Scope of impact:**
Features that require the subagent runner: `workers:`, `lineup:`, `parallel()` chains.
Features that work WITHOUT it: `model:`, `skill:`, `thinking:`, `loop:`, `chain:` (sequential),
`deterministic:`, basic prompt execution.

**Fix options:**
- A: Implement the subagent runner as a separate OMP extension (`subagent-runner/index.ts`).
  This is a significant project — it needs to spawn/manage agent sessions, collect results.
  Estimate: 8–16 hours. Could leverage OMP's existing `task` tool infrastructure.
- B: Gracefully degrade — in the adapter, intercept `requestDelegatedRun()` calls and
  return a stub response, skipping parallel execution. Log a warning. Core single-agent
  features all work; parallel is disabled.
- C: Use OMP's existing `task` subagent mechanism (the internal task-spawning used by the
  `task` tool) as the subagent runner. Requires a bridge layer. Estimate: 4–8 hours.

**Recommendation:** Option B for initial integration (degrade gracefully). Option C as a
follow-on project — OMP already has a task subagent system; bridging it to the EventBus
IPC channels is cleaner than building from scratch.

---

## 7. Medium Risk 1: `@mariozechner/lemmy` Not Covered by Shim

`legacy-pi-compat.ts` rewrites `@mariozechner/pi-*` packages only (prefix match on `pi-`).
The extension imports from `@mariozechner/lemmy` in some files (`chain-runner.ts`: `MessageRouter`).

`@mariozechner/lemmy` → shim does NOT rewrite this → import resolves to nothing at runtime.

**Severity check:** How is `MessageRouter` used?
- `chain-runner.ts` imports it as a type only (`import type { MessageRouter }`)
- At runtime (compiled JS), `import type` is erased — no actual import
- No VALUE import from `@mariozechner/lemmy` was found in the extension source

**Conclusion:** MEDIUM risk becomes LOW. Lemmy is used type-only; no runtime import.
But should be verified at integration time by confirming the compiled output has no
`lemmy` in the bundle.

**Fix if needed:** Add `@mariozechner/lemmy` to the shim's rewrite list. 1 line.

---

## 8. Medium Risk 2: Model Switch API — setModel() Return Semantics

**Extension usage:**
```typescript
await pi.setModel(candidateModelId); // returns Promise<boolean>
if (!result) {
    // model switch failed
}
```

**OMP's `setModel` in ExtensionAPI:** exists and returns `Promise<boolean>`. Match.

**The risk:** `candidateModelId` format. The extension's `selectModelCandidate()` produces
a `provider/modelId` string. For aws-corp models this would be `aws-corp/us.anthropic.claude-sonnet-4-5`.
OMP's `setModel` may expect the raw `modelId` only (without provider prefix), or a registry
lookup ID.

Need to verify: what format does `pi.setModel(id)` accept? If it expects `provider/model`:
no fix needed. If it expects `modelId` only: the extension's model selection output needs
adapting.

**Fix if needed:** Strip provider prefix before calling `setModel`. 1 line in the adapter.

---

## 9. Dependency Map (complete)

```
index.ts
├── @mariozechner/pi-coding-agent    ExtensionAPI, ExtensionCommandContext, ExtensionContext,
│                                    parseFrontmatter, SessionEntry
├── @mariozechner/pi-ai              Model, AssistantMessage, Message (types only in most)
├── @mariozechner/pi-agent-core      ThinkingLevel
├── @mariozechner/pi-tui             Key, matchesKey (subagent-step.ts only)
├── node:fs                          existsSync, readdirSync, readFileSync, realpathSync, statSync
├── node:path                        dirname, isAbsolute, join, resolve
├── node:os                          homedir
├── node:crypto                      randomUUID
└── typebox@^1.1.24                  Type, Static (schema validation)

@mariozechner/lemmy                  MessageRouter — import type ONLY, erased at runtime
```

All `@mariozechner/pi-*` symbols are covered by `legacy-pi-compat.ts`. No npm runtime
deps except `typebox` — need to verify `typebox` is available in OMP's bundle or node_modules.

---

## 10. Prompt Discovery Path

The extension scans these directories for `.md` prompt files:
```
{cwd}/.pi/prompts/
{cwd}/.pi/
~/     (homedir)
~/.pi/prompts/
~/.pi/
```

OMP's `cwd` = `sessionManager.getCwd()`. The extension calls `process.cwd()` directly —
this works for the initial load but may be stale if OMP changes cwd mid-session. The
adapter should pass `api.getCwd()` explicitly on command invocation.

---

## 11. `parseFrontmatter` Dependency

`prompt-loader.ts` imports `parseFrontmatter` from `@mariozechner/pi-coding-agent`.
After the shim resolves this to `@oh-my-pi/pi-coding-agent`:
- Does `@oh-my-pi/pi-coding-agent` export `parseFrontmatter`?
- What is the signature? Returns `{ data: Record<string, unknown>, content: string }` presumably.

This is a concrete API verification needed before integration. If the function was renamed
or moved, the prompt loader silently fails (cannot parse template files at all).

---

## 12. Integration Approach — Recommended Sequence

### Phase 1: Minimal viable core (model + skill + thinking, no subagents)
**Effort: ~4 hours. Delivers 80% of the value.**

1. Fix export shape (`async function`) — 5 min
2. Write `omp-adapter.ts` that:
   - Passes the api as-is to the extension (the shim + default export handles the rest)
   - Mocks `ctx.signal` in command handler wrapper
   - Catches `model_select` registration silently (no-op)
   - Intercepts `requestDelegatedRun()` with a graceful stub
3. Verify `parseFrontmatter` and `typebox` availability
4. Add `PREFERRED_PROVIDERS` entry for `aws-corp`/`bedrock-converse-stream`
5. Test: create `test.md` with `model:` frontmatter, run via slash command

### Phase 2: Model tracking fix
**Effort: ~1 hour.**

Snapshot current model at command invocation time instead of tracking via `model_select`.
Verify restore works correctly.

### Phase 3: AbortSignal wiring
**Effort: ~2 hours.**

Add `signal: AbortSignal` to `ExtensionCommandContext` in OMP types and wire to session
abort controller. Real cancellation support.

### Phase 4: Subagent runner
**Effort: 4–8 hours.**

Build OMP EventBus bridge to the task subagent system. Unlocks `workers:`, `lineup:`,
`parallel()` chains. This is the only phase that requires touching OMP core files
(adding EventBus listeners to the task execution path).

---

## 13. Files to Create / Modify

| Action | File | What |
|---|---|---|
| CREATE | `.pi-prompt-template-model/omp-adapter.ts` | Async wrapper + signal mock + model_select noop |
| MODIFY | `.pi-prompt-template-model/index.ts` | `function` → `async function` (1 word) |
| MODIFY | `.pi-prompt-template-model/model-selection.ts` | Add aws-corp to PREFERRED_PROVIDERS |
| MODIFY | `.pi-prompt-template-model/package.json` | Add `"omp": { "extensions": ["omp-adapter.ts"] }` |
| VERIFY | `@oh-my-pi/pi-coding-agent` exports | Confirm parseFrontmatter exists |
| VERIFY | `typebox@^1.1.24` | Confirm available in OMP runtime |
| OMP CORE — Phase 2 | `extensibility/extensions/types.ts` | Add `getModel?(): string` to ExtensionAPI |
| OMP CORE — Phase 3 | `extensibility/extensions/types.ts` | Add `signal: AbortSignal` to ExtensionCommandContext |
| OMP CORE — Phase 3 | Session/command dispatch | Emit abort on cancel |
| OMP CORE — Phase 4 | New: `subagent-bridge.ts` | EventBus → task subagent bridge |

---

## 14. Go/No-Go Gates

Before starting Phase 1 implementation:

```
[ ] Verify parseFrontmatter exported from @oh-my-pi/pi-coding-agent
[ ] Verify typebox@^1.1.24 available (OMP node_modules or bundled)
[ ] Verify setModel() accepts provider/model-id format
[ ] Verify ctx.ui.notify() exists on ExtensionCommandContext (notifications.ts uses it)
[ ] Confirm pi.registerMessageRenderer() exists and signature matches
[ ] Confirm pi.getCommands() exists (used in index.ts for command listing)
```

These are quick grep/read checks — 15 minutes. All should pass but any gap found here
changes the effort estimate for Phase 1.
