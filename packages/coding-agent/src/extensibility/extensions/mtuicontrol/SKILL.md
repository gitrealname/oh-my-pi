---
description: Programmatic control of child OMP sessions via RPC for testing and automation.
---

# mtuicontrol

Spawn and control child OMP sessions. Use `mcommand` for each action. **One `mcommand` per turn — stay completely silent after each call.** The result arrives as a follow-up message. Do NOT batch mcommand calls in the same turn; each must wait for its follow-up before proceeding.

## Commands

```
/mtuicontrol spawn     --cmd <full command line>
/mtuicontrol prompt    [id] [--timeout N(ms)] <message>
/mtuicontrol keypress  [id] <ESC><ENTER><CTRL-C>...
/mtuicontrol command   [id] <slash command>
/mtuicontrol exec      [id] step1|step2|...
/mtuicontrol interrupt [id]
/mtuicontrol stop      [id | --all]
/mtuicontrol list
```

## Critical behavioral rules

- **One `mcommand` per turn.** All mtuicontrol commands are queued via `SCHEDULE_SLASH_CHANNEL` and fire after the current agent turn ends. Multiple mcommands in one turn all fire simultaneously — causes race conditions and duplicate sessions.
- **Stay silent after `mcommand`.** Do NOT call bash, read logs, or make any other tool calls after sending a mcommand. The follow-up arrives as the next turn's context.
- **Check logs only to diagnose failures**, not as the primary feedback mechanism. The follow-up message IS the feedback.

## exec — Slave-side execution queue

The `exec` command enqueues steps on the slave's sequential execution queue. The slave executes them in order and sends **exactly one `exec_step_result` frame per step** back to the master. The master prints each result to the "!" panel as it arrives and fires an LLM turn when all steps complete (counter = 0).

### Step syntax

```
type:body[:timeoutMs]
```

Steps are separated by `|`. Escape `|` as `\|` and `:` as `\:` in the body.

| Type | Input submitted | Waits for |
|------|----------------|-----------|
| `prompt` | Plain text → LLM turn | `agent_end` |
| `slash` | `/cmd` → slash command | `agent_end` |
| `bash` | `!cmd` → bash, in context | idle |
| `bash_x` | `!!cmd` → bash, out of context | idle |
| `python` | `$code` → Python, in context | idle |
| `python_x` | `$$code` → Python, out of context | idle |
| `keypress` | Raw key bytes injected | immediate |
| `sleep` | Pause N ms | N ms |

Default timeout per step: 60,000ms.

### exec_step_result — 8 labeled sections

Each frame the slave sends contains:

| Label | Contents |
|-------|----------|
| `error` | `showError` / `showWarning` / `showStatus` from slave TUI |
| `llm_input` | Text injected as prompt (prompt/slash steps) |
| `llm_output` | LLM assistant response text (turn_end) |
| `tool_output` | LLM-initiated tool results (ToolExecutionComponent) |
| `bash_visible` | `!cmd` bash output, included in context |
| `bash_invisible` | `!!cmd` bash output, excluded from context |
| `eval_visible` | `$code` Python output, included in context |
| `eval_invisible` | `$$code` Python output, excluded from context |

### Counter protocol

- `exec` increments the per-slave counter by the number of steps enqueued.
- Each `exec_step_result` received decrements the counter and prints to "!".
- When counter = 0 → master fires LLM turn with `[exec:done]` signal.
- `interrupt` → sets counter to 1 (one final result expected); slave aborts current step, clears queue, sends one result frame.
- `stop` / slave crash → counter reset to 0, LLM turn fired with stop/error notification.

## Command reference

### spawn

```
mcommand({ command: '/mtuicontrol spawn --cmd "cmd.exe /c ow --new --no-memory"' })
→ "Session rpc-<id> ready. (child pid=<n>)"
```

`--rpc-pipe <port>` is appended automatically. The port number is consumed by the arg parser and never appears as slave input.

### prompt

```
mcommand({ command: "/mtuicontrol prompt [--timeout 90000] write a haiku" })
→ "Child:\n<response text>"
```

Synchronous — sends message, waits for full response. Timeout defaults to 60s (no hard cap). Auto-injects `<ESC>` on timeout.

### keypress

```
mcommand({ command: "/mtuicontrol keypress <ESC>" })
→ "Injected 1 key(s)."
```

Injects real keyboard input through the TUI's `InputController`. For cancellation tests, the slave must be actively processing when the keypress arrives — use `exec` with a `sleep` step between `prompt` and `keypress`.

### command

```
mcommand({ command: "/mtuicontrol command /copy" })
→ 'Command "/copy" scheduled.'
   [slave:error] No agent messages to copy yet.   ← arrives as separate follow-up
```

Injects a slash command via `editor.onSubmit`. Slave TUI output (showError/showStatus) arrives via `[slave:error]`/`[slave:status]` follow-up after the synchronous result.

### exec with timing (T6/T7 pattern)

```
mcommand({ command: "/mtuicontrol exec prompt:use bash to run\\: sleep 30:35000|sleep:2000|keypress:<ESC><ESC>" })
```

1. Slave starts `sleep 30` (prompt step, 35s timeout)
2. After 2s sleep, ESC+ESC injected while slave is busy
3. One `exec_step_result` per step arrives; `[exec:done]` when counter = 0

### interrupt

```
mcommand({ command: "/mtuicontrol interrupt" })
→ "Interrupt sent to rpc-<id>."
   [step:N:interrupt]
     [error] Interrupted: M pending step(s) cleared.   ← arrives as follow-up
```

### stop

```
mcommand({ command: "/mtuicontrol stop" })        → "Session rpc-<id> stopped."
mcommand({ command: "/mtuicontrol stop --all" })  → "Stopped N session(s)."
```

### list

```
mcommand({ command: "/mtuicontrol list" })
→ "Active sessions:\nrpc-<id1>\nrpc-<id2>"
   OR "No active sessions."
```

## [id] defaulting

`[id]` defaults to `lastSessionId` (last spawned or used session). With multiple sessions, spawn order determines the default — the last spawned session wins. To target a specific session, pass the full `rpc-<id>` as the first argument.

## Key files (source)

| File | Role |
|------|------|
| `src/extensibility/extensions/m-mtuicontrol-extension.ts` | All commands, session pool, counter protocol, onExecStepResult handler |
| `src/modes/rpc/rpc-inject.ts` | `RpcExecStep`, `ExecStepResult` types, wire protocol |
| `src/modes/rpc/rpc-inject-handler.ts` | Slave-side exec queue, `runStep`, `emitStepResult` |
| `src/modes/rpc/rpc-inject-client.ts` | `enqueueExec`, `onExecStepResult`, `onTuiOutput` |
| `src/modes/rpc/pipe-transport.ts` | TCP loopback transport (Windows), Unix socket (Unix) |
| `src/tools/mcommand.ts` | `mcommand` tool — routes to `SCHEDULE_SLASH_CHANNEL` |
| `src/slash-commands/builtin-registry.ts` | mtuicontrol `handleTui` registration |

## Config requirement

Both `o` and `ow` configs must have:

```yaml
mtuicontrol:
  enabled: true
```

## Log entries (new binary)

| Entry | Meaning |
|-------|---------|
| `[main] interactive mode {version}` | Session start — confirms which binary is running |
| `[main] headed+pipe mode {version, pipeArg}` | Slave started with --rpc-pipe |
| `[interactive] SCHEDULE_SLASH_CHANNEL {command, hasOnSubmit}` | mcommand queued |
| `[interactive] SCHEDULE_SLASH executing {command}` | Command actually firing |
| `[mtuicontrol] spawned {id, cmd, childPid}` | Slave connected |
| `[mtuicontrol] stopped {id}` | Session stopped |
| `[mtuicontrol] exec_step_result {stepIndex, stepType}` | One step completed |
| `[mtuicontrol] all steps done → LLM turn {id}` | Counter = 0, LLM turn fired |
| `[mtuicontrol] tui_output {id, level, text}` | Slave TUI output (direct commands) |
| `[mtuicontrol] command injected {id, cmd}` | Slash command injected |
| `[mtuicontrol] keypress {id, seq, count}` | Keys injected |
| `[rpc-inject] exec_step_result {stepIndex, stepType}` | Slave emitting result frame |
