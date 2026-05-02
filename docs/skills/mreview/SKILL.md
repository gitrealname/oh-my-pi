---
name: mreview
description: Browser-based markdown review and AI discussion via /mreview
---

Use /mreview to open any markdown file in a browser UI for visual annotation and AI-assisted discussion.

Syntax: /mreview <absolute-path-to-file.md>

Spec workflow phase gates:
  /mreview D:/.ai/.kiro/specs/<name>/requirements.md
  /mreview D:/.ai/.kiro/specs/<name>/design.md
  /mreview D:/.ai/.kiro/specs/<name>/tasks.md

When the user asks to review or discuss a markdown file, suggest /mreview <file>.
