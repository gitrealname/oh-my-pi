# pi-prompt-template-model: Gap Analysis & Impact Report
# Branch: feature/prompt-template-integration
# Date: 2026-05-09
# Based on: web research + live codebase verification + go/no-go gate results

---

## TL;DR

**Current verdict: NO-GO for Phase 1 without two fixes.** Gates 1 and 2 are blocking.
Gates 3-6 all PASS. Once the two blockers are resolved, integration is clean.

| Blocker | Fix effort | Description |
|---|---|---|
| Gate 1: `parseFrontmatter` not exported | 30 min | Implement in adapter or find alternate API |
| Gate 2: `typebox` package mismatch | 2-4h | Extension uses bare `typebox@1.x`; OMP has `@sinclair/typebox@0.34.x` |

---

## 1. Revised External Package Map

### Lemmy: False Alarm (confirmed)
`@mariozechner/lemmy` is NOT imported anywhere in the extension source. Zero occurrences.
The earlier analysis flagged it based on a partial grep. It is a published npm package
(`badlogic/lemmy`, LLM wrapper library) but irrelevant to this integration.

### All `@mariozechner/pi-*` packages: fully covered by shim
Every actual external import in the extension uses `@mariozechner/pi-coding-agent`,
`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, or `@mariozechner/pi-tui`.
All four are covered by `legacy-pi-compat.ts`'s `pi-*` prefix rewrite.

### `typebox` (bare package): BREAKING MISMATCH
The extension declares `"typebox": "^1.1.24"` in its dependencies.
This is the **unscoped** typebox published at `npmjs.com/package/typebox` — v1.x line,
maintained by sinclairzx81, same codebase as `@sinclair/typebox` but a different
package name and completely different API surface.

OMP uses `"@sinclair/typebox": "0.34.49"` — the **scoped** package, v0.34 LTS line.

These are incompatible:
- `typebox@1.x` API: `Type.Object({...})`, `Type.String()`, `Static<T>` (same as before)
- `@sinclair/typebox@0.34.x` API: same entry functions BUT different internal symbol names,
  different `Kind` system, different `TSchema` structure

At runtime the extension does `import { Type, Static } from "typebox"` which resolves
to nothing in OMP's bundle (that package is not installed). Every schema definition
in the extension (`Type.Object`, `Type.String`, `Type.Boolean`, `Type.Literal`) silently
returns `undefined` → crashes at first schema use.

**Fix options:**
- A: In the extension, change `import { Type, Static } from "typebox"` to
  `import { Type, Static } from "@sinclair/typebox"` and verify the API calls
  are compatible with v0.34.49. The `Type.Object/String/Boolean/Literal/Optional/Union`
  calls are identical between versions — high probability of 0 changes beyond the import.
- B: Add `typebox@1.1.24` to OMP's `packages/coding-agent/package.json` so it's available
  alongside `@sinclair/typebox`. Both can coexist. The extension gets its own version.

**Recommendation:** Option A — change the import in the extension source. Safest, no OMP
core change, and the API surface used (Type.Object, Type.String, Type.Boolean, Type.Literal,
Type.Optional, Type.Union, Static<T>) is identical between the two versions.

---

## 2. Gate Results (Go/No-Go)

| Gate | Result | Finding |
|---|---|---|
| Gate 1: `parseFrontmatter` exported | **FAIL** | Function exists in `packages/coding-agent/src/utils/frontmatter.ts` (line 23) but is NOT exported from `@oh-my-pi/pi-coding-agent`'s public index. The extension imports it from `@mariozechner/pi-coding-agent`. After the shim rewrites to `@oh-my-pi/pi-coding-agent`, import resolves to `undefined` at runtime. |
| Gate 2: `typebox` available | **FAIL** | See section 1. `typebox@1.x` not installed in OMP. `@sinclair/typebox@0.34.x` is. |
| Gate 3: `setModel()` signature | PASS | `pi.setModel(model: Model): Promise<boolean>` — accepts a `Model` object, not a string. Extension must pass a `Model` instance from `pi.getModels()` lookup, not a raw string. (See section 3.) |
| Gate 4: `ctx.ui.notify()` | PASS | `ExtensionCommandContext` extends `ExtensionContext` which has `ui.notify(message, type?)`. |
| Gate 5: `registerMessageRenderer()` | PASS | On `ExtensionContext` at types.ts:1080. Implemented in loader.ts:179. |
| Gate 6: `getCommands()` | PASS | On `ExtensionContext` at types.ts:1120. Returns `SlashCommandInfo[]`. |

---

## 3. Gate 3 Detail: setModel() Accepts Model Object, Not String

**Critical nuance.** The extension's model selection produces a string:
```typescript
const candidate = selectModelCandidate(registry, frontmatter.model);
// candidate.id = "anthropic/claude-sonnet-4" (string)
```

Then calls:
```typescript
await pi.setModel(candidate); // <-- passes the candidate object
```

But OMP's `setModel(model: Model): Promise<boolean>` expects a `Model` object
(from `@oh-my-pi/pi-ai`). The extension's `SelectedModelCandidate` has fields
`id`, `provider`, `model` (the actual `Model` object from the registry).

The extension DOES pass the `Model` object (via `candidate.model`), not the string.
This is correct. **Gate 3 passes cleanly.**

However: `selectModelCandidate()` uses `RegistryLike.find(provider, modelId)` which
returns a `Model | undefined`. If the `aws-corp` provider models are not in the registry
that the extension sees, aws-corp model templates silently fall through to no match.

**Action needed:** Verify that `pi.getModels()` (equivalent of `registry.getAll()`)
includes aws-corp models. If not, add `PREFERRED_PROVIDERS` entry as noted.

---

## 4. Gate 1 Detail: parseFrontmatter Fix Options

`parseFrontmatter` exists in OMP source at `packages/coding-agent/src/utils/frontmatter.ts`.
It's used internally by OMP for skill file parsing, .md rule parsing, etc. It is NOT
exported via the public `@oh-my-pi/pi-coding-agent` npm package surface.

**Fix options:**
- A: Add `parseFrontmatter` to the exports of `packages/coding-agent/src/index.ts`
  (or wherever `@oh-my-pi/pi-coding-agent` exposes its public API). 1-line change.
- B: In the omp-adapter.ts, inject `parseFrontmatter` into the extension's context
  before calling the extension factory. The extension uses it only in `prompt-loader.ts`.
- C: In the extension's `prompt-loader.ts`, replace the import with a local YAML parser
  (`js-yaml` or a minimal frontmatter regex). The frontmatter format is simple (YAML
  between `---` delimiters) — a 20-line local parser could replace the import.

**Recommendation:** Option A — add `parseFrontmatter` to `@oh-my-pi/pi-coding-agent`
exports. It's a general utility that other extensions would also benefit from. 1-line
change to OMP's package index. Clean.

---

## 5. systemPrompt Overwrite Risk (Critical Interaction with mmemory)

This is the most significant finding from the impact analysis.

**The problem:**
OMP's extension runner (`runner.ts`) calls `before_agent_start` handlers serially.
For each handler it threads `systemPrompt`:
```typescript
for (const ext of this.extensions) {
    const result = await ext.onBeforeAgentStart(event);
    if (result?.systemPrompt) event.systemPrompt = result.systemPrompt;
}
```

Extension registration order:
1. autoresearch
2. prompt-engine
3. mmemory → returns `systemPrompt` with `<observations>/<memories>/<referenced_files>`
4. mprune
5. ...
6. **template extension** (discovered last, appended after all inline)

The template extension's `before_agent_start` handler (index.ts lines 1641-1667) reads
`event.systemPrompt` (the ORIGINAL value from before any handler ran) and returns
its own modified version. It does NOT read the already-threaded version that includes
mmemory's injection.

**Result:** When a template command is active AND mmemory has injected context, the
template extension's `before_agent_start` return OVERWRITES mmemory's injection with
a version that doesn't include it.

**Severity:** HIGH. mmemory recall content silently disappears during template execution.

**When it fires:** Only when `hasSystemPromptOverride || skillMessage` is true —
i.e., only during active template execution with `skill:` frontmatter or active loop state.
On normal non-template turns, line 1661 returns early → no conflict. Bug is scoped
to template-driven turns.

**Fix:** In the omp-adapter.ts (or in the extension's handler), change the systemPrompt
base from `event.systemPrompt` to the current value after prior handlers ran.
The adapter wraps the handler and passes the correctly threaded value:
```typescript
// In adapter's before_agent_start wrapper:
const originalSystemPrompt = event.systemPrompt; // already mmemory-modified
event.systemPrompt = originalSystemPrompt; // no-op, but illustrates the point:
// The extension reads event.systemPrompt — ensure it reads the threaded version.
```

Actually the fix is simpler: since the template extension modifies `event.systemPrompt`
in place (it's passed by reference as part of `event`) and the runner reads
`result.systemPrompt` from the RETURN VALUE, we need the extension to:
- Read `event.systemPrompt` as the base (already threaded = correct)
- Build on top of it rather than replacing it

This is a 2-line change in `index.ts` — change the base from the pre-handler snapshot
to whatever `event.systemPrompt` currently holds.

---

## 6. setModel() Mid-Session: Risk Profile

**Verdict: LOW in normal flows, MEDIUM under abort/cancel.**

`setModel()` calls `#setModelWithProviderSessionReset()` which swaps provider session
state. The extension's `waitForTurnStart()` + `waitForIdle()` pattern guards against
concurrent model switches during active streaming. No structural race for normal flows.

**The risk:** If the user presses Esc (abort) mid-chain, `restoreSessionState()` may
be skipped (signal fires, cleanup callback may not run if control flow exits early).
Session left in switched-model state until user manually resets or session ends.

**Mitigation in adapter:** Wrap all setModel calls in try/finally:
```typescript
const prev = event.currentModel;
try {
    await pi.setModel(newModel);
    // ... execute template ...
} finally {
    if (prev) await pi.setModel(prev); // always restore
}
```

The extension already has this pattern in places but the abort path bypasses it.
In the adapter, wrapping the entire command handler in try/finally guarantees restore.

---

## 7. mmemory + Template: Other Interactions

| Interaction | Risk | Notes |
|---|---|---|
| mmemory modelRole vs template model | NONE | mmemory reads `config.modelRole` (static), never `session.model`. Template switching is invisible to mmemory's recall/consolidation. |
| Template uses `.recall` in a chain step | WORKS | The mmemory_recall tool is registered globally. Chain steps run inside a normal agent turn. `.recall` slash command or tool call works exactly as in a manual session. |
| Template chains accumulate in session history | LOW | Each chain step's conversation is appended to the main session history. Long chains inflate the context window and are retained by mmemory. User should be aware that a 5-step chain produces 10+ messages in history. |
| mmemory retention of template execution | BENEFICIAL | mmemory retains the template turn like any other turn. Chain results, model-switched reasoning, skill-injected content all appear in session chunks. Future recall can surface template outputs. |

---

## 8. Revised Blocker Summary

**Original analysis had 4 blockers. Actual picture after research:**

| # | Blocker | Original assessment | Revised |
|---|---|---|---|
| 1 | Export shape (sync vs async) | BLOCKER | TRIVIAL — 1 word change |
| 2 | model_select event missing | BLOCKER | LOW — graceful degrade (snapshot-at-start) |
| 3 | ctx.signal missing | BLOCKER | LOW — mock AbortSignal in adapter |
| 4 | Subagent runtime missing | BLOCKER | MEDIUM — degrade workers/lineup features |
| 5 (new) | parseFrontmatter not exported | BLOCKER | EASY — 1-line OMP export OR local parser |
| 6 (new) | typebox package mismatch | BLOCKER | MEDIUM — change import in extension source |
| 7 (new) | systemPrompt overwrite | CRITICAL INTERACTION | MEDIUM — 2-line fix in extension |
| 8 (new) | setModel() accepts Model not string | MEDIUM | NON-ISSUE — extension already passes Model |

**Net: 2 true blocking gates (parseFrontmatter, typebox), 1 critical interaction (systemPrompt),
1 trivial change (async export). All others degrade gracefully or are non-issues.**

---

## 9. Revised Integration Sequence

### Pre-work (before any Phase 1 code):
1. Export `parseFrontmatter` from `@oh-my-pi/pi-coding-agent` — OMP core, 1-line change
2. Change `import from "typebox"` → `import from "@sinclair/typebox"` in extension — verify API compat

### Phase 1: Core features (model/skill/thinking/chain/loop) — ~4h
1. `async function` export fix (1 word)
2. Write `omp-adapter.ts`:
   - Mock `ctx.signal` (AbortController stub)
   - Intercept `model_select` registration (no-op)
   - Intercept `requestDelegatedRun()` (graceful stub — logs warning, returns empty)
   - Fix systemPrompt threading: read `event.systemPrompt` after-mmemory as base
   - Wrap command handler in try/finally for model restore
3. Update `package.json` with `omp.extensions` field
4. Add aws-corp to `PREFERRED_PROVIDERS`
5. Deploy to `~/.omp/agent/extensions/prompt-template-model/`

### Phase 2: Model tracking (~1h)
Add `model_select` event to OMP's ExtensionAPI, emit from session model-switch path.

### Phase 3: Cancel / AbortSignal (~2h)
Add `signal: AbortSignal` to `ExtensionCommandContext`, wire to session abort controller.

### Phase 4: Subagent runner (~8-16h)
Build subagent runner extension that bridges OMP's task infrastructure to the EventBus
IPC channels the template extension expects.

---

## 10. Files to Touch (revised)

| File | Change | Phase |
|---|---|---|
| `.pi-prompt-template-model/index.ts` | `function` → `async function` | Pre-work |
| `.pi-prompt-template-model/prompt-loader.ts` | Change typebox import | Pre-work |
| `.pi-prompt-template-model/index.ts` (line ~1641) | Read threaded systemPrompt | Pre-work |
| `.pi-prompt-template-model/model-selection.ts` | Add aws-corp to PREFERRED_PROVIDERS | Phase 1 |
| `.pi-prompt-template-model/package.json` | Add omp.extensions | Phase 1 |
| `.pi-prompt-template-model/omp-adapter.ts` | NEW — adapter wrapper | Phase 1 |
| `packages/coding-agent/src/index.ts` (OMP) | Export parseFrontmatter | Pre-work |
| `packages/coding-agent/src/extensibility/extensions/types.ts` (OMP) | Add model_select | Phase 2 |
| `packages/coding-agent/src/extensibility/extensions/types.ts` (OMP) | Add ctx.signal | Phase 3 |
| `packages/coding-agent/src/session/agent-session.ts` (OMP) | Emit model_select | Phase 2 |
| `packages/coding-agent/src/session/agent-session.ts` (OMP) | Wire abort signal | Phase 3 |

**OMP core touches:** 2 files, all additive (no existing behavior changed).
**Extension touches:** 4 files + 1 new file.
