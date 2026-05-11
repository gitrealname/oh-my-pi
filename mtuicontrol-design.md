# mtuicontrol — Revised Design (post-research)

Branch: `mtuicontol`
Date: 2026-05-11

---

## TL;DR

**`RpcClient` + `runRpcMode` already exists and solves the problem.**

OMP ships a complete headless control system via `--mode rpc` (JSONL
stdin/stdout). `RpcClient` is a fully-typed TypeScript wrapper that spawns
a child agent process and provides methods for every operation we need.
`mtuicontrol` is just a thin OMP tool wrapping `RpcClient`.

---

## What already exists

### `runRpcMode` — headless agent server

```
omp --mode rpc [--model M] [--cwd D] [--session-dir S]
```

Reads `RpcCommand` JSON lines from stdin, emits `RpcResponse` + agent
events as JSON lines on stdout. Startup emits `{ "type": "ready" }`.

### `RpcClient` — typed programmatic wrapper

`packages/coding-agent/src/modes/rpc/rpc-client.ts`

```typescript
const client = new RpcClient({ cwd, model, provider, args });
await client.start();                    // spawns omp --mode rpc, waits for ready
await client.prompt("do X");            // sends a prompt turn
await client.waitForIdle();             // awaits agent_end event
const state = await client.getState();  // isStreaming, messageCount, ...
await client.abort();                   // fires abort command
await client.bash("sleep 30");          // run bash directly
await client.abortBash();               // cancel bash
client.onEvent(e => ...);               // stream all agent events
await client.promptAndWait("...");      // prompt + collectEvents in one call
client.stop();                          // kill subprocess
```

### Full command coverage

| Category | Commands |
|---|---|
| Prompting | `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session` |
| State | `get_state` (returns `isStreaming`, `messageCount`, model info, todos, etc.) |
| Model | `set_model`, `cycle_model`, `get_available_models` |
| Bash | `bash`, `abort_bash` |
| Session | `switch_session`, `branch`, `export_html`, `handoff`, `get_messages`, `set_session_name` |
| Compaction | `compact`, `set_auto_compaction` |
| Retry | `set_auto_retry`, `abort_retry` |
| Custom tools | `set_host_tools` — inject tools from master into spawned session |
| Extension UI | `extension_ui_request` / `extension_ui_response` bidirectional bridge |

### `set_host_tools` + `RpcClientCustomTool` — killer feature

The master agent can inject arbitrary tools into the spawned RPC session:

```typescript
const client = new RpcClient({
    customTools: [{
        name: "report_result",
        description: "Report test result back to master",
        parameters: { result: { type: "string" } },
        execute: async (params) => {
            capturedResult = params.result as string;
            return "Result captured";
        }
    }]
});
```

The spawned agent can call `report_result` as a normal tool, and the
master's `execute()` handler runs. This is how the master gets structured
output back from a controlled session.

---

## Known gap

`RpcClient.#handleLine` receives `extension_ui_request` events and
dispatches to `#extensionUiListeners` — but no `onExtensionUi()` public
method exists yet. The events are captured but the master cannot respond
to them (confirm/select dialogs in extensions will time out).

**Fix**: add `onExtensionUi(listener)` and `respondToExtensionUi(id, response)` 
methods to `RpcClient`. ~15 lines.

---

## What `mtuicontrol` tool needs to be

A thin OMP tool that:

1. Manages a pool of named `RpcClient` sessions (spawn, lookup by id, stop)
2. Exposes the key operations as a single `action`-dispatched tool call
3. Lets the LLM interact with a controlled child agent session

### Tool schema

```typescript
{
    action: "spawn" | "prompt" | "wait_idle" | "get_state" |
            "abort" | "bash" | "stop" | "collect_events";
    sessionId?: string;           // handle returned by "spawn"
    message?: string;             // for "prompt"
    command?: string;             // for "bash"
    timeoutMs?: number;           // for "wait_idle" / "collect_events"
    model?: string;               // for "spawn"
    cwd?: string;                 // for "spawn"
    provider?: string;            // for "spawn"
    args?: string[];              // for "spawn" — extra CLI args
}
```

### Session pool implementation

```typescript
// In-process singleton so sessions survive across tool calls
const activeSessions = new Map<string, RpcClient>();

// On "spawn":
const id = `rpc-${Date.now()}`;
const client = new RpcClient({ cwd, model, provider, args });
await client.start();
activeSessions.set(id, client);
return { sessionId: id };

// On "prompt":
const client = activeSessions.get(sessionId)!;
await client.prompt(message);
return { ok: true };
```

### ESC cancellation test example

```typescript
// Spawn a new session
const { sessionId } = await mtuicontrol({ action: "spawn", cwd: "D:/.ai" });

// Send a task that runs a 30s sleep
await mtuicontrol({ action: "prompt", sessionId,
    message: "use task tool (quick_task) to run bash sleep 30 and output DONE" });

// Wait for task to start (agent goes idle after dispatching task)
await mtuicontrol({ action: "wait_idle", sessionId, timeoutMs: 20000 });

// Fire abort (equivalent to ESC in interactive mode)
const t0 = Date.now();
await mtuicontrol({ action: "abort", sessionId });
await mtuicontrol({ action: "wait_idle", sessionId, timeoutMs: 5000 });
const elapsed = Date.now() - t0;
// assert elapsed < 2000ms — proves ESC cancel fix works

await mtuicontrol({ action: "stop", sessionId });
```

---

## Implementation plan

| Step | File | Change | Effort |
|---|---|---|---|
| 1 | `rpc-client.ts` | Add `onExtensionUi()` + `respondToExtensionUi()` public methods | ~15 lines |
| 2 | `src/tools/mtuicontrol/index.ts` | New tool — session pool + action dispatch wrapping `RpcClient` | ~150 lines |
| 3 | `src/tools/mtuicontrol/session-pool.ts` | Singleton map of `RpcClient` instances | ~40 lines |
| 4 | `sdk.ts` | Register `mtuicontrol` tool (gated by `mtuicontrol.enabled`) | ~5 lines |
| 5 | `settings-schema.ts` | `mtuicontrol.enabled` setting | ~3 lines |
| 6 | `test/mtuicontrol-esc.test.ts` | End-to-end ESC cancel test using `RpcClient` directly | ~60 lines |

**Total: ~270 lines across 6 files. No new protocols or infrastructure needed.**

---

## Why the original mailbox HTTP design is unnecessary

| Original design item | RPC equivalent |
|---|---|
| `--mailbox-port <N>` CLI flag | `--mode rpc` (already exists) |
| `MailboxServer` HTTP server | `runRpcMode` JSONL (already exists) |
| `POST /key` ESC injection | `abort` RPC command (already exists) |
| `POST /type` text injection | `prompt` RPC command (already exists) |
| `POST /command` slash injection | N/A — slash commands not needed in RPC mode |
| `GET /state` | `get_state` RPC command (already exists) |
| `GET /events` SSE stream | `onEvent()` + `agent_end` event (already exists) |
| `InputController.injectKey()` | N/A — RPC mode has no TUI/InputController |
| `MailboxClient` test helper | `RpcClient` (already exists) |

The only genuine gap is `extension_ui_request` — extensions that open
confirm/select dialogs can't be responded to programmatically yet.
That is a 15-line addition to `RpcClient`.

---

## Files to create / change

```
packages/coding-agent/src/modes/rpc/rpc-client.ts     — +onExtensionUi(), +respondToExtensionUi()
packages/coding-agent/src/tools/mtuicontrol/
  index.ts                                             — NEW: tool implementation
  session-pool.ts                                      — NEW: singleton RpcClient map
packages/coding-agent/src/sdk.ts                       — register tool
packages/coding-agent/src/config/settings-schema.ts   — mtuicontrol.enabled
packages/coding-agent/test/mtuicontrol-esc.test.ts    — NEW: ESC cancel e2e test
```
