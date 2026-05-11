# mtuicontrol — Design Findings

Branch: `aws-corp`
Date: 2026-05-11

---

## Goal

Create an `mtuicontrol` tool that allows a master agent to spawn a headed
`o` / `ow` TUI session and fully control it programmatically — feeding
input, receiving output, and injecting slash commands. Critical for tests
that require user interaction (ESC, file picker, review panels, etc.).

---

## Existing communication primitives

### 1. `EventBus` — in-process typed pub/sub

```typescript
// packages/coding-agent/src/utils/event-bus.ts
class EventBus {
    emit(channel: string, data: unknown): void
    on(channel: string, handler: (data: unknown) => void): () => void
}

// Key channel already in use:
export const SCHEDULE_SLASH_CHANNEL = "tui:schedule-slash";
// Any component can emit a slash command string here and
// interactive-mode.ts will execute it as if the user typed it (once idle)
```

**Used by**: mreview tool, mmemory recall/reflect/retain tools.
**Scope**: single process, single TUI session. Cannot cross process boundary.

### 2. `AgentRegistry` — process-global live agent map

```typescript
// packages/coding-agent/src/registry/agent-registry.ts
AgentRegistry.global()               // singleton
  .register({ id, kind, session, ... })
  .listVisibleTo(senderId)           // for IRC routing
  .get(agentId)                      // direct session ref
```

Every agent (main + subagents) is registered here. The `irc` tool uses
this for agent-to-agent messaging with `session.respondAsBackground()`.

### 3. `IRC tool` — agent-to-agent prose messaging

```typescript
// op: "send" | "list"
// Delivers a prose message to any live agent by id
// Replies via AgentSession.respondAsBackground() — side-channel LLM call
// that doesn't block the recipient's main loop
```

**Already works for in-process agents.** Constrained to the same process
(same running `omp.exe`). Cannot reach a separately spawned TUI process.

### 4. `SCHEDULE_SLASH_CHANNEL` — deferred slash command injection

```typescript
session.eventBus?.emit(SCHEDULE_SLASH_CHANNEL, "/mreview /abs/path");
// interactive-mode.ts waits for agent idle, then executes the slash command
// as if the user typed it
```

**This is the cleanest existing hook for TUI control.** It bypasses the
keypress layer entirely, scheduling commands at the session level.

### 5. `SubprocessToolRegistry` — in-process subagent tool event bus

```typescript
// packages/coding-agent/src/task/subprocess-tool-registry.ts
subprocessToolRegistry.register(toolName, {
    extractData, shouldTerminate, renderInline, renderFinal
})
// Handles tool_execution events forwarded from subagents via EventBus channels:
// TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL, TASK_SUBAGENT_LIFECYCLE_CHANNEL
```

**Subagent → parent communication is already solved** via EventBus channels
inside a single process.

### 6. `mreview` HTTP sidecar pattern

mreview spawns a `node:http` server on a random `localhost` port, opens a
browser pointing at it, and awaits a `Promise<MReviewDecision>` that
resolves when the browser POSTs a decision. The TUI is suspended waiting
for the HTTP resolution. AI queries route directly through the live
`AgentSession` instance (same process).

**This is the pattern for any browser-based UI bridge.**

### 7. Python gateway (`gateway-coordinator.ts`)

A singleton HTTP gateway (`gateway.json` → `url`) started on demand for
Python eval. Uses file-based lock + heartbeat to coordinate between
processes. Could be adapted as a cross-process mailbox.

---

## The gap: cross-process TUI control

All existing primitives are **in-process only**. When a master agent wants
to spawn and control a *separate* `o` / `ow` process, none of these work:

- `EventBus` → single process
- `AgentRegistry` → single process
- `IRC` → same `AgentRegistry` → single process
- `SCHEDULE_SLASH_CHANNEL` → same process EventBus

The `mtuicontrol` tool needs a **cross-process mailbox**.

---

## Design: `mtuicontrol` with named-pipe mailbox

### Architecture

```
Master agent (omp process A)
  └─ mtuicontrol.execute()
       ├─ spawns: omp --new --mailbox <pipe-path>  (process B)
       │    └─ TUI runs, reads input from <pipe-path>
       │    └─ writes output/events to <pipe-path>-out
       └─ holds pipe handle, sends commands, reads responses
```

### Mailbox transport options

| Option | Pros | Cons |
|---|---|---|
| **Named pipe** (Windows: `\\.\pipe\omp-mailbox-<id>`) | Native, fast, bidirectional, no port allocation | Windows-specific path syntax |
| **Unix socket** | Cross-platform, fast | Not native on older Windows |
| **TCP localhost** | Works everywhere, easy to debug | Port allocation, firewall noise |
| **File-based (JSONL)** | Simple, survives crashes | Polling latency, temp file cleanup |

**Recommendation: TCP localhost** (same pattern as python-gateway).
Allocate a random port, pass via `--mailbox-port <N>` CLI arg. The spawned
TUI process binds a simple HTTP server on that port. The master sends
commands as HTTP POST and receives responses as JSON.

### Mailbox protocol (JSON over HTTP)

```
POST /command   { type, payload }   → { ok, data?, error? }
POST /key       { key: "\x1b" }     → { ok }   — raw keypress injection
POST /type      { text: "hello\n" } → { ok }   — text injection to editor
GET  /state     → { isStreaming, isIdle, isTaskRunning, currentOutput }
GET  /events    → SSE stream of TUI events (output lines, state changes)
POST /stop      → graceful shutdown
```

### TUI-side changes needed

1. **CLI flag `--mailbox-port <N>`** — if present, start a `MailboxServer`
   on that port before entering interactive mode.

2. **`MailboxServer`** class:
   - `POST /key` → calls `InputController.injectKey(key)` (new method)
   - `POST /type` → calls `InputController.injectText(text)`
   - `POST /command` → emits to `SCHEDULE_SLASH_CHANNEL` (already exists)
   - `GET /state` → reads `session.isStreaming`, `session.isTaskRunning`, etc.
   - `GET /events` → SSE-streams `EventBus` events

3. **`InputController.injectKey(key: string)`** — new method that fires
   the same handler as a real keypress, bypassing the terminal input layer.
   Already has all the key handlers; just needs a programmatic entry point.

4. **`InputController.injectText(text: string)`** — feeds text into the
   editor component as if typed, then optionally fires Enter.

### Master-side tool (`mtuicontrol`)

```typescript
class MtuicontrolTool implements AgentTool {
    name = "mtuicontrol";

    async execute(params: {
        action: "spawn" | "type" | "key" | "slash" | "wait_idle" | "get_state" | "stop";
        sessionId?: string;  // handle for a spawned session
        text?: string;       // for "type"
        key?: string;        // for "key": "Escape", "Enter", "Tab", etc.
        command?: string;    // for "slash": "/mreview ...", "/btw ..."
        timeoutMs?: number;  // for "wait_idle"
        model?: string;      // for "spawn"
        cwd?: string;        // for "spawn"
    }): Promise<AgentToolResult>
}
```

**`spawn`** → start `omp --new --mailbox-port <N> [--model M]`, store port
under `sessionId`, return `sessionId`.

**`type`** → POST /type to the mailbox, wait for idle.

**`key`** → POST /key with raw escape code or named key.

**`slash`** → POST /command to inject a slash command at next idle.

**`wait_idle`** → poll GET /state until `isIdle: true` or timeout.

**`get_state`** → GET /state, return current TUI state snapshot.

**`stop`** → POST /stop.

---

## Gaps / changes required in OMP

| Component | Change | Complexity |
|---|---|---|
| CLI entry (`interactive-mode.ts` or main) | Accept `--mailbox-port <N>` flag, instantiate `MailboxServer` | Low |
| New file: `src/modes/mailbox-server.ts` | HTTP server, `/key`, `/type`, `/command`, `/state`, `/events` | Medium |
| `InputController` | Add `injectKey(key)` + `injectText(text)` programmatic entry points | Low — handlers already exist, just need a direct call path |
| New file: `src/tools/mtuicontrol/index.ts` | Tool implementation — spawn, communicate, tear down | Medium |
| `ToolSession` interface | Add `spawnMailboxSession?()` or access pattern | Low |
| Settings schema | `mtuicontrol.enabled` | Trivial |
| Test harness helper | `MailboxClient` class reusable by all integration tests | Low |

---

## How this solves the ESC test problem

```typescript
// Master agent test:
const { sessionId } = await mtuicontrol({ action: "spawn", cwd: "D:/.ai" });
await mtuicontrol({ action: "type", sessionId, text:
    "use task tool (quick_task) to run bash sleep 30 and output DONE\n"
});
await mtuicontrol({ action: "wait_idle", sessionId, timeoutMs: 15000 });
// task is now in-flight
await mtuicontrol({ action: "key", sessionId, key: "Escape" });
const { isIdle } = await mtuicontrol({ action: "get_state", sessionId });
// assert isIdle within 2s — proves ESC cancel fix works
await mtuicontrol({ action: "stop", sessionId });
```

---

## Alternatives considered

### Use IRC for cross-process control

IRC is in-process only (same `AgentRegistry`). Would require the spawned
process to share the same registry — impossible across process boundaries
without a shared network transport.

### Adapt python-gateway file-based lock as mailbox

Works but adds file I/O latency on every keystroke. The HTTP approach is
cleaner and already established by `mreview`.

### PTY-level control (ConPTY / node-pty)

The most powerful option — full terminal emulation, works with any TUI.
But requires `node-pty` or Windows ConPTY bindings (neither currently in
the codebase), adds a native dependency, and makes assertions on output
harder (ANSI escape sequences to parse).

The `--mailbox-port` approach is lighter, purpose-built, and doesn't
require parsing terminal escape codes to determine state.

---

## Recommended implementation order

1. `InputController.injectKey()` + `injectText()` — smallest change, tests the
   injection path in isolation
2. `MailboxServer` — standalone HTTP server, wired to `EventBus` and
   `InputController`
3. `--mailbox-port` CLI flag — one-liner in startup
4. `MailboxClient` test helper — reusable across all integration tests
5. `mtuicontrol` tool — wraps spawn + MailboxClient calls
6. Integration test: ESC cancellation end-to-end
