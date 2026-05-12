---
description: Project memory — recall, reflect, and retain insights across sessions.
---

# mmemory

## Triggers

When user types `.recall [query]`, `.reflect [topic]`, or `.retain [content]`:
- Call the `mcommand` tool immediately with the command below
- If no query/topic/content given, infer from current conversation context
- Do **NOT** ask the user for input first
- After calling `mcommand`, **stay silent** — the result arrives as a follow-up

## Commands

```
mcommand({ command: "/mmemory recall <query>" })
mcommand({ command: "/mmemory reflect <topic>" })
mcommand({ command: "/mmemory retain <content>" })
```
