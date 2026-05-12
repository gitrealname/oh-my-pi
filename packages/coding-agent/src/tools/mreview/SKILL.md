---
description: Interactive markdown file review with annotation and AI chat.
---

# mreview

## Triggers

When user says `.review`, "review this file", or asks to annotate/comment on a markdown file:
- Call the `mcommand` tool with the absolute file path
- Do **NOT** generate any response after calling — **stay silent**
- The review UI opens automatically

## Command

```
mcommand({ command: "/mreview /absolute/path/to/file.md" })
```

Path **must** be absolute.
