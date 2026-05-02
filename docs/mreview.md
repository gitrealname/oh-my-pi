# mreview — Browser-Based Markdown Review for omp

**omp-only feature** (aws-corp branch)

Built on [Plannotator](https://github.com/backnotprop/plannotator) by backnotprop.
Licensed MIT / Apache-2.0.

---

## Overview

`/mreview <file.md>` opens any markdown file in a browser UI with:
- **Left panel**: Rendered markdown with inline annotation tools
- **Right panel**: AI chat sidebar connected to the active omp session

The AI chat shares the same agent session — full conversation history, context, and model.

## Usage

```
/mreview D:/.ai/docs/some-file.md
```

Always use absolute paths.

## Workflow

1. Run `/mreview <file>` — agent reads the file into context, browser opens
2. Read the rendered markdown, select text to add inline comments
3. Use the AI chat to discuss the document (same session as terminal)
4. Click **Submit Comments** to send annotations back to the agent
5. Click **Close** to exit without sending
6. Return to terminal — agent has full context of the review

## Inline Annotations

- Select text → comment box opens immediately
- Type comment, press Enter to save
- Click **Ask AI** on any annotation to discuss it with the agent
- Click ✕ to delete an annotation
- Esc closes an open comment box

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `mreview.enabled` | `true` | Enable/disable the command |
| `mreview.browser` | blank | Custom browser executable path |

## Theme

The document panel defaults to light mode. Click ☀️/🌙 in the header to toggle.
Preference is saved in browser localStorage.

## Architecture

- Custom `mreview-ui.html` served from sidecar next to `omp.exe`
- AI queries route directly through the main agent session (no subprocess)
- `node:http` server on random localhost port
- Auto-stops on browser tab close (via `beforeunload` beacon + 60s idle timeout)
- File content injected into agent context before browser opens

## Deploy

Stop omp first (exe is locked while running), then run `deploy.cmd` from the repo root:
```cmd
deploy.cmd
```

Copies both `omp-aws-corp.exe` and `mreview-ui.html` to `%LOCALAPPDATA%\omp\`.
## Files

| File | Purpose |
|---|---|
| `deploy.cmd` | Stop omp → copy binary + HTML sidecar to `%LOCALAPPDATA%\omp\` |
| `packages/coding-agent/src/tools/mreview/mreview-ui.html` | Custom review UI (sidecar) |
| `packages/coding-agent/src/tools/mreview/index.ts` | Orchestration, path resolution |
| `packages/coding-agent/src/tools/mreview/server.ts` | HTTP server, AI routing, endpoints |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | `/mreview` command handler |
