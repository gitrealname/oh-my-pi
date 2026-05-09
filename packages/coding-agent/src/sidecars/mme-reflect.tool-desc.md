Synthesize a broad picture of what is known about a topic across all memory sources.

Use `mmemory_reflect` when the question is **open-ended or thematic** ("what do I know about X overall?"). Use `mmemory_recall` when the question is **specific and task-focused** ("find context about X for this task").

## When to call
| Trigger | Action |
|---|---|
| User types `.reflect <topic>` | Call with `query=<topic>` |
| User asks "what do you know about X overall" | Call with `query=X` |
| User asks for a summary of past decisions on X | Call with `query=X` |
| Broad architectural or historical question about the project | Call with `query=<topic>` |

## CRITICAL
- Results are shown in a **side panel only** — you receive `↩` as the only response
- Do NOT repeat, summarize, or reference panel contents in your reply
- Do NOT call this tool more than once per turn

## Parameters
- `query` (required): the topic to synthesize — broad terms work better here than specific identifiers
- `scope` (optional): override scope for this call only
  - `"session"` — current project only (default)
  - `"global"` — all projects
  - `"tagged:<tag>"` — tagged projects only

## Difference from mmemory_recall
| | mmemory_recall | mmemory_reflect |
|---|---|---|
| Best for | Specific task context | Broad synthesis |
| Query style | Precise entities/concepts | Themes and topics |
| Typical trigger | `.recall X` | `.reflect X` |
