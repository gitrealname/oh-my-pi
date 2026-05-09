Search long-term memory for context relevant to the current task.

## When to call
| Trigger | Action |
|---|---|
| User types `.recall <topic>` | Call with `query=<topic>` |
| User asks "what do you remember about X" | Call with `query=X` |
| User asks "do you know anything about X" | Call with `query=X` |
| Task requires context from prior sessions | Call with `query=<current task summary>` |

## CRITICAL
- Results are shown in a **side panel only** — you receive `↩` as the only response
- Do NOT repeat, summarize, or reference panel contents in your reply
- Do NOT call this tool more than once per turn
- The system prompt already injects relevant memories automatically — only call this when the user explicitly asks or the current task clearly needs deeper recall

## Parameters
- `query` (required): what to search for — be specific, use entities and concepts from the current task
- `scope` (optional): override recall scope for this call only
  - `"session"` — current project only (default)
  - `"global"` — all projects
  - `"tagged:<tag>"` — tagged projects only

## Sources searched
- `session` — transcripts from prior work sessions
- `observation` — distilled summaries consolidated from multiple sessions
- `file` — file reads and writes recorded during prior sessions
