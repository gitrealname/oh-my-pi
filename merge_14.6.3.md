# Merge Notes: v14.6.3 into aws-corp

## 1. Merge summary

| | |
|---|---|
| Base (last upstream merge) | `c533b1820` (v14.6.2) |
| Upstream target | `671caba66` (v14.6.3) |
| Merge commit | `beb2e3667` |
| Tag | `v14.6.3-aws-corp` |
| Branch | `aws-corp` |

v14.6.3 adds the Hindsight remote memory system (retain/recall/reflect tools), a `memory.backend`
enum that replaces `memories.enabled` as the canonical memory control, expanded GitHub search tools,
and substantial `settings-schema.ts` UI metadata + a `"memory"` settings tab.

---

## 2. What v14.6.3 adds (upstream summary)

### Hindsight memory system
- Three new tools: `retain`, `recall`, `reflect` (in `packages/coding-agent/src/tools/hindsight-*.ts`)
- Per-session `HindsightSessionState` — tracks bank ID, recall results, mental models across the turn
- Bank scoping modes: `global | per-project | per-project-tagged`
- Mental models: `mentalModelsEnabled`, `mentalModelAutoSeed` — reflect summaries injected into system prompt
- Hindsight client (`hindsight/client.ts`) communicates with a self-hosted or cloud Vectorize endpoint

### `memory.backend` enum
- New canonical control: `off` (default) | `local` | `hindsight`
- `off` — no memory subsystem
- `local` — existing local rollout/summarisation pipeline (`memories.enabled` still works for back-compat)
- `hindsight` — activates Hindsight remote service; gates the `retain`/`recall`/`reflect` tools
- `memories.enabled` still respected in the `local` path but `memory.backend` is the v14.6.3 canonical

### GitHub tools expansion
- `GithubTool` gains code search, file search, issue list, PR list subcommands
- New `github.*` settings keys added to schema

### `ToolSession` interface change
- `getHindsightSessionState?: () => HindsightSessionState | undefined` added to `ToolSession`
- `AgentSession` implements Hindsight lifecycle hooks: `setHindsightSessionState`, `emitNotice`,
  rekey/reset helpers

### `agent-loop.ts`
- `dynamicReasoning` support via `config.getReasoning?.()`

### `settings-schema.ts`
- `SettingTab` gains `"memory"` tab
- Extensive UI metadata added (`label`, `description`, `condition`, `tab`, etc.) across most settings
- `getThinkingLevelMetadata` imported for thinking-level UI rendering
- All `hindsight.*` and `github.*` keys added

### Hashline separator
- `~` is the new default hashline separator (configurable via `PI_HASHLINE_SEP` env var)
- This affects hashline format in edit diffs — note for future hashline comparison tooling

---

## 3. Conflicts encountered and resolutions

### `packages/coding-agent/src/tools/index.ts` — manual resolution required

**What happened:**
- v14.6.3 removed `MBrowserTool` import, `MReviewTool` import, and both entries from `BUILTIN_TOOLS`
- v14.6.3 removed the `SETTINGS_SCHEMA` / `SettingPath` auto-derive fallback in `isToolAllowed`,
  replacing it with `return true` and an explicit case for the Hindsight tools
- v14.6.3 added `import type { HindsightSessionState }` and `getHindsightSessionState?` to `ToolSession`
- git auto-merged the file (no conflict markers) but produced a hybrid: our imports/entries were
  retained alongside upstream's additions, with the old `SETTINGS_SCHEMA` fallback still present

**Resolution applied:**
1. Line 6: changed `import type { Settings, SettingPath }` → `import type { Settings }` (removed `SettingPath`)
2. Line 7: removed `import { SETTINGS_SCHEMA } from "../config/settings-schema";`
3. `isToolAllowed` fallback (was lines 398-400):
   ```ts
   // REMOVED — upstream intent; replaced with explicit gating below
   const enabledSetting = `${name}.enabled` as SettingPath;
   if (enabledSetting in SETTINGS_SCHEMA) return session.settings.get(enabledSetting) !== false;
   return true;
   ```
   Replaced with:
   ```ts
   if (name === "mbrowser") return session.settings.get("mbrowser.enabled");
   if (name === "mreview")  return session.settings.get("mreview.enabled");
   return true;
   ```
4. Retained upstream's `getHindsightSessionState?` in `ToolSession` interface
5. Retained our `MBrowserTool` import (line 28), `MReviewTool` import (line 43)
6. Retained our `mbrowser` and `mreview` entries in `BUILTIN_TOOLS`

### `packages/coding-agent/src/slash-commands/builtin-registry.ts` — conflict in import block

**What happened:**
- aws-corp added 5 import lines at the top of the file for the `.mreview` slash command handler:
  ```ts
  import * as os from "node:os";
  import * as path from "node:path";
  import { existsSync, readFileSync } from "node:fs";
  import { resolve as resolvePath } from "node:path";
  import { hasMReviewHtml, openMReviewSession } from "../tools/mreview/index";
  ```
- v14.6.3 made no changes to this file's imports; git reported the region as a conflict
  because it treated the blank header block as a deletion

**Resolution applied:**
- Accepted our 5 import lines as `<<<< HEAD` side; removed conflict markers
- Upstream file content from line 10 onward was already correct in the merged file

### All other files — auto-merged cleanly
- `packages/coding-agent/src/config/settings-schema.ts`: our additions (mbrowser/mreview keys,
  `disabledCommands`, `browser.connectUrl`) are in a different region from upstream's additions
  (memory tab, hindsight/github keys, UI metadata); 3-way merge succeeded with no overlap
- `packages/coding-agent/src/modes/interactive-mode.ts`: our `waitForIdle`/`SCHEDULE_SLASH_CHANNEL`
  wiring untouched by v14.6.3; auto-merged cleanly
- `packages/coding-agent/src/utils/event-bus.ts`: our `SCHEDULE_SLASH_CHANNEL` export untouched; clean
- `packages/ai/src/providers/aws-corp.ts`: entirely our file; not in upstream; no conflict
- `packages/ai/src/providers/amazon-bedrock.ts`: v14.6.3 made no changes; clean
- `packages/ai/src/stream.ts`: v14.6.3 made no changes; clean
- `packages/coding-agent/CHANGELOG.md`: kept our version bump; discarded upstream's
- `AWS-CORP.md`, `docs/mreview.md`, `deploy.cmd`, `MERGE-INSTRUCTIONS.md`: our files, untouched

---

## 4. aws-corp additions preserved through this merge

| Path | Description |
|---|---|
| `packages/coding-agent/src/tools/mbrowser.ts` | CDP-attach browser tool (mirrors browser.ts but connects via `browser.connectUrl`) |
| `packages/coding-agent/src/tools/mreview/` | Markdown review UI tool (tool.ts, server.ts, index.ts, mreview-ui.html, README.md) |
| `packages/coding-agent/src/modes/interactive-mode.ts` | `SCHEDULE_SLASH_CHANNEL` subscriber with `waitForIdle()` for `.mreview` slash scheduling |
| `packages/coding-agent/src/utils/event-bus.ts` | `SCHEDULE_SLASH_CHANNEL` export |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | `/mreview` slash handler (mreviewHandler + registration in BUILTIN_SLASH_COMMAND_REGISTRY) |
| `packages/ai/src/providers/aws-corp.ts` | Bedrock SSO provider |

**Schema keys preserved:**
- `mbrowser.enabled` — gates the mbrowser tool
- `mreview.enabled` — gates the mreview tool
- `mreview.browser` — custom browser path for mreview UI
- `browser.connectUrl` — CDP URL for mbrowser attachment
- `disabledCommands` — array of slash commands to suppress

---

## 5. Post-merge compile fixes

**`bun tsc --noEmit` on `packages/coding-agent`:**
- Zero errors after applying the manual resolutions above

**Workspace-level `bun tsc --noEmit`:**
- Pre-existing infrastructure errors (TS6305, TS6306, TS6310 regarding missing `.d.ts` artifacts
  in `packages/agent`). These existed before this merge and are unrelated to our changes.
  Only the coding-agent package needs to compile cleanly; it does.

---

## 6. Notes on Hindsight for aws-corp

- `memory.backend: local` in both profiles — keeps the existing rollout/summarisation pipeline active
- The `retain`, `recall`, `reflect` tools are gated in `isToolAllowed` by
  `session.settings.get("memory.backend") === "hindsight"` — they will not appear in the tool list
  unless the backend is switched
- `/memory` slash command is **enabled** — operates as a no-op when backend is `local`
- Hindsight section is documented in both configs with all tuneable keys commented out
- To activate Hindsight in future:
  1. Set `memory.backend: hindsight` in config
  2. Provide `hindsight.apiUrl` and `hindsight.apiToken`
  3. Optionally self-host:
     ```
     docker run --rm -p 8888:8888 -p 9999:9999 \
       -e HINDSIGHT_API_LLM_PROVIDER=anthropic \
       -e HINDSIGHT_API_LLM_API_KEY=<key> \
       ghcr.io/vectorize-io/hindsight:latest
     ```
