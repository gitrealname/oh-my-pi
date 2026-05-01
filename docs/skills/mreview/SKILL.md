---
name: mreview
description: Browser-based markdown review and AI discussion via /review, /discuss, /mreview
---

Use /review (aliases: /discuss, /mreview) to open any markdown file in a browser UI
for visual annotation and AI-assisted discussion.

Syntax: /review <file.md>  or  /review @file.md

Spec workflow phase gates:
  /review .kiro/private/specs/<name>/requirements.md
  /review .kiro/private/specs/<name>/design.md
  /review .kiro/private/specs/<name>/tasks.md

When the user asks to review or discuss a markdown file, suggest /review <file>.

---
To install: copy this directory to ~/.omp/agent/skills/mreview/
