# mtuicontrol — Design & Reference

## Status & outstanding issues

**Build:** `binaries/omp-aws-corp.exe` — deployed to `%LOCALAPPDATA%/omp/omp.exe`
**Tests:** All core tests passed (2026-05-11 session). See §Test results.
**Branch:** `mtuicontol` — all changes uncommitted.

### Known issues requiring follow-up

| Issue | Severity | Notes |
|---|---|---|
| `stop` does not close child window | Low | `process.kill(childPid)` kills `ow` process (batch file's bun subprocess) but `cmd.exe` wrapper stays open showing prompt. Need `taskkill /PID xxx /F /T` (tree kill) or alternative approach on Windows. Deferred. |
| `TypeError: undefined is not an object (evaluating 'result.usage')` | Medium | Appears in `quick_task` subagent when task is aborted mid-execution or API returns error response. Root cause: some code path accesses `result.usage` where `result` is `undefined` (not the task/index.ts loop which has `if (result.usage)` guard). Needs stack trace to locate. Pre-existing, not introduced by mtuicontrol. |
| `extension_ui_request` no public handler | Low | `RpcClient.#extensionUiListeners` captures extension UI requests (confirm/select dialogs in child) but no `onExtensionUi()` / `respondToExtensionUi()` public methods. ~15 lines in `rpc-client.ts`. Without this, dialogs in child sessions time out. Phase 3 gap. |
| Stale queue from aborted turns | Low | When master LLM turns are aborted, `SCHEDULE_SLASH_CHANNEL` items already scheduled still fire. Multiple rapid aborts can leave stale commands in queue that fire against the wrong session. No queue drain mechanism exists. |
| `prompt` returns stale `sessionLastText` on ESC | Info | When `prompt` times out and ESC fires, if no `turn_end` was captured before timeout, `sessionLastText` from the previous prompt is returned as response text. Cosmetic — the abort was successful. |

---

Branch: `mtuicontol`
Date: 2026-05-11
Status: Implemented, deployed, tested — all 10 tests PASS (2026-05-11)

---

## What it is

`mtuicontrol` lets an OMP agent (or user) spawn and fully control a child OMP
session programmatically — sending prompts, injecting keystrokes, scheduling
slash commands, and waiting for idle. Built for end-to-end testing and
automation scenarios that require real user-input simulation (ESC cancellation,
modal dialogs, slash command chains).

---

## Architecture

```
LLM agent
  └─ calls mcommand tool: { command: "/mtuicontrol spawn --cmd ..." }
       └─ mcommand emits SCHEDULE_SLASH_CHANNEL on EventBus
            └─ InteractiveMode executes /mtuicontrol
                 └─ m-mtuicontrol-extension.ts handles it
                      ├─ createPipeServer() → binds TCP port (Windows shim)
                      │   or Unix socket (Unix)
                      ├─ spawns child: <user-cmd> --rpc-pipe <port/path>
                      │   child calls connectToPipe(arg) → JSONL over socket
                      │   child: runRpcMode in parallel with TUI (main.ts)
                      └─ RpcInjectClient wraps RpcClient (adds injectKey/Text/Slash)
                           └─ subsequent mcommand calls drive the child
```

### Transport: `--rpc-pipe <arg>`

The `--rpc-pipe` flag is orthogonal to `--mode rpc`:

```
omp --mode rpc                       headless, JSONL on stdin/stdout (existing)
omp --mode rpc --rpc-pipe <arg>      headless, JSONL on pipe (stdin/stdout free)
omp --new      --rpc-pipe <arg>      headed TUI + JSONL on pipe side-channel ← mtuicontrol default
```

**`<arg>` semantics:**
- Unix: path to Unix domain socket (`/tmp/omp-rpc-<uuid>.sock`)
- Windows: TCP port number as string (`54321`) — Bun named-pipe server is
  broken (issues #11820, #24682, #30265), TCP loopback is the shim

One arg covers both platforms. Child code:
```typescript
const port = parseInt(arg, 10);
if (!isNaN(port)) net.connect({ host: "127.0.0.1", port }); // Windows
else              net.connect(arg);                           // Unix socket
```

### Session pool

The extension factory runs once at startup; its closure holds:
```typescript
const sessionPool = new Map<string, RpcInjectClient>();
let lastSessionId: string | undefined;  // defaults for omitted [id]
```

Sessions survive across slash command invocations. `spawn` sets
`lastSessionId`; all other commands default to it.

### Key files

| File | Role |
|---|---|
| `src/modes/rpc/pipe-transport.ts` | `createPipeServer()` + `connectToPipe()` + Windows TCP shim |
| `src/modes/rpc/rpc-inject.ts` | `inject_key` / `inject_text` / `inject_slash` RPC command types |
| `src/modes/rpc/rpc-inject-handler.ts` | Server-side handler; `registerInputController()` for headed mode |
| `src/modes/rpc/rpc-inject-client.ts` | `RpcInjectClient` wrapper: `injectKey/Text/Slash` |
| `src/modes/rpc/rpc-client.ts` | `rpcPipe` option; `_sendCommand` escape hatch |
| `src/modes/rpc/rpc-mode.ts` | `--rpc-pipe` detection; connects to pipe; inject command dispatch |
| `src/main.ts` | `void runRpcMode(session)` when `--rpc-pipe` present (headed mode) |
| `src/modes/interactive-mode.ts` | `registerInputController(this.#inputController)` after init |
| `src/modes/controllers/input-controller.ts` | `injectKey(key)` + `injectText(text)` |
| `src/extensibility/extensions/m-mtuicontrol-extension.ts` | Extension: all commands, session pool |
| `src/tools/mcommand.ts` | Generic slash-command proxy tool (LLM entry point) |
| `src/tools/index.ts` | `mcommand: MCommandTool.createIf` registered |
| `src/cli/args.ts` | `--no-memory` flag → disables mmemory on child |
| `src/config/settings-schema.ts` | `mtuicontrol.enabled` (default: false) |
| `.omp/skills/mtuicontrol/SKILL.md` | Skill: teaches LLM to use mcommand + /mtuicontrol |

---

## mcommand tool

The LLM's entry point. Any registered slash command, proxied through the
EventBus.

```typescript
// Tool description (intentionally short):
"Invoke a registered slash (\"/\") command. Only call when explicitly
 instructed to by name — do not infer or select this tool on your own.
 After this tool returns, do NOT generate any response — stay completely
 silent. Output arrives as a follow-up message."
```

Used for all `/mtuicontrol` invocations, all `/mmemory recall/reflect/retain`,
all `/mreview`, and any future slash command. Single generic tool instead of
per-feature private tools.

---

## /mtuicontrol commands

### `spawn --cmd <full command line>`
User supplies the **complete command** to run. Extension appends
`--rpc-pipe <port>` automatically. No flags assumed.

```
/mtuicontrol spawn --cmd "cmd.exe /c ow --new --no-memory"
/mtuicontrol spawn --cmd "cmd.exe /c o --new --no-memory"
/mtuicontrol spawn --cmd "D:/custom/omp.sh --new"
```

On Windows, use `cmd.exe /c <cmd>` as the command. `RpcClient` automatically
detects `cmd.exe /c <cmd>` and injects `start ""` after `/c` so the child
opens in a **new visible console window**:
→ `cmd.exe /c start "" ow --new --no-memory --rpc-pipe <port>`
No user-facing API change; the injection is transparent.
Returns: `Session rpc-<timestamp>-<rand> ready.`  
Sets `lastSessionId` to the new session.

### `prompt [id] <message...>`

Sends text as an RPC `prompt` command to the child agent. The child
processes it as a user message.

```
/mtuicontrol prompt reply with exactly three words: child works correctly
/mtuicontrol prompt rpc-1234-abc use task tool to run bash sleep 30
```

`[id]` defaults to `lastSessionId`.

### `keypress [id] <KEY_SEQUENCE>`

Injects keyboard sequences. **Keyboard only — no plain text.** Plain text
goes through `prompt`.

**Named keys:**
```
<ESC>   <ESCAPE>   → \x1b
<ENTER> <RETURN>   → \r
<TAB>              → \t
<BACKSPACE> <BS>   → \x7f
<DELETE> <DEL>     → \x1b[3~
<UP> <DOWN> <LEFT> <RIGHT>
<HOME> <END> <PGUP> <PGDN>
<F1> <F2> <F3> <F4>
```

**Control keys — dynamic (`CTRL-A` through `CTRL-Z`):**
```
<CTRL-A>  → \x01       (start of line in bash/readline)
<CTRL-C>  → \x03       (interrupt / SIGINT)
<CTRL-D>  → \x04       (EOF / logout)
<CTRL-L>  → \x0c       (clear screen)
<CTRL-U>  → \x15       (clear line)
<CTRL-W>  → \x17       (delete word)
<CTRL-Z>  → \x1a       (suspend)
```

**Alt combos — `ALT-[A-Z0-9]`:**
```
<ALT-F>   → \x1b + f   (forward word in readline)
<ALT-B>   → \x1b + b   (backward word)
<ALT-D>   → \x1b + d   (delete word forward)
```

**Ctrl+Alt chords — `CTRL-ALT-[A-Z]`:**
Sent as ESC prefix + CTRL code (most terminals/tmux):
```
<CTRL-ALT-D>  → \x1b\x04
<CTRL-ALT-C>  → \x1b\x03
```

**Shift combos (terminal-dependent):**
```
<SHIFT-ENTER>  → \x1b[13;2u   (Kitty protocol)
```
Note: `<SHIFT-ENTER>` behaviour depends on terminal capabilities. Works in
Windows Terminal with Kitty protocol enabled; falls back to plain `\r` in
basic terminals.

**Examples:**
```
/mtuicontrol keypress <ESC>
/mtuicontrol keypress <ESC><ESC>
/mtuicontrol keypress <CTRL-C>
/mtuicontrol keypress <CTRL-D>
/mtuicontrol keypress <CTRL-L>
/mtuicontrol keypress <CTRL-ALT-D>
/mtuicontrol keypress rpc-1234-abc <ESC><ESC>
```

In headed mode: calls `inputController.injectKey(key)` → real `onEscape()`
path → `abortTask()` → `parallel.ts` race fix.
In headless mode: `<ESC>` / `\x1b` maps to `session.abort()`.

### `command [id] <slash command>`

Injects a slash command into the child session via `SCHEDULE_SLASH_CHANNEL`.
Executed at next idle tick. Mirrors `mcommand` but for the child.

```
/mtuicontrol command /mtree
/mtuicontrol command /mmemory recall mtuicontrol design
/mtuicontrol command /help
/mtuicontrol command mchain-prompts    ← leading / added automatically
```

### `wait [id] [--timeout N]`

Waits for the child session to become idle (agent finishes turn).
Default timeout: 30 000 ms.

On timeout (escalation sequence):
1. Inject `<ESC>` (`\x1b`) → send abort signal
2. Wait 3 s
3. If still not idle → stop session and remove from pool

```
/mtuicontrol wait
/mtuicontrol wait --timeout 20000
/mtuicontrol wait rpc-1234-abc --timeout 10000
```

Returns: `Idle after Nms.` | `Idle after ESC (Nms total).` | `Session X was unresponsive and terminated (Nms).`

### `stop [id]`

Clean shutdown. Calls `RpcClient.stop()`, removes from pool,
clears `lastSessionId` to next most-recent session.

### `list`

Lists active session ids. Returns "No active sessions." if pool is empty.

---

## Enable / disable

```yaml
# config.yml
mtuicontrol:
  enabled: true   # default: false
```

The extension is not registered when `enabled !== true`, so it has zero
LLM context cost when unused.

---

## Implementation notes — bugs found during testing

These bugs were found and fixed during the initial interactive test session (2026-05-11).
Recorded here so they are never repeated.

### 1. `registerCommand` called with wrong signature
**Bug:** `pi.registerCommand("/mtuicontrol", async (ctx) => {...})` — passing the handler
function directly as the second argument instead of `{ handler: fn }`.
**Effect:** The command was stored with no handler (spreading a function gives `{}`). Silently
discarded on every invocation.
**Fix:** `pi.registerCommand("mtuicontrol", { handler: async (args, _ctx) => {...} })`

### 2. Command name included leading `/`
**Bug:** Registered as `"/mtuicontrol"` but looked up as `"mtuicontrol"` (agent-session strips
the `/` before calling `getCommand(name)`).
**Effect:** `getCommand("mtuicontrol")` never matched `"/mtuicontrol"` — command silently not found.
**Fix:** Register without leading slash: `"mtuicontrol"`.

### 3. `ctx.sendUserMessage` does not exist
**Bug:** Used `ctx.sendUserMessage(...)` inside the command handler. `ExtensionCommandContext`
does not have `sendUserMessage` — it lives on the factory-scope `pi` (`ExtensionAPI`).
**Effect:** Runtime error: `ctx.sendUserMessage is not a function`.
**Fix:** Use `pi.sendUserMessage(...)` (close over `pi` from the factory parameter).

### 4. `logger.info` does not exist
**Bug:** Called `logger.info(...)`. The `logger` export from `@oh-my-pi/pi-utils` is
`export * as logger from "./logger"` — a namespace of individual functions. It has
`debug`, `warn`, `error` — **no `info`**.
**Effect:** Runtime error: `exports_logger.info is not a function`.
**Fix:** Replace all `logger.info(...)` with `logger.debug(...)`.

### 5. `bun` prefix added to shell executables
**Bug:** `RpcClient.start()` always built `cmd = ["bun", cliPath, ...args]` regardless of
whether `cliPath` was a JS module or a shell wrapper.
**Effect:** Spawning `bun cmd.exe /c ow ...` — `bun` is not a shell, `cmd.exe` fails.
**Fix:** Detect via `/\.[jt]s$/.test(cliPath)`. Only prefix `bun` for JS/TS modules.
Shell executables (`cmd.exe`, `.cmd`, `.exe`, `.sh`) are spawned directly.

### 6. Mode args (`--mode rpc` / `--new`) injected into user command
**Bug:** `RpcClient.start()` always prepended `modeArgs` before user args. For shell
executables the user owns the full command — injecting `--mode rpc` corrupted it.
**Effect:** Child received `cmd.exe /c ow --mode rpc --new --no-memory` — wrong.
**Fix:** `modeArgs` injection is now gated on `isBunModule`. Shell executables get
no injected flags — only `--rpc-pipe <port>` is appended.

### 7. `--cmd` value split on whitespace before quote stripping
**Bug:** `args.trim().split(/\s+/)` split `"ow --new --no-memory"` before stripping
quotes, yielding `["\"ow", "--new", "--no-memory\""]` — the cliPath became `"ow"` with
literal quotes.
**Effect:** `Executable not found in $PATH: ""ow"`.
**Fix:** Use regex on the raw args string: `args.match(/--cmd\s+(.*)/s)` to capture
everything after `--cmd`, then strip outer `"..."` if present, then split.

### 8. Child window not visible (`cmd.exe /c ow` runs hidden)
**Bug:** `cmd.exe /c ow --new` inherits the parent console — no new window.
**Effect:** User cannot see or validate the child OMP instance.
**Fix:** `RpcClient.start()` automatically detects `cmd.exe /c <cmd>` on Windows
and injects `start ""` after `/c`: → `cmd.exe /c start "" ow --new ...`.
This opens a new visible console window. No user-facing API change.

### 9. `cmd.exe /c start` exits immediately — falsely rejected ready wait
**Bug:** When using `start`, `cmd.exe` exits immediately after spawning the child.
The existing `process.exited` handler rejected `readyPromise` before the child
could connect to the pipe and send `{type:"ready"}`.
**Effect:** `Failed to spawn: Agent process exited with code 0`.
**Fix:** The `process.exited` rejection guard is now skipped in pipe mode (`usePipe === true`).
The ready signal arrives via the pipe socket, not via the launcher process.

### 10. Dead sessions not removed from pool
**Bug:** If the child window is closed or the child crashes, the session pool
retains a stale `RpcInjectClient`. Subsequent commands produce confusing RPC errors.
**Fix:** `RpcClient.onExit(handler)` added. The handler is registered in `spawn` to
auto-remove the session from the pool when the child exits for any reason.
Also fires from `stop()` so the pool is always consistent.

## ESC cancellation test (core regression check)

Tests that the `parallel.ts` abort race fix works: after ESC, the agent
should go idle in <2 s even if a subagent was running `bash sleep 30`.

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol prompt use task tool (quick_task) to run bash sleep 30 then output DONE" })
→ "Prompt sent."

mcommand({ command: "/mtuicontrol wait --timeout 25000" })
→ "Idle after ~8000ms."    ← task dispatched, agent waiting for subagent

mcommand({ command: "/mtuicontrol keypress <ESC>" })
→ "Injected 1 key(s)."

mcommand({ command: "/mtuicontrol wait --timeout 5000" })
→ "Idle after ~300ms."     ← <2s confirms fix; timeout means regression

mcommand({ command: "/mtuicontrol stop" })
→ "Session rpc-<id> stopped."
```

---

## `/mmemory` and `/mreview` via mcommand

The same `mcommand` tool replaces the old `MmemoryRecallTool`,
`MmemoryReflectTool`, `MmemoryRetainTool`, and `MReviewTool` which each
duplicated the same 3-line `SCHEDULE_SLASH_CHANNEL` emit pattern.

Skills teach the LLM the command format; `mcommand` does the bridging:

```
mcommand({ command: "/mmemory recall mtuicontrol design" })
mcommand({ command: "/mmemory reflect ESC cancellation fixes" })
mcommand({ command: "/mmemory retain mtuicontrol uses --cmd for spawn" })
mcommand({ command: "/mreview /abs/path/to/file.md" })
```

---

## Known gaps / Phase 3

| Gap | Impact |
|---|---|
| **`extension_ui_request` no public handler** | `RpcClient` captures extension UI requests (confirm/select dialogs in child) in `#extensionUiListeners` but exposes no `onExtensionUi()` / `respondToExtensionUi()` — dialogs time out. ~15 lines to fix in `rpc-client.ts`. |
| **`SHIFT-[A-Z]` chords** | No standard terminal escape; `<SHIFT-ENTER>` uses Kitty protocol which is terminal-dependent. |
| **Child output / panel state** | Master receives structured `AgentEvent` JSONL from child (tool results, turn start/end) — sufficient for control. Panel routing (`!` vs `!!`) and rendered TUI output are the child's concern; no ANSI parsing on master side needed. Child can emit custom events over the same pipe if richer structured state is required. |
| **`--headed` flag** | Removed — redundant. New window is user responsibility via `cmd /c start` in `--cmd`. Already works. |

---

## TODO — Tests to Run

### Test results (2026-05-11)

| Test | Result | Notes |
|---|---|---|
| 1. spawn | PASS | Session ready in ~2s |
| 2. prompt/response | PASS | "child works correctly" |
| 3. command /help | PASS | Slash command scheduled |
| 4. keypress ESC | PASS | Injected 1 key(s) |
| 5. keypress CTRL-C | PASS | Injected 1 key(s) |
| 6. keypress ESC+ESC | PASS | Injected 2 key(s) |
| 7. ESC regression | **PASS** | **73ms after ESC** (was 30s+ before fix) |
| 8. wait auto-escalation | PASS | Session terminated cleanly on timeout |
| 9. stop | PASS | Session removed from pool |
| 10. auto-cleanup on exit | PASS | onExit handler fires on child close |

---

### Prerequisites

- `mtuicontrol.enabled: true` in config (`~/.omp/config.yml` or project config)
- Session started as `o --new` — `InteractiveMode` must be live; headless `-p` mode
  does **not** run `InteractiveMode`, so `SCHEDULE_SLASH_CHANNEL` has no listener
  and `mcommand` calls are silently dropped
- `mcommand` tool visible in tool list (requires `mtuicontrol.enabled: true`)

---

### 1. Basic connectivity

Verify the pipe server starts, child connects, and the session id is returned.

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ followUp contains "Session rpc-<id> ready."
```

- **Pass:** followUp matches `Session rpc-\S+ ready\.`
- **Fail:** timeout, "No handler", or missing id

---

### 2. Prompt / response

Verify the child receives the prompt and produces a response before going idle.

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol prompt reply with exactly three words: child works correctly" })
→ "Prompt sent."

mcommand({ command: "/mtuicontrol wait --timeout 30000" })
→ "Idle after <N>ms."
```

- **Pass:** `wait` returns `Idle after …ms.` (not a timeout/termination message);
  child TUI shows a three-word reply
- **Fail:** wait times out or session is terminated during wait

---

### 3. Slash command injection — `command` subaction

Verify `/help` is scheduled into the child session.

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol command /help" })
→ "Slash command scheduled."

mcommand({ command: "/mtuicontrol wait --timeout 15000" })
→ "Idle after <N>ms."
```

- **Pass:** `command` returns `Slash command scheduled.`; child TUI shows help
  output after `wait` completes
- **Fail:** error from `command`; or `wait` times out

---

### 4. Keypress — single key (`<ESC>`)

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol keypress <ESC>" })
→ "Injected 1 key(s)."
```

- **Pass:** followUp is exactly `Injected 1 key(s).`
- **Fail:** error; count ≠ 1

---

### 5. Keypress — chord (`<CTRL-C>`)

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol keypress <CTRL-C>" })
→ "Injected 1 key(s)."
```

- **Pass:** followUp is `Injected 1 key(s).`; child receives `\x03`
- **Fail:** error or unrecognised key

---

### 6. Keypress — sequence (`<ESC><ESC>`)

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol keypress <ESC><ESC>" })
→ "Injected 2 key(s)."
```

- **Pass:** followUp is `Injected 2 key(s).`
- **Fail:** count ≠ 2; parse error

---

### 7. ESC cancellation regression — core test

Tests the `parallel.ts` abort-race fix. After ESC, the agent must go idle in
<2 s even though a subagent is mid-`bash sleep 30`. This is the primary
reason `mtuicontrol` was built.

**Expected timings:**
- `wait` after prompt: ~5–10 s (child dispatches task, subagent starts `sleep 30`)
- `wait` after ESC: **<2 s** — regression if >2 s or timeout fires

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol prompt use task tool (quick_task) to run bash sleep 30 then output DONE" })
→ "Prompt sent."

mcommand({ command: "/mtuicontrol wait --timeout 25000" })
→ "Idle after ~8000ms."   ← task dispatched, agent waiting for subagent

mcommand({ command: "/mtuicontrol keypress <ESC>" })
→ "Injected 1 key(s)."

mcommand({ command: "/mtuicontrol wait --timeout 5000" })
→ "Idle after ~300ms."   ← must be <2000ms; timeout here = regression

mcommand({ command: "/mtuicontrol stop" })
→ "Session rpc-<id> stopped."
```

- **Pass:** second `wait` resolves in <2 000 ms
- **Fail:** second `wait` hits the 5 000 ms timeout → `parallel.ts` race not fixed

---

### 8. `wait` auto-escalation

Verify that when `wait` times out it injects ESC, waits 3 s, and if still not
idle terminates the session automatically.

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol prompt use task tool (quick_task) to run bash sleep 60 then output DONE" })
→ "Prompt sent."

mcommand({ command: "/mtuicontrol wait --timeout 3000" })
→ "Session rpc-<id> was unresponsive and terminated (<N>ms)."
  OR "Idle after ESC (<N>ms total)."  ← if ESC was sufficient
```

- **Pass:** `wait` either resolves via ESC escalation (`Idle after ESC …`) or
  reports session terminated; session is gone from pool afterwards
- **Fail:** `wait` hangs past `timeout + 3000 + 3000 ms` grace; or session
  remains in pool after termination message

Confirm session is gone:
```
mcommand({ command: "/mtuicontrol list" })
→ "No active sessions."  OR list does not contain the terminated id
```

---

### 9. `list` — both ids appear

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-A ready."

mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-B ready."

mcommand({ command: "/mtuicontrol list" })
→ followUp contains both "rpc-A" and "rpc-B"
```

- **Pass:** both ids present in list output
- **Fail:** only one id; "No active sessions."

Cleanup: `stop` both sessions.

---

### 10. `stop` — session removed from pool

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol stop" })
→ "Session rpc-<id> stopped."

mcommand({ command: "/mtuicontrol list" })
→ "No active sessions."
```

- **Pass:** `list` shows no sessions after `stop`
- **Fail:** id still listed; or `stop` errors

---

### 11. `id` defaulting — single session, commands omit id

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol prompt reply with exactly one word: yes" })
→ "Prompt sent."

mcommand({ command: "/mtuicontrol wait --timeout 20000" })
→ "Idle after <N>ms."

mcommand({ command: "/mtuicontrol keypress <ESC>" })
→ "Injected 1 key(s)."

mcommand({ command: "/mtuicontrol stop" })
→ "Session rpc-<id> stopped."
```

- **Pass:** every command without an explicit `[id]` succeeds using `lastSessionId`
- **Fail:** any command returns "No session id" or "No active sessions"

---

### 12. Multiple sessions — disambiguation error when id omitted

```
mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-A ready."

mcommand({ command: '/mtuicontrol spawn --cmd "o --new --no-memory"' })
→ "Session rpc-B ready."    ← lastSessionId is now rpc-B

mcommand({ command: "/mtuicontrol prompt hello" })
→ "Prompt sent."            ← goes to rpc-B (lastSessionId), NOT an error
```

Note: `lastSessionId` always tracks the most recently spawned session, so a
bare command does NOT produce a disambiguation error — it targets the last
session. The disambiguation error only fires if `lastSessionId` is unset (pool
non-empty but no default established). To reproduce that edge case: manually
clear `lastSessionId` is not currently exposed, so this test validates the
described behaviour (most-recent wins) rather than an error path.

- **Pass:** `prompt` reaches rpc-B without error; `wait` on rpc-B resolves
- **Fail:** command errors; or routed to wrong session

Cleanup: stop both sessions.

---

### 13. `/mmemory recall` via mcommand

```
mcommand({ command: "/mmemory recall mtuicontrol design" })
→ followUp contains recalled notes about mtuicontrol
```

- **Pass:** followUp is non-empty and contains relevant recalled text (not a
  "no results" message); demonstrates `mcommand` routes to `/mmemory` correctly
- **Fail:** error; empty followUp; "command not found"

Note: this test drives the **parent** session's mmemory (no child needed).

---

### 14. `/mreview` via mcommand

```
mcommand({ command: "/mreview /abs/path/to/some/file.md" })
→ followUp confirms UI opened or file loaded
```

Replace `/abs/path/to/some/file.md` with any real `.md` file path accessible
from the running session (e.g. the path to this design doc).

- **Pass:** `mreview` UI opens in the parent terminal / a followUp confirms the
  file was loaded for review
- **Fail:** "command not found"; error; no UI response

Note: this test drives the **parent** session's mreview (no child needed).