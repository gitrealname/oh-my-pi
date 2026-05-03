# mreview -- Browser-Based Markdown Review for omp

**omp-only feature** (aws-corp branch)

Borrows rendering patterns and CSS from [Plannotator](https://github.com/backnotprop/plannotator) by backnotprop.
Licensed MIT / Apache-2.0.

---

## Overview

`/mreview <file.md>` opens any markdown file in a browser UI with:
- **Left panel**: Rendered markdown with inline annotation tools
- **Right panel**: AI chat sidebar connected to the active omp session

The AI chat shares the same agent session -- full conversation history, context, and model.

## Usage

```
/mreview D:/.ai/docs/some-file.md
```

Always use absolute paths.

## Workflow

1. Run `/mreview <file>` -- agent reads the file into context, browser opens
2. Read the rendered markdown, select text to add inline comments
3. Use the AI chat to discuss the document (same session as terminal)
4. Click **Submit** to send annotations back to the agent
5. Click **Close** to exit without sending
6. Return to terminal -- agent has full context of the review

## Inline Annotations

- Select text -- comment box opens immediately
- Choose a label: **suggestion**, **nit**, **question**, **issue** (nit pre-selected)
- Type comment, press Enter to save
- Click **Send** on any annotation card to discuss it with the AI
- Click x to delete an annotation
- Esc closes an open comment box

## Feedback Format

When you click **Submit**, annotations are sent to the agent as structured markdown:

```
# Review: filename.md

### Line N (chars X-Y) - "selected text..."
**label:** your comment
```

Annotations are sorted by line number. Labels follow the [Conventional Comments](https://conventionalcomments.org) format.

## UI Controls

| Control | Location | Purpose |
|---|---|---|
| `A-` / `A+` | Header | Adjust font size (8-48px), persisted to localStorage |
| Sun/moon icon | Header | Toggle light/dark theme for document panel |
| Submit | Header | Send all annotations to agent and close |
| Close | Header | Close without sending |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `mreview.enabled` | `true` | Enable/disable the command |
| `mreview.browser` | blank | Custom browser executable path |

## Architecture

- Custom `mreview-ui.html` served from sidecar next to `omp.exe`
- AI queries route directly through the main agent session (no subprocess)
- `node:http` server on random localhost port
- Auto-stops on browser tab close (via `beforeunload` beacon + 60s idle timeout)
- File content injected into agent context before browser opens
- Slash command deferred via `SCHEDULE_SLASH_CHANNEL` until agent is fully idle (`AgentSession.waitForIdle()`)

## Deploy

Stop omp first (exe is locked while running), then run `deploy.cmd` from the repo root:

```cmd
deploy.cmd
```

Copies both `omp-aws-corp.exe` and `mreview-ui.html` to `%LOCALAPPDATA%\omp\`.

To deploy only the sidecar (no binary change needed):

```cmd
copy /Y packages\coding-agent\src\tools\mreview\mreview-ui.html "%LOCALAPPDATA%\omp\mreview-ui.html"
```

## Files

| File | Purpose |
|---|---|
| `deploy.cmd` | Stop omp, copy binary + HTML sidecar to `%LOCALAPPDATA%\omp\` |
| `packages/coding-agent/src/tools/mreview/mreview-ui.html` | Review UI SPA (sidecar, no rebuild needed for UI changes) |
| `packages/coding-agent/src/tools/mreview/index.ts` | Orchestration, path resolution |
| `packages/coding-agent/src/tools/mreview/server.ts` | HTTP server, AI routing, endpoints |
| `packages/coding-agent/src/tools/mreview/tool.ts` | MReviewTool: schedules /mreview via SCHEDULE_SLASH_CHANNEL |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | /mreview handler, agent context injection |
| `packages/coding-agent/src/config/settings-schema.ts` | mreview.enabled, mreview.browser |
