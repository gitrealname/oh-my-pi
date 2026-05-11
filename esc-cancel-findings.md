# ESC Cancellation Delay — Findings & Fix Plan

Branch: `feature/esc-cancel-fix`
Base: `aws-corp` (HEAD `c55e9908f`)
Date: 2026-05-11

---

## Problem

When the `task` tool is mid-execution (running subagent(s)), pressing ESC does not
cancel the operation immediately. The session remains busy until the subagent(s)
finish their current work — which can be tens of seconds into a long tool call.

---

## Signal flow (confirmed correct)

```
ESC keypress
  └─ input-controller.ts:85  → session.abort()          ← general path only; no task fast-path
       └─ agent-session.ts:3762  abortBash()
       └─ agent-session.ts:3763  abortEval()
       └─ agent-session.ts:3765  this.agent.abort()      ← fires AgentLoop AbortSignal
            └─ agent-loop.ts    loop signal.aborted      ← stops scheduling new LLM turns
       └─ agent-session.ts:3767  await waitForIdle()     ← BLOCKS until loop fully drains
```

The `task` tool's `#executeSync` receives the same agent-loop AbortSignal and
passes it to `mapWithConcurrencyLimit` → `runSubprocess`. Inside `runSubprocess`
(executor.ts:612) an `abort` listener fires `requestAbort("signal")` →
`abortController.abort()` → `void activeSession.abort()`. So the signal IS
correctly wired into the subagent session.

The latency comes from what happens after `activeSession.abort()`:
1. The child session flush (writes session to disk)
2. `session.dispose()` — waits up to 5 s (executor.ts:1180)
3. `runSubprocess` resolves and returns a `SingleResult`
4. `mapWithConcurrencyLimit` worker loop iteration ends
5. `waitForIdle()` in `agent-session.ts:3767` resolves
6. Only now does the UI unblock

---

## Bugs / gaps

### Bug #3 — `mapWithConcurrencyLimit` awaits in-flight task to completion (HIGH)

**File**: `packages/coding-agent/src/task/parallel.ts`

```typescript
// worker loop — signal only checked at the TOP of each iteration
while (true) {
    if (workerSignal.aborted) return;   // ← checked here
    const index = nextIndex++;
    results[index] = await fn(items[index], index);  // ← NOT interrupted when signal fires mid-await
}
```

When `signal` aborts while `fn` (= `runSubprocess`) is still executing, the worker
does not race against the abort — it awaits `runSubprocess` to full resolution.
`runSubprocess` handles the abort internally (calls `activeSession.abort()`) but
still goes through its full teardown (session flush + 5 s dispose timeout) before
resolving. The caller waits for all of this.

**Fix**: wrap `await fn(...)` in `Promise.race` against the abort signal.
`runSubprocess` already handles internal teardown; the race just lets the
concurrency worker return a sentinel immediately while teardown finishes in the
background. The `SingleResult` shape has `aborted: true` for this case.

### Bug #4 — No SIGKILL escalation after subagent abort timeout (MEDIUM)

**File**: `packages/coding-agent/src/task/executor.ts`

`executor.ts:1180` disposes the session with a 5 s timeout:
```typescript
await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
```
But if `session.dispose()` hangs (e.g. waiting on a network call or DB flush),
there is no follow-up force-kill. The 5 s window is correct but no escalation
occurs after it.

**Fix**: after `untilAborted` resolves (with or without timeout), force-abort any
remaining in-flight work via a secondary `AbortController`.

### Bug #2 — No `#taskAbortControllers` set in `agent-session.ts` (MEDIUM)

**File**: `packages/coding-agent/src/session/agent-session.ts`

bash and eval tools have dedicated abort controller sets:
```typescript
#bashAbortControllers = new Set<AbortController>();   // line 489
#evalAbortControllers = new Set<AbortController>();   // line 493
```
There is no equivalent for `task`. This means:
- `isTaskRunning` getter does not exist
- `abortTask()` method does not exist
- ESC has no fast-path for the task tool (falls through to general `abort()`)

**Fix**: add `#taskAbortControllers`, `isTaskRunning`, and `abortTask()` mirroring
the bash/eval pattern. Wire registration into `task/index.ts` `#executeSync`.

### Bug #1 — No `isTaskRunning` branch in ESC handler (LOW, depends on #2)

**File**: `packages/coding-agent/src/modes/controllers/input-controller.ts`

```typescript
// input-controller.ts:73–86 — current ESC priority chain
} else if (ctx.session.isBashRunning) {
    ctx.session.abortBash();
} else if (ctx.session.isEvalRunning) {
    ctx.session.abortEval();
} else if (ctx.session.isStreaming) {
    void ctx.session.abort();  // ← task falls here — no dedicated fast-path
}
```

Without `isTaskRunning` / `abortTask()` (Bug #2), task cancellation falls through
to the general `abort()` path, which is semantically correct but bypasses any
future per-task granularity.

**Fix**: add `else if (ctx.session.isTaskRunning) { ctx.session.abortTask(); }`
between `isEvalRunning` and `isStreaming` branches.

### Bug #5 — `waitForIdle()` blocks abort caller (MEDIUM, risky)

**File**: `packages/coding-agent/src/session/agent-session.ts:3767`

```typescript
async abort(): Promise<void> {
    this.abortBash();
    this.abortEval();
    this.agent.abort();
    await this.agent.waitForIdle();   // ← blocks the UI until loop fully drains
```

The UI cannot update "cancelled" state until `waitForIdle()` resolves — which
waits for all subagent teardown. This is the outermost bottleneck.

**Risk**: removing the `await` may break callers that depend on the session being
fully stopped (e.g. `dispose()` callers). Needs full caller audit.

**Deferred** — fix #3 reduces the teardown time enough that this may be
acceptable without change. Revisit after #3 ships.

### Bug #6 — No "cancelling..." UI feedback (LOW)

No `isCancelling` state exists; the UI shows no indication ESC was received until
the session becomes idle. From the user's POV: nothing happens for several seconds.

**Fix**: set a `#cancelling` flag at the top of `abort()`, expose via
`isCancelling` getter, render a "cancelling..." status in the TUI.

---

## Fix priority and dependency order

```
#3 (parallel.ts)      ← most impactful; no dependencies
#4 (executor.ts)      ← standalone; pairs with #3
#2 (agent-session.ts) ← required before #1 and #6
#1 (input-controller) ← depends on #2
#6 (UI feedback)      ← depends on #2; purely cosmetic
#5 (waitForIdle)      ← deferred; risky contract change
```

---

## Complexity summary

| Fix | Files | ~Lines | Test difficulty |
|-----|-------|--------|-----------------|
| #3 `parallel.ts` race | 2 | 20 | Hard — timing, OS |
| #4 executor escalation | 1 | 15 | Medium — platform |
| #2 taskAbortControllers | 3 | 40 | Medium — unit |
| #1 ESC fast-path | 1 | 5 | Low — unit |
| #6 UI cancelling state | 2 | 15 | Low — manual |
| #5 non-blocking abort | 2–4 | 15 | Hard — caller audit |
