# Merge Plan: upstream v15.0.0 → aws-corp

**Branch:** `merge/v15.0.0` (created from `aws-corp` at `605180895`)  
**Upstream:** `origin/main` (v15.0.0, tip `433ba6c66`)  
**Merge base:** `eef5e7ee3` (v14.9.9 — last upstream merge point)  
**Upstream commits ahead of base:** 243  
**Date:** 2026-05-14  
**Status:** Session 2 complete — TUI tests in progress (T1–T6 PASS, T9–T14 PENDING). Awaiting final test confirmation before commit approval.

---

## Repository & File Locations

### Repository
| Path | Purpose |
|------|---------|
| `D:\.ai\research\omp\.oh-my-pi\` | Main repo root (`git worktree` or clone) |
| `D:\.ai\research\omp\.oh-my-pi\packages\coding-agent\` | Primary package — all source, tests, scripts |
| `D:\.ai\research\omp\.oh-my-pi\packages\coding-agent\src\` | TypeScript source |
| `D:\.ai\research\omp\.oh-my-pi\packages\coding-agent\test\` | Test suite |
| `D:\.ai\research\omp\.oh-my-pi\packages\coding-agent\scripts\` | Build scripts |
| `D:\.ai\research\omp\.oh-my-pi\packages\coding-agent\binaries\` | Deploy-ready binaries (what `deploy.cmd` reads) |
| `D:\.ai\research\omp\.oh-my-pi\packages\coding-agent\dist\` | Local build output (intermediate — **not** what deploy.cmd reads) |

### Build & Deploy Scripts
| Script | Location | Purpose |
|--------|----------|---------|
| `build.cmd` | `D:\.ai\research\omp\build.cmd` | **Canonical build** — runs `bun install`, embeds native addons, compiles to `binaries/omp-aws-corp.exe`. **Always use this.** |
| `deploy.cmd` | `D:\.ai\research\omp\deploy.cmd` | Copies `binaries/omp-aws-corp.exe` → `%LOCALAPPDATA%\omp\omp.exe` and copies launcher scripts |
| `build-binary.ts` | `packages/coding-agent/scripts/build-binary.ts` | Inner build script invoked by `build.cmd`; also writes to `dist/omp.exe` and (post-this-merge) copies to `binaries/omp-aws-corp.exe` |

**Critical:** `bun run build` in `packages/coding-agent/` outputs to `dist/omp.exe` only. `deploy.cmd` reads from `binaries/omp-aws-corp.exe`. These diverged during this merge session — fixed by adding a post-build copy step to `build-binary.ts` and syncing `build.cmd` flags.

### Deployed Binary
| Location | Purpose |
|----------|---------|
| `%LOCALAPPDATA%\omp\omp.exe` → `C:\Users\common\AppData\Local\omp\omp.exe` | Live binary used by `o.cmd` and `ow.cmd` |

**Current deployed binary (2026-05-15 session 2):**
| Property | Value |
|----------|-------|
| SHA256 | `bed78f962f3b57468110c04031728c0763c15d007b8e1a6f9b1c77f50d830c75` |
| Size | 338,215,424 bytes |
| Modified | 2026-05-15 14:48:04 |
| Artifact | `binaries/omp-aws-corp.exe` (identical — same SHA) |

### Launcher Scripts (deployed)
| Script | Config dir | Purpose |
|--------|-----------|---------|
| `C:\Users\common\AppData\Local\omp\o.cmd` | `%USERPROFILE%\.omp\agent\` | Standard session launcher (`o` command) |
| `C:\Users\common\AppData\Local\omp\ow.cmd` | `%USERPROFILE%\.omp\agent-work\` | Work session launcher (`ow` command) |

### Config Files
| File | Purpose |
|------|---------|
| `C:\Users\common\.omp\agent\config.yml` | Config for `o` sessions — mmemory **enabled: true** |
| `C:\Users\common\.omp\agent-work\config.yml` | Config for `ow` sessions — mmemory **enabled: true** (restored during this session; see bug below) |
| `C:\Users\common\.omp\agent\models.yml` | Model definitions for `o` sessions |
| `C:\Users\common\.omp\agent-work\models.yml` | Model definitions for `ow` sessions |
| `C:\Users\common\.omp\agent\keybindings.json` | Keybindings |
| `C:\Users\common\.omp\agent-work\settings.json` | Runtime settings (legacy/deprecated path) |

### Session & Log Files
| File | Purpose |
|------|---------|
| `C:\Users\common\.omp\logs\omp.2026-05-14.log` | Today's structured JSON log (all processes, all pids) |
| `C:\Users\common\.omp\agent\` | Session data, pycache, plugin lock for `o` sessions |
| `C:\Users\common\.omp\agent-work\mmemory\` | mmemory knowledge base for work sessions |
| `D:\.ai\knowledge\projects\omp_memory\` | mmemory storage root for the OMP project |

### Source Files Changed in This Merge
| File | Nature of change |
|------|-----------------|
| `packages/coding-agent/package.json` | Version bump 14.9.9 → 15.0.0 |
| `packages/coding-agent/scripts/build-binary.ts` | BUILD_TIME define + upstream flags + post-build copy to `binaries/` |
| `packages/coding-agent/src/capability/skill.ts` | Additive: our `role`/`tools` + upstream `hide` |
| `packages/coding-agent/src/exec/bash-executor.ts` | Additive: our Windows helpers + upstream output-meta imports |
| `packages/coding-agent/src/extensibility/extensions/runner.ts` | Additive: our task depth + upstream credential-disabled buffering |
| `packages/coding-agent/src/main.ts` | 3-arg `runRpcMode`; **`--no-memory` bug fix** (`set` → `override`) |
| `packages/coding-agent/src/modes/interactive-mode.ts` | Upstream plan-mode resolve/compact enhancements |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | 3-param signature; our pipe transport + upstream `rpc-ui`/`PI_NOTIFICATIONS` |
| `packages/coding-agent/src/modes/rpc/rpc-client.ts` | Two bug fixes (not a conflict file): `Parameters<typeof this.#send>` → `RpcCommandBody`; `state.streaming` → `state.isStreaming` |
| `packages/coding-agent/src/sdk.ts` | Upstream skeleton + 3 corp call sites |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | Type rename; our 3 commands; **`handle` → `handleTui`** for mmemory/mprune/mreview |
| `packages/coding-agent/src/corp-sdk-extensions.ts` | Unchanged from v14.9.9 |
| `bun.lock` | Two unresolved conflict markers fixed manually |
| `D:\.ai\research\omp\build.cmd` | Synced flags: `--no-compile-autoload-tsconfig`, `--no-compile-autoload-package-json`, `--keep-names` |
| `test/system-prompt-templates.test.ts` | Upstream Windows path normalization test fix |

---

## Rules

- All work is done on `merge/v15.0.0` only — **never directly on `aws-corp`**
- `aws-corp` accepts merges only — no direct commits
- No commit or merge without explicit user approval
- Build must pass clean before merge is proposed
- **Always use `build.cmd`** (not `bun run build`) — `build.cmd` writes to `binaries/omp-aws-corp.exe` which is what `deploy.cmd` reads

---

## Conflict Files (11)

All 11 conflicts were resolved in the working tree.

### 1. `packages/coding-agent/package.json`

**Verdict: TRIVIAL — take upstream version**

| Side | Change |
|------|--------|
| **Ours** | `14.9.9` |
| **Upstream** | `15.0.0` |

**Resolution:** Take upstream version `15.0.0`.

---

### 2. `packages/coding-agent/scripts/build-binary.ts`

**Verdict: TRIVIAL — merge both sides**

| Side | Change |
|------|--------|
| **Ours** | `BUILD_TIME` define (compact inline style) |
| **Upstream** | Reformatted args to one-per-line; added 4 new flags: `--no-compile-autoload-bunfig`, `--no-compile-autoload-dotenv`, `--no-compile-autoload-tsconfig`, `--no-compile-autoload-package-json`, `--keep-names`; worker entrypoints already present from v14.9.9 merge |

**Resolution:** Keep upstream's new autoload-suppression flags + `--keep-names` flag. Preserve our `BUILD_TIME` define (added as `"--define", \`process.env.BUILD_TIME="${buildTime}"\``). Worker entrypoints were already resolved in v14.9.9.

**Additional fix (post-conflict):** Added post-build copy step — `build-binary.ts` now copies `dist/omp.exe` → `binaries/omp-aws-corp.exe` on Windows after compilation. This prevents `deploy.cmd` from picking up a stale binary when `bun run build` is used directly.

---

### 3. `packages/coding-agent/src/capability/skill.ts`

**Verdict: TRIVIAL — additive merge**

| Side | Change |
|------|--------|
| **Ours** | Added `role?: string` and `tools?: string[]` to `SkillFrontmatter` |
| **Upstream** | Added `hide?: boolean` to `SkillFrontmatter` |

**Resolution:** Both fields added — no semantic overlap.

---

### 4. `packages/coding-agent/src/exec/bash-executor.ts`

**Verdict: TRIVIAL — additive merge**

| Side | Change |
|------|--------|
| **Ours** | Added `normalizeCommandForWindows` import + `normalizeCwdForWindows` helper |
| **Upstream** | Added `resolveOutputMaxColumns` / `resolveOutputSinkHeadBytes` import; made `buildMinimizerOptions` exported |

**Resolution:** Both sets of imports and the export modifier added cleanly.

---

### 5. `packages/coding-agent/src/extensibility/extensions/runner.ts`

**Verdict: TRIVIAL — additive merge**

| Side | Change |
|------|--------|
| **Ours** | Added `#taskDepth`, `setTaskDepth()`, `getTaskDepth()` |
| **Upstream** | Added `CredentialDisabledEvent` import, `#initialized` flag, `#pendingCredentialDisabled` buffer |

**Resolution:** Both additions are orthogonal — no overlap. `executePython` import also added from our side.

---

### 6. `packages/coding-agent/src/main.ts`

**Verdict: TRIVIAL — signature update**

| Side | Change |
|------|--------|
| **Ours** | `runRpcMode(session, eventBus)` |
| **Upstream** | `runRpcMode(session, mode === "rpc-ui" ? setToolUIContext : undefined)` (added `rpc-ui` mode, 2-arg) |

**Resolution:** Combined to `runRpcMode(session, eventBus, mode === "rpc-ui" ? setToolUIContext : undefined)` matching the new 3-arg signature in `rpc-mode.ts`. Both `--rpc-pipe` background invocation and the main invocation updated correctly.

**Additional fix (post-conflict):** `--no-memory` CLI flag bug — see §Bugs section below.

---

### 7. `packages/coding-agent/src/modes/interactive-mode.ts`

**Verdict: MODERATE — upstream refactored plan mode UI**

| Side | Change |
|------|--------|
| **Ours** | No changes to plan mode hook selector |
| **Upstream** | Added `resolve`-based plan approval flow: new `ResolveToolDetails`, `runResolveInvocation`, `PlanApprovalDetails`, `normalizePlanTitle`, `CompactionOutcome` imports; added "Approve and compact context" option to plan approval menu; `SCHEDULE_SLASH_CHANNEL` from event-bus |

**Resolution:** Take upstream's plan-mode enhancements in full — our code has no conflicting changes in this area.

---

### 8. `packages/coding-agent/src/modes/rpc/rpc-mode.ts`

**Verdict: TRIVIAL — signature merge**

| Side | Change |
|------|--------|
| **Ours** | Added `eventBus?: EventBus` parameter + `connectToPipe` / `--rpc-pipe` pipe support |
| **Upstream** | Added `setToolUIContext?` parameter + `rpc-ui` mode support, `PI_NOTIFICATIONS=off` suppression, `process.env.PI_NOTIFICATIONS` guard |

**Resolution:** `runRpcMode` signature expanded to `(session, eventBus?, setToolUIContext?)`. Upstream's `PI_NOTIFICATIONS` suppression and `rpc-ui` wiring added. Our pipe transport preserved.

---

### 9. `packages/coding-agent/src/sdk.ts`

**Verdict: CLEAN — corp isolation pattern held perfectly**

| Side | Change |
|------|--------|
| **Ours** | `corp-sdk-extensions.ts` pattern: 1 import line + 3 call sites |
| **Upstream** | Large refactor: removed `InternalUrlRouter` + 9 `register()` calls → `setActiveSkills`, `setActiveRules`, `AsyncJobManager.setInstance`, `MCPManager.setInstance`; added `CredentialDisabledEvent` buffering; added `resolveAllowedModels` export |

**Resolution:** Upstream's skeleton adopted wholesale. Our three call sites (`populateCorpSkillRoles`, `registerCorpExtensions`, `applyCorpExtensionRunner`) inserted at their correct anchors. Zero conflict in corp logic thanks to the isolation pattern established in v14.9.9.

---

### 10. `packages/coding-agent/src/slash-commands/builtin-registry.ts`

**Verdict: MODERATE — type rename + our commands preserved + runtime type split bug**

| Side | Change |
|------|--------|
| **Ours** | `/mmemory`, `/mprune`, `/mreview` commands + all their handlers (~1500 lines) |
| **Upstream** | Renamed `BuiltinSlashCommandSpec` → `SlashCommandSpec`; renamed `BUILTIN_SLASH_COMMAND_LOOKUP` type; `handleTui` replaces `handle` for `/quit`; various upstream command additions |

**Resolution:** Type rename adopted. Our three custom commands preserved with their full handler implementations. `/quit`'s `handleTui` swap applied.

**Additional fix (post-conflict, critical):** `handle` → `handleTui` for all three of our commands — see §Bugs section below.

---

### 11. `bun.lock`

**Verdict: TRIVIAL — two conflict markers were unresolved; fixed manually**

Two markers remained in the working tree that were NOT caught during initial conflict resolution:
1. Version line (`14.9.9` vs `15.0.0`) at line ~58 — took `15.0.0`
2. Two stale lockfile entries at line ~1310:
   - `@bufbuild/protoplugin/typescript@5.4.5` — removed (upstream dropped it)
   - `@oh-my-pi/typescript-edit-benchmark/@oh-my-pi/pi-coding-agent@14.9.3` — removed (stale version reference)

`bun install` ran cleanly after resolution.

---

## Non-conflict upstream files — notable changes

| File | Upstream change | Status |
|------|----------------|--------|
| `src/modes/rpc/rpc-client.ts` | Added `_sendCommand` escape hatch; renamed `RpcSessionState.streaming` → `isStreaming` | Both fixed — see §Bugs |
| `src/capability/rule.ts` | Added `setActiveRules` export | Used by sdk.ts refactor — resolved |
| `src/extensibility/skills.ts` | Added `setActiveSkills` export | Used by sdk.ts refactor — resolved |
| `crates/pi-iso/` | New crate: filesystem isolation (APFS, btrfs, overlayfs, ZFS, Windows block clone) | Upstream-only, no conflict |
| `packages/stats/` | Stats sync worker, behavior charts, shared types | Upstream-only, no conflict |
| `packages/tui/` | `stdin-buffer`, `terminal-capabilities`, autocomplete improvements | Upstream-only, no conflict |
| `docs/` | Various doc updates | Upstream-only, no conflict |

---

## Bugs Found & Fixed

### Bug 1: `rpc-client.ts` — `Parameters<typeof this.#send>` (pre-existing)

**File:** `packages/coding-agent/src/modes/rpc/rpc-client.ts:296`  
**Origin:** Our `mtuicontol` commit `f0b45cd2f` — pre-dated this merge  
**Symptom:** TypeScript error: `TS1003: Identifier expected` from `tsgo`/`tsc`  
**Root cause:** `Parameters<typeof this.#send>` is not valid TypeScript for private class field method references  
**Fix:** Replace with `RpcCommandBody` — the explicit type alias already used by the `#send` method signature  

---

### Bug 2: `rpc-client.ts` — `state.streaming` → `state.isStreaming` (merge-induced)

**File:** `packages/coding-agent/src/modes/rpc/rpc-client.ts:652`  
**Origin:** Our `mtuicontol` commit used `state.streaming`; upstream v15.0.0 renamed the field to `isStreaming` on `RpcSessionState`  
**Symptom:** TypeScript error; `waitUntilIdle` would silently fail at runtime (condition never true)  
**Fix:** `state.streaming` → `state.isStreaming`  

---

### Bug 3: `system-prompt-templates.test.ts` — Windows path normalization (upstream test bug)

**File:** `packages/coding-agent/test/system-prompt-templates.test.ts:231`  
**Origin:** Upstream v15.0.0 consolidated system prompt from 3-block → 2-block structure and added `resolvedCwd.replace(/\\/g, "/")` normalization in `system-prompt.ts`  
**Symptom:** Test fails on Windows — assertion uses raw Windows backslash path but system prompt emits forward-slash path  
**Fix:** Test line 231: `` `current working directory is '${dir}'.` `` → `` `current working directory is '${dir.replace(/\\/g, "/")}'.` ``  

---

### Bug 4: `main.ts` — `--no-memory` permanently writes `mmemory.enabled: false` to config (critical)

**File:** `packages/coding-agent/src/main.ts:561`  
**Origin:** Pre-existing bug in our aws-corp branch, surfaced by testing  
**Symptom:** Running `ow --no-memory` (as used in TUI tests) permanently disabled mmemory in `agent-work/config.yml`. Every subsequent `ow` session had mmemory disabled even without the flag.  
**Root cause:** `settings.set("mmemory.enabled", false)` writes to `Settings.#global` and queues a background save to disk via `#queueSave()`. This is the **persisted** settings layer.  
**Fix:** Change to `settings.override("mmemory.enabled", false)` — writes to `Settings.#overrides` (in-memory only layer, never saved to disk). The `#overrides` layer wins in the merged view (`#merged = global + project + overrides`) so the session correctly operates without mmemory, but the config file is untouched.  
**Settings architecture (for reference):**
- `settings.set(path, value)` → writes `#global` + marks `#modified` + calls `#queueSave()` → **persists to disk**
- `settings.override(path, value)` → writes `#overrides` only + rebuilds merged view → **session-scoped, never persists**
- `settings.get(path)` → reads `#merged` (global + project + overrides) → overrides win

**Collateral damage repaired:** `C:\Users\common\.omp\agent-work\config.yml` had `mmemory.enabled: false` written by previous sessions using the buggy binary. Manually restored to `true` using Python regex patch.

---

### Bug 5: `builtin-registry.ts` — `handle` → `handleTui` for mmemory/mprune/mreview (critical, merge-induced)

**Files:** `packages/coding-agent/src/slash-commands/builtin-registry.ts` (3 handler registrations)  
**Origin:** v15.0.0 split the unified `SlashCommandRuntime` into two separate types:
- `SlashCommandRuntime` — used by `handle` callbacks (ACP/RPC context) — has `session`, `sessionManager`, `settings` directly; NO `.ctx`
- `TuiSlashCommandRuntime` — used by `handleTui` callbacks (interactive/TUI context) — has `ctx: InteractiveModeContext` which contains the full TUI context

In v14.9.9, there was a single runtime type that had all fields.  

**Symptom:** All `/mmemory`, `/mprune`, `/mreview` slash commands crash at runtime with:
```
[Unhandled Rejection] TypeError: undefined is not an object (evaluating 'runtime.ctx.sessionManager')
    at executeBuiltinSlashCommand (omp-aws-corp.exe:565297:40)
```
This crashes in EVERY call because `executeBuiltinSlashCommand` builds the adapted runtime object immediately (before any handler runs), and `ctx.sessionManager.getCwd()` crashes when `ctx` is the `SlashCommandRuntime` (which lacks `.ctx`).

**Root cause trace:**  
1. Our handlers are registered as `handle: mmemoryHandler` (inherited from v14.9.9 where there was one runtime type)  
2. In v15, `executeBuiltinSlashCommand` calls `spec.handle(command, adapted)` where `adapted` is `SlashCommandRuntime` (no `.ctx`)  
3. Our handlers access `runtime.ctx.sessionManager`, `runtime.ctx.showStatus()`, etc.  
4. `runtime.ctx` → `undefined` → crash  

**Fix:** Change all three registrations from `handle:` to `handleTui:`:
```typescript
// Before (broken in v15):
{ name: "mmemory", handle: mmemoryHandler, ... }
{ name: "mprune",  handle: mpruneHandler,  ... }
{ name: "mreview", handle: mreviewHandler, ... }

// After (correct):
{ name: "mmemory", handleTui: mmemoryHandler, ... }
{ name: "mprune",  handleTui: mpruneHandler,  ... }
{ name: "mreview", handleTui: mreviewHandler, ... }
```

**Why `handleTui` is correct:** All three handlers use TUI-specific context: `runtime.ctx.showStatus()`, `runtime.ctx.showWarning()`, `runtime.ctx.editor`, `runtime.ctx.chatContainer`, `runtime.ctx.sessionManager.getCwd()`, etc. They require the full `InteractiveModeContext` and should only run in interactive/TUI mode.

---

### Bug 6: `build.cmd` missing flags vs `build-binary.ts` (infrastructure)

**File:** `D:\.ai\research\omp\build.cmd`  
**Origin:** `build-binary.ts` was updated in this merge to add 3 new Bun compile flags (`--no-compile-autoload-tsconfig`, `--no-compile-autoload-package-json`, `--keep-names`) but `build.cmd` was not synced.  
**Fix:** Added the 3 missing flags to `build.cmd`'s `bun build --compile` invocation.

---

### Bug 7: `deploy.cmd` reads `binaries/`, not `dist/` (infrastructure, discovered during testing)

**Symptom:** After running `bun run build` (which outputs to `dist/omp.exe`), running `deploy.cmd` deployed the old binary — no change visible.  
**Root cause:** `deploy.cmd` reads from `packages/coding-agent/binaries/omp-aws-corp.exe`. `bun run build` writes to `packages/coding-agent/dist/omp.exe`. These are different paths that can diverge.  
**Fix:**  
1. `build-binary.ts` now copies `dist/omp.exe` → `binaries/omp-aws-corp.exe` after compilation (Windows only)  
2. Rule established: **always use `build.cmd`** — it writes directly to `binaries/omp-aws-corp.exe` and includes `bun install`  

---

## Session 2 Corp Modifications (2026-05-15)

All changes in `packages/coding-agent/src/`. Session 2 built binary `bed78f96` (338,215,424 bytes, 2026-05-15 14:48:04).

### Upstream files (minimal footprint)

| # | File | Change |
|---|------|--------|
| 1 | `cli/args.ts` | Added `--rpc-pipe` to arg parser so the TCP port number is consumed and never falls through as an initial user message to the slave |
| 2 | `modes/interactive-mode.ts` | Added `[main] interactive mode {version}` log at startup; added `SCHEDULE_SLASH_CHANNEL` debug logging (`[interactive] SCHEDULE_SLASH_CHANNEL` + `[interactive] SCHEDULE_SLASH executing`); added `showStatus`/`showError`/`showWarning` emit to `PIPE_TUI_OUTPUT_CHANNEL` |
| 3 | `modes/rpc/rpc-mode.ts` | Subscribe to `PIPE_TUI_OUTPUT_CHANNEL` and forward as `{type:"tui_output"}` frames through pipe; wired `handleRpcExecCommand` in default case |
| 4 | `modes/rpc/rpc-client.ts` | Added `"tui_output"` to `agentEventTypes` so tui_output frames flow through `onEvent` |
| 5 | `main.ts` | Added `[main] interactive mode {version}` log + `[main] headed+pipe mode {version, pipeArg}` log at session start |

### Our files (no upstream restriction)

| # | File | Change |
|---|------|--------|
| 6 | `utils/event-bus.ts` | Added `PIPE_TUI_OUTPUT_CHANNEL = "tui:pipe-output"` and `TuiOutputPayload` type |
| 7 | `modes/rpc/rpc-inject.ts` | Added slave-side exec queue protocol: `RpcExecStep` (prompt/slash/bash/bash_x/python/python_x/keypress/sleep), `RpcExecEnqueueCommand`, `RpcExecInterruptCommand`, `isRpcExecCommand` |
| 8 | `modes/rpc/rpc-inject-handler.ts` | Added `SlaveExecQueue` + `handleRpcExecCommand`; slave executes steps sequentially using `session.subscribe` for `agent_end` detection; `exec_interrupt` aborts current step and clears queue; `registerInputController` now includes `injectCommand` in parameter type; `InjectHandlerSession` extended with optional `waitForIdle` and `subscribe` |
| 9 | `modes/rpc/rpc-inject-client.ts` | Added `onTuiOutput()` (filters `onEvent` for `tui_output` type); added `enqueueExec(steps)` and `execInterrupt()` methods |
| 10 | `extensibility/extensions/m-mtuicontrol-extension.ts` | `sessionAsyncOutput` map for per-session async followUp callbacks; `handleMtuicontrol` accepts `asyncFollowUp` parameter (passed from builtin-registry); spawn stores asyncFollowUp and registers persistent `onTuiOutput` listener (forwards slave showStatus/showError/showWarning as `[slave:status/error/warning]`), registers `tool_execution_end` forwarding (`[slave:tool:toolName]`), registers `turn_end` LLM response forwarding (`[slave:response]`); prompt timeout raised from 25s to 60s default with hard cap removed — master passes `--timeout N`; new `exec` action (steps separated by `\|`, `\:` escapes colon in body, `:<N>` per-step hard timeout); new `interrupt` action (sends `exec_interrupt` to slave) |
| 11 | `slash-commands/builtin-registry.ts` | Passes `asyncFollowUp` callback to `handleMtuicontrol` |

### New log entries (binary `bed78f96`)

| Log line | When emitted |
|----------|-------------|
| `[main] interactive mode {version: '15.0.0'}` | Every session start |
| `[main] headed+pipe mode {version: '15.0.0', pipeArg: 'PORT'}` | Slave start with `--rpc-pipe` |
| `[interactive] SCHEDULE_SLASH_CHANNEL {command, hasOnSubmit}` | mcommand fires |
| `[interactive] SCHEDULE_SLASH executing {command}` | Command actually runs |
| `[mtuicontrol] keypress {id, seq, count}` | Keypress injection |
| `[mtuicontrol] command injected {id, cmd}` | Slash command injection |
| `[mtuicontrol] tui_output {id, text}` | Slave TUI output forwarded |
| `[mtuicontrol] child tool_end {id, tool, preview}` | Slave tool execution result |
| `[mtuicontrol] exec enqueued {id, steps}` | Exec steps queued on slave |
| `[rpc-inject] exec step {type}` | Each step executing on slave |
| `[rpc-inject] exec output {label, preview}` | Step output collected |

---

## TUI Test Results (interactive, via `mtuicontrol`)

Tests run against deployed binary using the parent `ow` session's mtuicontrol extension. Each test uses `/mtuicontrol spawn --cmd "cmd.exe /c ow --new --no-memory"` to create child sessions.

**Every test is ONLY considered passing when BOTH are true:**
1. The expected follow-up text appeared in the terminal
2. The log file confirms the expected internal state

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| Pre  | Clean state (`stop --all` + `list`) | ✅ PASS | |
| T1   | Spawn child session | ✅ PASS | Log: `[mtuicontrol] spawned {id: rpc-1778868991648-plrm, childPid: 15960}`; slave received NO port number as input (`--rpc-pipe` fix confirmed) |
| T3   | Slash command injection (`/copy`) | ✅ PASS | Follow-up: `Command "/copy" scheduled.` + `[slave:error] No agent messages to copy yet.`; Log: `[mtuicontrol] command injected`, `[mtuicontrol] tui_output`. Note: now returns `[slave:error]` prefix via `PIPE_TUI_OUTPUT_CHANNEL` → `rpc-mode` → `tui_output` frame → `onTuiOutput` |
| T4   | Keypress ESC (idle) | ✅ PASS | Log: `[mtuicontrol] keypress {seq: '<ESC>', count: 1}` |
| T5   | Keypress CTRL-C | ✅ PASS | Follow-up: `Injected 1 key(s).` |
| T6   | Keypress ESC+ESC | ✅ PASS | Follow-up: `Injected 2 key(s).`; exec queue required — slave was busy executing `sleep 30`, keys injected via exec queue sequencing (`prompt:…:35000\|sleep:2000\|keypress:<ESC><ESC>`) |
| T9   | Spawn A + Spawn B + list | ⏳ PENDING | |
| T10a | Stop single session + list | ⏳ PENDING | |
| T10b | `stop --all` + list (pool empty) | ⏳ PENDING | |
| T11  | ID defaulting single | ⏳ PENDING | |
| T12  | ID defaulting multi (last-wins) | ⏳ PENDING | |
| T2   | Prompt/response ⚠️ AWS creds | ⏳ PENDING | |
| T7   | ESC regression ⚠️ AWS creds | ⏳ PENDING | |
| T8   | wait auto-escalation ⚠️ AWS creds | ⏳ PENDING | |
| T13  | `/mmemory recall` (parent session) | ⏳ PENDING | |
| T14  | `/mreview` (parent session) | ⏳ PENDING | |
| --nm | `--no-memory` config persistence | ⏳ PENDING | |

**T7/T8 notes:** `wait` was removed from the public API. `prompt --timeout` exercises the same ESC-escalation path internally. See MERGE-INSTRUCTIONS §T7/T8 for exact commands.

**exec command syntax (T6, T7 and multi-step tests):**
```
/mtuicontrol exec [id] prompt:use bash to run\: sleep 30:35000|sleep:2000|keypress:<ESC><ESC>
```
- Steps separated by `|` (escape as `\|`)
- Last `:<N>` on each step = hard timeout in ms (default 60000)
- `\:` = literal colon in step body
- Step types: `prompt` `slash` `bash` `bash_x` `python` `python_x` `keypress` `sleep`
- Interrupt: `/mtuicontrol interrupt [id]`
---

## Automated Test Results

### m-family tests (all 9 files)
```
bun test test/m-prompt-template-memory-strip.test.ts test/mprune-batch.test.ts \
  test/mprune-images.test.ts test/mprune-prompt.test.ts test/mprune-stats.test.ts \
  test/mprune-trim.test.ts test/mtuicontrol-esc.test.ts test/prompt-templates.test.ts \
  test/system-prompt-templates.test.ts
```
**Result: 169 pass, 7 skip, 0 fail** ✅

### Binary-dependent tests (4 files, with `OMP_BINARY` set)
```
OMP_BINARY="C:/Users/common/AppData/Local/omp/omp.exe" bun test \
  test/mtuicontrol-esc.test.ts test/rpc.test.ts \
  test/rpc-client.start.test.ts test/rpc-host-tools.test.ts
```
**Result: 11 pass, 13 skip, 0 fail** ✅

The 13 skips are in `rpc.test.ts` — guarded by `describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))`. These are live E2E tests requiring a real Anthropic API key. Not a blocker.

**Bun version note:** `rpc-client.start.test.ts` launches `src/cli.ts` via local `bun`. The binary requires Bun ≥1.3.14. Local Bun was upgraded from 1.3.13 → 1.3.14 via `bun upgrade` during this session to unblock this test.

---

## `--no-memory` Flag Verification

**After Bug 4 fix and deploy (binary 16:20):**

| Check | Expected | Actual |
|-------|----------|--------|
| Config before spawn (no flag) | `mmemory.enabled: true` | ✅ true |
| Spawn `ow --no-memory` | Session starts, mmemory suppressed | ✅ Session starts |
| Config DURING `ow --no-memory` session | `mmemory.enabled: true` (unchanged) | ✅ true — verified 2026-05-14 |
| Config AFTER `ow --no-memory` session stops | `mmemory.enabled: true` (unchanged) | ✅ true — verified 2026-05-14 |
| Spawn `ow` (no flag) | mmemory active: log shows `snippetLen > 0` | ✅ Verified: `snippetLen=3376` at startup |

The `ow` session without `--no-memory` confirms mmemory IS loading (Bug 4 fix + config restore both worked). Persistence verified 2026-05-14: `agent-work/config.yml` read directly via Python shows `mmemory.enabled=True` before, during, and after `--no-memory` child spawns.

---

## Build History (this session)

| Time | Binary | What changed |
|------|--------|-------------|
| Earlier session | `binaries/omp-aws-corp.exe` 2026-05-12 | Baseline — pre-merge |
| 15:34 | `dist/omp.exe` (NOT deployed — wrong path) | First build: rpc-client.ts fixes, system-prompt test fix |
| 16:06 | `binaries/omp-aws-corp.exe` (first successful deploy) | Fixed: `bun.lock` conflict markers resolved; build via `build.cmd` |
| 16:20 (2026-05-14) | `binaries/omp-aws-corp.exe` → deployed | Fixed: `--no-memory` persistence (Bug 4), `handle → handleTui` (Bug 5) |
| 14:48 (2026-05-15) | `binaries/omp-aws-corp.exe` → deployed | Session 2: exec queue, tui_output forwarding, `--rpc-pipe` fix, mtuicontrol exec/interrupt actions, asyncFollowUp. SHA256: `bed78f962f3b57468110c04031728c0763c15d007b8e1a6f9b1c77f50d830c75`, 338,215,424 bytes |
---

## Execution Notes

**Corp isolation pattern:** Same approach as v14.9.9. All corp-specific wiring lives in `corp-sdk-extensions.ts` (1 import in `sdk.ts` + 3 one-liner calls). Zero corp footprint in upstream files except those 3 anchors and the 3 slash command registrations.

**Bun compile flags (canonical set after this merge):**
```
bun build --compile
  --no-compile-autoload-bunfig
  --no-compile-autoload-dotenv
  --no-compile-autoload-tsconfig
  --no-compile-autoload-package-json
  --keep-names
  --define PI_COMPILED=true
  --define "process.env.PI_COMPILED=\"true\""
  --define "process.env.BUILD_TIME=\"...\""
  --root .
  --external mupdf
  --target bun-windows-x64-modern
  ./packages/coding-agent/src/cli.ts
  --outfile binaries/omp-aws-corp.exe
```

---

## Checklist

- [x] `package.json` — version 15.0.0
- [x] `build-binary.ts` — our `BUILD_TIME` define + upstream's 4 new autoload-suppression flags + `--keep-names` + post-build copy to `binaries/`
- [x] `skill.ts` — our `role`/`tools` + upstream's `hide` field
- [x] `bash-executor.ts` — our Windows normalize helpers + upstream's output-meta imports + exported `buildMinimizerOptions`
- [x] `runner.ts` — our `setTaskDepth`/`getTaskDepth` + upstream's credential-disabled buffering
- [x] `main.ts` — 3-arg `runRpcMode` call; `--no-memory` uses `settings.override` (not `settings.set`); session-start version logs
- [x] `interactive-mode.ts` — upstream plan-mode UI additions (resolve-based approval, "compact" option); SCHEDULE_SLASH_CHANNEL logging; showStatus/showError/showWarning → PIPE_TUI_OUTPUT_CHANNEL
- [x] `rpc-mode.ts` — 3-param signature: `(session, eventBus?, setToolUIContext?)` + upstream's `PI_NOTIFICATIONS` guard; PIPE_TUI_OUTPUT_CHANNEL → tui_output frame; handleRpcExecCommand wired
- [x] `sdk.ts` — upstream skeleton + 3 corp call sites unchanged
- [x] `builtin-registry.ts` — type rename + our 3 slash commands preserved + `handle` → `handleTui` for mmemory/mprune/mreview; passes `asyncFollowUp` to handleMtuicontrol
- [x] `bun.lock` — 2 conflict markers resolved; `bun install` clean
- [x] `rpc-client.ts` — `Parameters<typeof this.#send>` → `RpcCommandBody`; `state.streaming` → `state.isStreaming`; `"tui_output"` added to agentEventTypes
- [x] `system-prompt-templates.test.ts` — Windows forward-slash normalization fix
- [x] `corp-sdk-extensions.ts` — unchanged from v14.9.9 (no new corp wiring needed)
- [x] `build.cmd` — flags synced: `--no-compile-autoload-tsconfig`, `--no-compile-autoload-package-json`, `--keep-names`
- [x] `build-binary.ts` — post-build copy to `binaries/omp-aws-corp.exe`
- [x] `agent-work/config.yml` — `mmemory.enabled` restored to `true`
- [x] Build via `build.cmd` — clean, 338,215,424 bytes `binaries/omp-aws-corp.exe` (SHA256: `bed78f962f3b57468110c04031728c0763c15d007b8e1a6f9b1c77f50d830c75`, 2026-05-15 14:48:04)
- [x] m-family tests: **169 pass, 7 skip, 0 fail**
- [x] Binary TUI/RPC tests: **11 pass, 13 skip, 0 fail**
- [x] `cli/args.ts` — `--rpc-pipe` consumed by arg parser (no port leak to slave)
- [x] `utils/event-bus.ts` — `PIPE_TUI_OUTPUT_CHANNEL` + `TuiOutputPayload`
- [x] `modes/rpc/rpc-inject.ts` — exec queue wire protocol (`RpcExecStep`, enqueue/interrupt commands)
- [x] `modes/rpc/rpc-inject-handler.ts` — `SlaveExecQueue`, `handleRpcExecCommand`, interrupt support
- [x] `modes/rpc/rpc-inject-client.ts` — `onTuiOutput()`, `enqueueExec()`, `execInterrupt()`
- [x] `extensibility/extensions/m-mtuicontrol-extension.ts` — exec/interrupt actions, asyncFollowUp, tui_output forwarding, tool_end/turn_end forwarding, 60s timeout default
- [x] TUI Pre: ✅ PASS
- [x] TUI T1 (spawn): ✅ PASS
- [x] TUI T3 (slash command injection): ✅ PASS
- [x] TUI T4 (ESC keypress idle): ✅ PASS
- [x] TUI T5 (CTRL-C keypress): ✅ PASS
- [x] TUI T6 (ESC+ESC via exec queue): ✅ PASS
- [ ] TUI T9 (spawn A + B + list): **PENDING**
- [ ] TUI T10a (stop single + list): **PENDING**
- [ ] TUI T10b (`stop --all` + list empty): **PENDING**
- [ ] TUI T11 (ID defaulting single): **PENDING**
- [ ] TUI T12 (ID defaulting multi last-wins): **PENDING**
- [ ] TUI T2 (prompt/response ⚠️ AWS creds): **PENDING**
- [ ] TUI T7 (ESC regression ⚠️ AWS creds): **PENDING**
- [ ] TUI T8 (wait auto-escalation ⚠️ AWS creds): **PENDING**
- [ ] TUI T13 (`/mmemory recall` parent session): **PENDING**
- [ ] TUI T14 (`/mreview` parent session): **PENDING**
- [ ] `--no-memory` persistence check: **PENDING**
- [ ] **Await explicit approval before `git commit` on `merge/v15.0.0`**
- [ ] **Await explicit approval before `git merge` into `aws-corp`**
