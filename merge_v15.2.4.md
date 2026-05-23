# Merge Record: upstream v15.2.4 → aws-corp

**Branch:** `merge/v15.2.4`  
**Last merge base:** `merge/v15.1.3` (tag `8055462ce`)  
**Upstream target:** v15.2.4 (tag `6ca92dd08` on `origin/main`)  
**aws-corp HEAD at start:** `1c19d7bb0`  
**Date:** 2026-05-22  
**Status:** COMPLETE — staged on `merge/v15.2.4`, awaiting commit approval

---

## Execution Log

| Step | Status | Notes |
|------|--------|-------|
| Merge base check | ✓ | NON-LINEAR — v15.1.3 and v15.2.4 on divergent upstream branches; common ancestor from Jan 2026 |
| Branch `merge/v15.2.4` created | ✓ | From `aws-corp` at `1c19d7bb0` |
| `git merge v15.2.4` | ✓ | 256 add/add conflicts — expected for non-linear topology |
| Bulk `--theirs` for non-AWS-CORP files | ✓ | 215 files; 41 AWS-CORP files resolved manually |
| `session/compaction/*.ts` | ✓ | Taken from aws-corp (upstream moved path to `packages/agent/`) |
| `interactive-mode.ts` resolved | ✓ | Upstream skeleton + our 4 waitForInputReady insertion points |
| `sdk.ts` resolved | ✓ | Upstream skeleton + `export { completeSimple }` re-inserted |
| `builtin-registry.ts` resolved | ✓ | Upstream `/fast` description change; our commands untouched |
| `agent-session.ts` resolved | ✓ | Upstream skeleton — then upstream `kind: "execute"` + `commandContent` re-applied (caught by test) |
| `settings-schema.ts` spreads | ✓ | Our imports + spreads (MMEMORY/PRUNE/SCRIPT) re-applied after merge took upstream |
| `isFastModeEnabled` → `isFastModeActive` | ✓ | Upstream renamed to getter; updated in `agent-session.ts`, `builtin-registry.ts`, `segments.ts` |
| New settings keys | ✓ | `tui.hyperlinks`, `display.shimmer` added from upstream v15.2.4 |
| `bun tsc --noEmit` clean | ✓ | Zero errors |
| AWS-CORP change verification | ✓ | All 22 checks pass |
| `build.cmd --build-native` | ✓ | Required — v15.2.4 changed native version sentinel; old `.node` files rejected |
| Test suite | ✓ | m-family 119/119 pass; acp-agent + acp-permission fixed; 10 pre-existing EBUSY failures confirmed unchanged |
| `deploy.cmd` updated | ✓ | Added versioned natives path `~/.omp/natives/15.2.4/` + both baseline/modern `.node` files |
| Deploy + bundle | ✓ | `deploy.cmd`, `deploy-graphify.cmd`, `bundle.cmd`, `bundle-graphify.cmd` all ran clean |

---

## Merge Strategy Used

**NON-LINEAR** — `git merge v15.2.4` from `aws-corp`. 256 add/add conflicts because the common
ancestor predates both tags by ~4 months. Strategy:
- `git checkout --theirs` for the ~215 non-AWS-CORP conflicted files
- Manual 3-way resolution for the 41 AWS-CORP files
- Verified: `git diff --name-status aws-corp merge/v15.2.4 | grep "^A"` = 36 files (all genuine upstream additions)

**Earlier failed attempts (documented to avoid repeating):**
1. First run: used `git checkout --theirs` on files that had AWS-CORP changes (exclusion list had only 11 files instead of 44). Resulted in dropped aws-corp additions. Aborted.
2. Second attempt: branched from `v15.2.4` tree and patched our diff on top. Produced 174 phantom additions vs aws-corp — wrong direction. Aborted and reset.
3. Third attempt (correct): branched from `aws-corp`, built complete 44-file AWS-CORP exclusion set via `git grep -l 'AWS-CORP' aws-corp`, resolved properly. Clean.

---

## Conflicts and Resolutions

### `interactive-mode.ts` (+131 upstream lines)
Upstream added: shimmer animations, `resolvePlanTitle` (renamed from `normalizePlanTitle`),
loop/goal state machine refactors, `#deferLoopAutoSubmit`, `#isLoopAutoSubmitBlocked`,
`renderWorkingMessage`, `#getWorkingMessageAccent`.

**Resolution:** Took upstream skeleton wholesale. Re-applied our 4 insertion points:
- `#inputReadyResolvers: (() => void)[] = []` field
- `waitForInputReady(): Promise<void>` method
- `getUserInput()` resolver firing
- SCHEDULE_SLASH `.then(() => this.waitForInputReady())` chain

Our changes were in different methods — no direct line-level conflict.

### `sdk.ts` (+120 upstream lines)
Upstream added: yield-queue batching (`buildAsyncResultBatchMessage`, `buildMcpNotificationBatchMessage`,
`session.yieldQueue`), `cwd` live getter.

**Resolution:** Took upstream skeleton. Re-inserted `export { completeSimple }` line.

**Note:** We kept our aws-corp version of the async delivery path (our `sendCustomMessage` / `followUp`
calls) rather than adopting upstream's yield-queue. The yield-queue is new upstream infrastructure —
adopting it would require broader changes. This is a known delta vs upstream.

### `agent-session.ts` (real conflict — both sides changed same area)
Upstream added: `kind: "execute"` and `commandContent` to bash permission requests.
We had taken aws-corp wholesale initially, missing these changes.

**Caught by:** `agent-session-acp-permission.test.ts` failure.
**Fix:** Re-applied upstream's `command` extraction + `commandContent` build + `kind: "execute"` spread.

### `session/compaction/*.ts` (dir-rename conflict)
Upstream moved these from `packages/coding-agent/src/session/compaction/` to
`packages/agent/src/compaction/`. The dir-rename created conflicts.

**Resolution:** Took our aws-corp versions (our path is correct for our build structure).

### `settings-schema.ts`
Auto-merged to upstream version, silently dropping our import/spread lines.
**Fix:** Re-inserted:
```typescript
import { MMEMORY_SCHEMA_ENTRIES, type MmemorySettings } from "./settings-schema-m-extensions";
import { PRUNE_SCHEMA_ENTRIES } from "./settings-schema-m-prune";
import { SCRIPT_SCHEMA_ENTRIES } from "./settings-schema-m-scripts";
// + spreads + mmemory in GroupTypeMap
```
Also added upstream's new keys: `tui.hyperlinks`, `display.shimmer`.

### `acp-agent.test.ts`
Our `skills.ts` path normalization (`replace(/\\/g, "/")`) caused test failure — test expected
Windows backslashes but our code now produces forward slashes.
**Fix:** Updated assertion: `` `Skill: ${skillPath.replace(/\\/g, "/")}` ``

---

## Surprises / Deviations from Plan

### `deploy.cmd` required update (not anticipated)
v15.2.4 changed the native addon loader — binary now validates a version sentinel
`__piNativesV15_2_4` and looks for `.node` files at `~/.omp/natives/15.2.4/` (versioned
path) rather than `%LOCALAPPDATA%\omp\`. The old `.node` at the flat path fails with:
```
does not expose the @oh-my-pi/pi-natives@15.2.4 version sentinel
```
**Fix:** Updated `deploy.cmd` to:
1. Read version from `packages/natives/package.json`
2. Create `%USERPROFILE%\.omp\natives\%NATIVES_VER%\`
3. Copy both `baseline` and `modern` `.node` files there

**Add to future pre-merge checklist:** check if upstream changed `packages/natives/package.json`
version — if yes, `deploy.cmd` versioned path must be updated (or verify it reads dynamically).

### `--build-native` mandatory after this merge
The native Rust addon version changed (sentinel `__piNativesV15_2_4`). Without `--build-native`,
the binary starts but immediately crashes with the sentinel mismatch. This is not always required
after a merge — it depends on whether `packages/natives/` changed.

### Non-linear tag topology caused 3 failed merge attempts
See "Earlier failed attempts" above. The correct approach is documented in `.MERGE-INSTRUCTIONS.md`.

### `isFastModeEnabled()` → `isFastModeActive`
Upstream changed from a method to a getter. Affects `agent-session.ts`, `builtin-registry.ts`,
`segments.ts`. tsc caught all call sites.

### Pre-existing test failures confirmed
10 `settings-manager.test.ts` failures are Windows EBUSY (file locking) — confirmed identical
on `aws-corp` before the merge via `git stash`.

---

## New Upstream Features (now in aws-corp)

| Feature | Notes |
|---------|-------|
| Follow-up yield queue (`session.yieldQueue`) | Async job + MCP delivery batched. We kept our sendCustomMessage path. |
| Shimmer animations | ANSI shimmer on loader/spinner; per-session accent colors |
| Worktree list/clear | `/worktree list`, `/worktree clear`, orphan pruning |
| Goal state machine fixes | Drop-before-clear, tool set restoration on thread resume |
| `resolvePlanTitle` | Replaces `normalizePlanTitle`; title inferred from file content |
| OSC 8 hyperlinks | `tui.hyperlinks` setting; clickable file paths in tool output |
| `cwd` live getter | `toolSession.cwd` is now `sessionManager.getCwd()` |
| WSL clipboard paste | Image reads via `powershell.exe` on WSL |
| Native versioning | `.node` files now validated with version sentinel |
