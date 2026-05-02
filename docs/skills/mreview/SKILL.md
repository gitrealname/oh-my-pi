---
name: mreview
description: Browser-based markdown review and AI discussion via /mreview
---

/mreview is a built-in omp slash command. It is NOT implemented here — no files
to read, no server to find. The agent MUST NOT search for implementation files.

When the user types `.mreview <file>`, invokes "review", or asks to discuss a
markdown file, respond with the slash command invocation only:

  /mreview <absolute-path-to-file.md>

Syntax:
  /mreview D:/.ai/docs/some-file.md
  /mreview @file.md   (@ mentions are resolved by omp automatically)

What happens when the user runs it:
- omp injects the file content into the current agent session context
- opens a local browser UI with annotation tools (left) + AI chat (right)
- the AI chat shares this same session — full history and context

Common workflows:
  /mreview D:/.ai/.kiro/specs/<name>/requirements.md
  /mreview D:/.ai/.kiro/specs/<name>/design.md
  /mreview D:/.ai/.kiro/specs/<name>/tasks.md
