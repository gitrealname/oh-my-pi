---
description: Programmatic control of child OMP sessions via RPC for testing and automation.
---

# mtuicontrol

Spawn and control child OMP sessions. Call `mcommand` for each action. **Stay silent after each call** — the result arrives as a follow-up message.

## Commands

```
/mtuicontrol spawn    --cmd <full command line>
/mtuicontrol prompt   [id] [--timeout N] <message>
/mtuicontrol keypress [id] <ESC><ENTER><CTRL-C>...
/mtuicontrol command  [id] <slash command>
/mtuicontrol stop     [id]
/mtuicontrol list
```

## Notes

- `spawn --cmd` takes the **full command** you want to run. `--rpc-pipe <port>` is appended automatically. On Windows use `cmd.exe /c <command>` — forward slashes only.
- `prompt` is **synchronous** — it sends the message, waits for the full response, and returns it. No separate `wait` needed. Timeout defaults to 25s; auto-injects `<ESC>` on timeout.
- `keypress` injects real keyboard input — `<ESC>` hits the real `onEscape()` path (abortTask, etc.), `<CTRL-C>` sends `\x03`, etc.
- `stop` closes the child window cleanly.
- `[id]` defaults to the last spawned session.

## Example (Windows)

```
mcommand({ command: '/mtuicontrol spawn --cmd "cmd.exe /c ow --new --no-memory"' })
→ "Session rpc-<id> ready."

mcommand({ command: "/mtuicontrol prompt reply with exactly three words: child works correctly" })
→ "Child:\nchild works correctly"

mcommand({ command: "/mtuicontrol keypress <ESC>" })
→ "Injected 1 key(s)."

mcommand({ command: "/mtuicontrol command /help" })
→ 'Command "/help" scheduled.'

mcommand({ command: "/mtuicontrol stop" })
→ "Session rpc-<id> stopped."
```

## ESC regression test

```
mcommand({ command: '/mtuicontrol spawn --cmd "cmd.exe /c ow --new --no-memory"' })
mcommand({ command: "/mtuicontrol prompt use task (quick_task) to run bash: sleep 30, say DONE" })
→ must return in <2s after ESC fires (confirms parallel.ts fix)
mcommand({ command: "/mtuicontrol stop" })
```
