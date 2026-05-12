# Merge Plan: upstream v14.9.9 → aws-corp

**Branch:** `merge/v14.9.9` (created from `aws-corp` at `0caa6ac4f`)  
**Upstream:** `origin/main` (v14.9.9, tag `v14.9.9`)  
**Merge base:** `453fc4ede` (v14.9.3 — last upstream merge point)  
**Upstream commits ahead of base:** 87  
**Date:** 2026-05-12  

---

## Rules

- All work is done on `merge/v14.9.9` only — **never directly on `aws-corp`**
- `aws-corp` accepts merges only — no direct commits
- No commit or merge without explicit user approval
- Build must pass clean before merge is proposed

---

## Conflict Files (3)

### 1. `packages/coding-agent/scripts/build-binary.ts`

**Verdict: TRIVIAL — keep ours entirely**

| Side | Change |
|------|--------|
| **Ours** | Added `const buildTime = new Date().toISOString()` + two `--define` flags in compact inline form (`"--define", 'PI_COMPILED...'`) |
| **Upstream** | Reformatted those same `--define`/`--external`/`--root`/`--outfile` args to one-per-line style. Removed `buildTime` (it doesn't have our BUILD_TIME feature). Added worker entrypoints (`sync-worker.ts`, `tab-worker-entry.ts`, `worker-entry.ts`) to the `bun build` command. |

**Resolution strategy:**
- Keep our compact inline formatting for our two `--define` pairs  
- **Add** upstream's three worker entrypoint args (new functionality we were missing)  
- Net result: our `BUILD_TIME` define preserved + upstream worker entrypoints added

**Exact diff to apply:**
```typescript
// OURS (keep):
"--define", 'process.env.PI_COMPILED="true"',
"--define", `process.env.BUILD_TIME="${buildTime}"`,
"--external", "mupdf",
"--root", "../..",
"./src/cli.ts",
// ADD from upstream (new worker entrypoints):
"../stats/src/sync-worker.ts",
"./src/tools/browser/tab-worker-entry.ts",
"./src/eval/js/worker-entry.ts",
"--outfile", "dist/omp",
```

---

### 2. `packages/tui/src/tui.ts`

**Verdict: TRIVIAL — re-add our 9-line method to upstream's file**

| Side | Change |
|------|--------|
| **Ours** | Added `simulateInput(data: string): void` method (9 lines) after the `addInputListener` block, before `removeInputListener`. Calls `this.#handleInput(data)`. |
| **Upstream** | Render throttling (`#renderTimer`, `#MIN_RENDER_INTERVAL_MS`), `normalizeTerminalOutput` import, `#consumeCellSizeResponse` refactor (was `#parseCellSizeResponse`), removed `#inputBuffer`/`#cellSizeQueryPending` fields, per-line OSC 8 hyperlink bleed fix (`LINE_TERMINATOR`), render-test sync fix. Zero overlap with our addition. |

**Resolution strategy:**
- Take upstream's file verbatim  
- Re-insert our `simulateInput` method at the exact same position: after `addInputListener`, before `removeInputListener`
- `#handleInput` is unchanged upstream — the call is valid

**Method to re-insert (verbatim):**
```typescript
	/**
	 * Inject a raw input sequence as if it came from the terminal.
	 * Routes through the full TUI input pipeline to the currently focused component.
	 * Use this for navigation keys (arrows, home/end, F-keys, etc.).
	 */
	simulateInput(data: string): void {
		this.#handleInput(data);
	}

```

---

### 3. `packages/coding-agent/src/sdk.ts`

**Verdict: MODERATE — graft our additions onto upstream's refactored skeleton**

This is the only file requiring careful thought. Upstream made a large structural refactor; we added 6 extension registrations + `activeSkillRoles` + `memory` option. No semantic overlap, but line numbers shift significantly.

#### Upstream changes (what we must adopt):

| Area | Upstream change | Impact on ours |
|------|----------------|----------------|
| **Imports** | `+setActiveRules` from `capability/rule`; `+setActiveSkills` from `extensibility/skills`; removed 9 protocol handler imports (now moved to singletons); removed `MCPManager as type` → now concrete class (`MCPManager.setInstance`); removed `getMemoryRoot` import | Our 6 extension imports are purely additive — no overlap |
| **`asyncJobManager`** | Now gated: `backgroundJobsEnabled && !options.parentTaskPrefix`. Fixes subagent double-disposal bug. | We don't touch `asyncJobManager` — take upstream's version |
| **Internal URL router** | Entire `InternalUrlRouter` + 9 `internalRouter.register(...)` calls **removed**. Replaced by: `setActiveSkills(skills)`, `setActiveRules(...)`, `AsyncJobManager.setInstance(asyncJobManager)`, `MCPManager.setInstance(mcpManager)`, `LocalProtocolHandler.setOverride(...)`. All gated on `!options.parentTaskPrefix`. | Our `activeSkillRoles` block was inserted immediately after `toolSession.internalRouter = internalRouter` — that anchor is gone. Must re-anchor after the new `setActiveSkills` block. |
| **`toolSession`** | Removed `asyncJobManager` from `toolSession`; removed `mcpManager` direct assign → `MCPManager.setInstance`; added `getArtifactManager: () => sessionManager.getArtifactManager()` | Our `toolSession.activeSkillRoles = activeSkillRoles` line still valid — `toolSession` shape hasn't changed for our field |
| **`AgentSession` constructor** | Removed `asyncJobManager` field, added `ownedAsyncJobManager: asyncJobManager` (owned only by top-level sessions) | No conflict — we don't pass `asyncJobManager` |
| **`resolveMemoryBackend(...).start`** | Added `memory: options.memory` at call site — this is **identical to our change** (we added the same line) | De-duplicated — take upstream; our change already satisfied |

#### Our additions (what we must preserve):

**A. Imports block** (after `import { createAutoresearchExtension }`)
```typescript
import { createMmemoryExtension } from "./mmemory-extension";
import { createPromptTemplateExtension, setMPromptTemplateRoleResolver } from "./m-prompt-template/activate";
import { resolveTemplateModelSpec } from "./utils/m-utils";
import { createMpruneExtension } from "./extensibility/extensions/m-prune-extension";
import { createMtuicontrolExtension } from "./extensibility/extensions/m-mtuicontrol-extension";
import { createPromptEngine } from "./prompt-engine";
```
Also: `import { Settings, type SettingPath, type SkillsSettings }` (our `SettingPath` addition — upstream does NOT have this)

**B. `CreateAgentSessionOptions.memory` field**
```typescript
/** Memory injection mode for subagents. "none" skips injection; "inherit" is the default. */
memory?: "none" | "inherit";
```
Insert after `settings?: Settings` (same location as ours — still valid).

**C. `activeSkillRoles` block** (~15 lines)
New anchor: insert **after** the `setActiveSkills(skills)` line (replacing the old `toolSession.internalRouter` anchor).
```typescript
// Populate activeSkillRoles from skills that declare role+tools frontmatter
const activeSkillRoles = new Map<string, string>();
for (const skill of skills as Array<{ frontmatter?: Record<string, unknown> }>) {
    if (!skill.frontmatter) continue;
    const role = skill.frontmatter["role"] as string | undefined;
    const tools = skill.frontmatter["tools"] as string[] | undefined;
    if (role && Array.isArray(tools)) {
        for (const toolName of tools) {
            activeSkillRoles.set(toolName, role);
        }
    }
}
toolSession.activeSkillRoles = activeSkillRoles;
```

**D. Extension registration block** (replaces upstream's `inlineExtensions.push(createAutoresearchExtension)`)
Upstream already pushes `createAutoresearchExtension` unconditionally — we gate it. Our full block:
```typescript
if (settings.get("autoresearch.enabled" as SettingPath) !== false) {
    inlineExtensions.push(createAutoresearchExtension);
}
if (settings.get("promptEngine.enabled" as SettingPath) !== false) {
    inlineExtensions.push(createPromptEngine);
}
if (settings.get("mmemory.enabled" as SettingPath) !== false) {
    inlineExtensions.push(createMmemoryExtension);
}
if (settings.get("mprune.enabled" as SettingPath) !== false) {
    inlineExtensions.push(createMpruneExtension);
}
if (settings.get("promptTemplates.enabled" as SettingPath) !== false) {
    setMPromptTemplateRoleResolver((spec) => resolveTemplateModelSpec(spec, settings));
    inlineExtensions.push(createPromptTemplateExtension);
}
if (settings.get("mtuicontrol.enabled" as SettingPath) === true) {
    inlineExtensions.push(createMtuicontrolExtension);
}
```
Replaces the single `inlineExtensions.push(createAutoresearchExtension)` line in upstream.

**E. `extensionRunner?.setTaskDepth(taskDepth)`**  
Insert after the `extensionsResult.runtime.pendingProviderRegistrations = []` block (same location).

**F. `memory: options.memory`** at `resolveMemoryBackend().start(...)` call site  
Upstream already added this — no action needed (de-duplicated).

**G. DEBUG comment** (`// DEBUG: Log model resolution inputs`) — this is noise, drop it in the merge.

#### sdk.ts merge execution plan (ordered):

1. Start from upstream's `sdk.ts` verbatim
2. After `import { createAutoresearchExtension }` — insert our 6 extension imports
3. Change `import { Settings, type SkillsSettings }` → `import { Settings, type SettingPath, type SkillsSettings }`
4. After `settings?: Settings;` in `CreateAgentSessionOptions` — insert `memory?` field
5. After `if (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);` — insert `activeSkillRoles` block + `toolSession.activeSkillRoles = activeSkillRoles`
6. Replace single `inlineExtensions.push(createAutoresearchExtension)` with our full gated block
7. After `extensionsResult.runtime.pendingProviderRegistrations = []` block — insert `extensionRunner?.setTaskDepth(taskDepth)`
8. Verify `memory: options.memory` already present at `resolveMemoryBackend` call (upstream added it)

---

## Non-conflict upstream files requiring attention

These files changed upstream and touch areas adjacent to our code. No conflicts but worth verifying post-merge:

| File | Upstream change | Verify |
|------|----------------|--------|
| `src/modes/rpc/rpc-mode.ts` | `requestRpcEditor` exported (used by Phase 3 test) | Confirm our `rpc-mode.ts` changes (inject path) still compile |
| `src/extensibility/skills.ts` | Added `setActiveSkills` export | Used by upstream's sdk.ts refactor — we import but don't call (sdk.ts does) |
| `src/capability/rule.ts` | Added `setActiveRules` export | Same |
| `src/session/agent-session.ts` | `asyncJobManager` → `ownedAsyncJobManager`; `AsyncJobManager.instance()` for subagents | Our ESC-fix changes to `agent-session.ts` may have touched neighbouring fields — verify |
| `packages/tui/src/autocomplete.ts` | Awaitable slash commands + hints | No conflict; bonus improvement for `inject_slash` |

---

## Extension-UI test (`rpc-mode-extension-ui.test.ts`) — context

This test (written by **us** on `mtuicontol`) tests `requestRpcEditor` — a function that:
- Sends an `extension_ui_request` of method `"editor"` with `promptStyle` field
- Handles cancellation via `AbortController` → sends method `"cancel"` with `targetId`
- Cleans up `pendingRequests` map on resolution

This is Phase 3 territory. The test imports `requestRpcEditor` and `PendingExtensionRequest` from `rpc-mode.ts`. These are already present in our code — the test should pass as-is after merge. **No new work needed for the test itself.**

---

## Execution log

**Approach change**: instead of 7 sdk.ts grafts, extracted all wiring into `corp-sdk-extensions.ts` (new file).
`sdk.ts` footprint reduced to 1 import + 1 interface field + 3 one-liner calls — future merges will have zero conflicts in sdk.ts.

### Bugs discovered during testing

**Bug 1 — `start /WAIT` missing (`pipe-transport.ts`)**
`buildSpawnCmd` injected `start ""` which opened the child window but let `cmd.exe` exit immediately.
`RpcPipeClient` tracks `cmd.exe` → its exit fired `onExit` → session evicted from pool within milliseconds.
Fix: inject `start /WAIT ""` so `cmd.exe` stays alive until the child window exits.
Also added 15s `waitForClient()` timeout — silent hangs now surface as explicit errors.

**Bug 2 — `normalizeTerminalOutput` missing (`tui/utils.ts`)**
Upstream added Thai/Lao AM decomposition to `packages/tui/src/utils.ts`; `tui.ts` imports it.
Without the `utils.ts` update the build fails. Fix: take upstream `utils.ts` wholesale.

---

## Checklist

- [x] `build-binary.ts` — our compact style + upstream worker entrypoints
- [x] `tui.ts` — upstream render-throttle/OSC8/cell-size + our `simulateInput()`
- [x] `utils.ts` — upstream `normalizeTerminalOutput` (required by tui.ts)
- [x] `sdk.ts` — upstream skeleton + 1 import + 1 field + 3 calls (wiring in corp-sdk-extensions.ts)
- [x] `corp-sdk-extensions.ts` — new file: all extension wiring isolated here
- [x] `pipe-transport.ts` — `start /WAIT ""` fix + 15s handshake timeout
- [x] Build passes clean (357,136,896 bytes)
- [x] ESC tests: 7/7 pass
- [x] mtuicontrol spawn/prompt/ESC/stop: all verified ✅
- [ ] **Await explicit approval before `git commit` on `merge/v14.9.9`**
- [ ] **Await explicit approval before `git merge` into `aws-corp`**