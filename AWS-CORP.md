## Credits & Inspirations

This branch builds on the shoulders of people who published good ideas. Here is
everyone who deserves acknowledgement, with specifics about what we borrowed.

### Plannotator — [backnotprop](https://github.com/backnotprop/plannotator) (MIT / Apache-2.0)

The entire browser SPA powering `/mreview` is lifted from Plannotator. The review
editor, DiffViewer, AI chat sidebar (AITab), annotation tools, Submit/Approve/Exit
flow, and all styling are their work. We adapted the AI routing to talk to the local
omp agent session instead of a remote endpoint and embedded the HTML into the binary.
None of the clever UI ideas are ours — we just plumbed the pipes differently.

### Hindsight — [Vectorize](https://github.com/vectorize-io/hindsight) (Apache-2.0)

The design of `mmemory` traces back to Hindsight's architecture: the 5-dimension fact
extraction schema (what/when/where/who/why), the `retainMission` concept for scoping
what to preserve, and the general idea of a local TCP server holding the embedding
model in memory for fast repeated recall. We reimplemented in Python using fastembed
for a fully offline setup and added a flat-store schema with per-chunk metadata
dimensions, but the conceptual model is theirs.

### pi-context-prune — [The Pi team](https://github.com/getpi/context-prune) (MIT)

`mprune` was inspired by pi-context-prune's approach to keeping context windows lean
without busting prefix cache. The insertion-time trim (soft trim at write time) and
batch-summarize pattern are derived from their design. We extended it with image aging,
a persistent stats store, and integration with the OMP compaction pipeline so the
session actually shrinks after a flush (not just gets a steer message bolted on top).

---

# aws-corp Branch — Customizations

Fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) with
enterprise and workflow extensions baked into the binary.

Current base: upstream v14.8.1 (`d4bb2f3f3`)
Upstream: `origin/main` → periodically merged into `aws-corp`. Last merge: 2026-05-09.
See [MERGE-INSTRUCTIONS.md](MERGE-INSTRUCTIONS.md) for merge checklist.

---

## Extensions (built into binary)

### 1. AWS Corp Provider

Bedrock provider using AWS SSO auth (no API keys, no CLI dependency).
Translates model IDs to full inference profile ARNs for corp accounting.
Models defined in `models-ow.yml` (not hardcoded in binary).

Files:
- `packages/ai/src/providers/aws-corp.ts` — provider implementation
- `packages/ai/src/providers/amazon-bedrock.ts` — +2 lines: bedrock-converse-stream type
- `packages/ai/src/stream.ts` — streamAwsCorp import + routing + serviceProviderMap entry
- `packages/coding-agent/src/config/model-registry.ts` — bedrock-converse-stream API type

---

### 2. Prompt Engine

Registers slash commands from `.md` files in agent `commands/` dirs. Supports:
- `role` field → resolves via `modelRoles` config (single source of truth)
- `model` field → direct model spec (fallback)
- `skill` field → auto-injects SKILL.md content
- `thinking` field → sets thinking level for the command
- Dot-prefix skill activation (`.pi describe this`) with auto model switch
- Auto-restore of model + thinking after command completes

Files:
- `packages/coding-agent/src/prompt-engine/index.ts`
- `packages/coding-agent/src/prompt-engine/prompt-loader.ts`
- `packages/coding-agent/src/prompt-engine/model-selection.ts`
- `packages/coding-agent/src/prompt-engine/session-state.ts` (session continuity)

Wired in `packages/coding-agent/src/sdk.ts` as inline extension.

---

### 3. Session Continuity

Tracks files modified/read and commands executed. On compaction, injects
structured context into the summarization prompt via `session.compacting` hook.
Uses `preserveData` for lossless file list survival across multiple compactions.

Config:
```yaml
sessionContinuity:
  enabled: true           # master toggle (default: false)
  maxEvents: 200          # max tracked events per category
  maxContextLines: 30     # max lines injected into compaction prompt
```

---

### 4. MBrowser Tool (CDP-attach browser)

`mbrowser` is a variant of the upstream `browser` tool that auto-attaches to a
running Chrome/Edge instance via `browser.connectUrl` on every `open` action.
No `app.cdp_url` argument needed — set the URL once in config.

Structurally mirrors the upstream `browser.ts` (same 3 actions: open/close/run),
delegates to the shared `browser/*` infrastructure. The only difference is in
`resolveMBrowserKind()` which reads `browser.connectUrl` from settings.

Files:
- `packages/coding-agent/src/tools/mbrowser.ts` — MBrowserTool class
- `packages/coding-agent/src/tools/index.ts` — registration + SETTINGS_SCHEMA fallback
- `packages/coding-agent/src/config/settings-schema.ts` — mbrowser.enabled

Start Chrome with: `--remote-debugging-port=9222`

---

### 5. /mtree Command (tree with peek preview)

`/mtree` opens the session tree with a Ctrl+down peek pane that shows a preview
of the selected branch without navigating to it. The upstream `/tree` is
unchanged (no-peek).

`doubleEscapeAction` config key now accepts `"mtree"` as a value alongside
`"tree"`, `"branch"`, and `"none"`. Scope-switching from double-escape is handled
via a dispatch map in `input-controller.ts` — adding new actions requires one
line in the map.

Files:
- `packages/coding-agent/src/modes/components/tree-peek.ts` — TreePeekComponent
- `packages/coding-agent/src/modes/components/tree-selector.ts` — getTreeList() exposed
- `packages/coding-agent/src/modes/controllers/selector-controller.ts` — showMTreeSelector()
- `packages/coding-agent/src/modes/interactive-mode.ts` — showMTreeSelector() delegation
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` — /mtree entry
- `packages/coding-agent/src/modes/controllers/input-controller.ts` — DOUBLE_ESCAPE_HANDLERS map

---

### 6. disabledCommands

`disabledCommands: []` config — hide slash commands from autocomplete and block
execution. Used to suppress commands not relevant to this profile (loop, fast,
share, login, logout, ssh, marketplace).

Files:
- `packages/coding-agent/src/config/settings-schema.ts` — disabledCommands setting
- `packages/coding-agent/src/extensibility/slash-commands.ts` — isCommandEnabled() filter
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` — execution guard

---

### 7. Local Fixes

| File | Fix |
|---|---|
| `packages/coding-agent/src/edit/normalize.ts` | Count-based majority-wins CRLF detection (vs first-occurrence) |
| `packages/coding-agent/src/modes/components/tree-peek.ts` | ThemeBg/ThemeColor as-any casts; null→undefined for onLabel |
| `packages/coding-agent/src/prompt-engine/index.ts` | renderSkillLoaded updated to new MessageRenderer<T> signature |
| `packages/natives/native/index.js` | detectAvx2Support: os.cpus() fallback for Windows PowerShell 5 |
| `packages/coding-agent/src/system-prompt.ts` | SYSTEM_PROMPT_PREP_TIMEOUT_MS raised to 45s |

---

### 8. /mreview Command (browser markdown review + AI chat)

`/mreview <file.md>` opens any markdown file in a browser review UI with two panels:
- **Left**: rendered markdown with inline annotation tools
- **Right**: AI chat sidebar routed directly through the active omp agent session

The user can annotate visually, discuss with the LLM, and hit **Submit Comments** to
inject structured feedback back into the terminal. No subprocess or external AI — the
browser talks to the same agent session already running.

Files:
- `packages/coding-agent/src/tools/mreview/mreview-editor.ui.html` — review SPA (sidecar, see §12)
- `packages/coding-agent/src/tools/mreview/index.ts` — orchestration, path resolution
- `packages/coding-agent/src/tools/mreview/server.ts` — node:http server, AI routing, endpoints
- `packages/coding-agent/src/tools/mreview/tool.ts` — MReviewTool: emits SCHEDULE_SLASH_CHANNEL
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` — /mreview entry
- `packages/coding-agent/src/utils/event-bus.ts` — SCHEDULE_SLASH_CHANNEL generic mechanism

See [docs/mreview.md](docs/mreview.md) for full documentation.

---

### 9. SCHEDULE_SLASH_CHANNEL (generic tool-to-TUI slash scheduling)

Any tool can schedule a slash command to run after its turn completes by emitting on
`SCHEDULE_SLASH_CHANNEL` via `this.#session.eventBus`. The TUI subscriber in
`interactive-mode.ts` calls `session.waitForIdle()` before firing `editor.onSubmit(command)`,
ensuring the slash command only executes after the agent is fully silent.

Files:
- `packages/coding-agent/src/utils/event-bus.ts` — SCHEDULE_SLASH_CHANNEL constant + docs
- `packages/coding-agent/src/modes/interactive-mode.ts` — subscriber: waitForIdle then onSubmit

---

### 10. mmemory — Local Semantic Memory

Persistent cross-session memory. The agent automatically recalls relevant context
before each turn and retains session content after each turn. Fully offline — no
cloud embedding API. Uses `BAAI/bge-small-en-v1.5` (~25 MB, first-run download).

**Architecture:**
- TypeScript extension (`mmemory-extension.ts`) registers event handlers
- Python TCP server (`mmemory_server.py`) on port 49200 handles embedding and search
- Server starts on first use, self-terminates after 10 min idle, restarts transparently
- Single flat store: `mmemory.storageRoot/chunks.json` + `vectors.safetensors`
- Queue files (`storageRoot/queue/*.md`) staged by extension, processed by server

**Chunk metadata dimensions** (all stored per chunk, all filterable):
- `project` — normalized working directory path (e.g. `D/.ai`)
- `agent_tag` — agent identity within a project (default: `"default"`)
- `source` — `"session"` (retained session chunks) | `"file"` (file path index) | `"observation"` (consolidated insights)
- `ts` — Unix seconds, derived from queue filename at ingest time
- `session_id` — which session produced this chunk

**Recall scoping:**
- Default: per-project (filter by `project` + `agent_tag`)
- `/mmemory /` — switch session scope to global (no filters)
- `/mmemory .` — reset to current project
- `/mmemory <name>` — switch to named project
- `/mmemory recall / <query>` — one-time global without changing session scope

**Temporal queries:**
Natural language time references ("yesterday", "last week", "3 days ago") are
pre-processed by a cheap LLM call that extracts `ts_after`/`ts_before` bounds
before the semantic search. Prompt is sidecar-overridable (see §12).

**Slash commands:** `/mmemory recall|retain|reflect|status|scope`

Files:
- `packages/coding-agent/src/mmemory-extension.ts` — extension factory
- `packages/coding-agent/src/tools/mmemory/` — server client, tools, time-filter
- `packages/coding-agent/src/tools/mmemory/mmemory_server.py` — Python TCP server
- `packages/coding-agent/src/sidecars/mme-time-filter.prompt.md` — time-filter LLM prompt (sidecar)
- `packages/coding-agent/src/sidecars/mme-recall.tool-desc.md` — recall tool description (sidecar)
- `packages/coding-agent/src/sidecars/mme-retain.tool-desc.md` — retain tool description (sidecar)
- `packages/coding-agent/src/sidecars/mme-reflect.tool-desc.md` — reflect tool description (sidecar)

See [docs/mmemory.md](docs/mmemory.md) for full documentation.

Config key: `mmemory:` — see config templates for all options.

---

### 11. mprune — Dynamic Context Pruning

Keeps sessions lean without busting Bedrock prefix cache:
- **Insertion-time trim**: tool results exceeding `softTrimChars` are trimmed at
  write time (40% head / 60% tail). Never modifies existing entries — cache-safe.
- **Batch summarization**: at turn end (text-only agent reply), accumulated
  tool-result batches are summarized via a cheap LLM call. The summary is injected
  as a steer message; original content is replaced with a placeholder so OMP's
  compaction pass has real tokens to reclaim.
- **Image aging**: image bytes older than `keepTurns` turns are replaced with
  lightweight text placeholders.

Slash commands: `/mprune [flush|stats|status]`

Files:
- `packages/coding-agent/src/extensibility/extensions/m-prune-extension.ts` — extension
- `packages/coding-agent/src/session/compaction/mprune-*.ts` — pure logic modules
- `packages/coding-agent/src/sidecars/mprune-summarizer.prompt.md` — summarizer LLM prompt (sidecar)

See [docs/mprune.md](docs/mprune.md) for full documentation.

Config key: `mprune:` — see config templates for all options.

---

### 12. m-utils + Sidecar System

Shared utilities for all "m" family extensions.
`packages/coding-agent/src/utils/m-utils.ts`

**Three concerns handled:**

1. **`createSidecar(path, embedded)`** — embedded-file / local-override pattern.
   Files baked into the binary at build time can be overridden by placing a newer
   version on disk. The binary version is flushed to disk on first use so users
   can find and edit it. Cached in memory after first call.

2. **`resolveRoleModel(roleValue, registry, settings, extras?)`** — standard
   role → model resolution with fallback chain (`role → extras → smol → default`).
   Avoids the `getAll()` / `getApiKey()` runtime crashes documented in
   `.role2model-mapping.md`.

3. **`callWithRole(opts, registry, settings)`** — LLM call combining role resolution,
   `completeSimple` invocation, text extraction, and error handling in one step.
   Returns `string | null`. Never throws.

**Sidecar path resolution** (`sidecarPath(filename)`):
```
<agentDir>/sidecars/<filename>    ← per-agent override  (PI_CODING_AGENT_DIR/sidecars/)
<binaryDir>/sidecars/<filename>   ← machine-wide default
embedded in binary                ← shipped fallback
```

**Use case — multilingual agents:**
Point `PI_CODING_AGENT_DIR` at a different directory containing a `sidecars/`
subdirectory with localized `.md` files. That agent uses its own prompts and tool
descriptions. Other agents on the same machine are unaffected.

**Sidecar naming convention:** `<abbrev>-<purpose>.<type>.<ext>`
- `abbrev`: `mme` (mmemory) | `mprune` | `mreview` | `mtree`
- `purpose`: what the resource does (`time-filter`, `summarizer`, `recall`, etc.)
- `type`: `prompt` | `tool-desc` | `ui`
- `ext`: `md` | `html`

**Current sidecars** (all in `packages/coding-agent/src/sidecars/`):

| File | Tool | Type | Runtime location |
|---|---|---|---|
| `mme-time-filter.prompt.md` | mmemory | LLM prompt | `<agentDir>/sidecars/` |
| `mme-recall.tool-desc.md` | mmemory | Tool description | `<agentDir>/sidecars/` |
| `mme-retain.tool-desc.md` | mmemory | Tool description | `<agentDir>/sidecars/` |
| `mme-reflect.tool-desc.md` | mmemory | Tool description | `<agentDir>/sidecars/` |
| `mme-consolidation.prompt.md` | mmemory | LLM prompt | `<agentDir>/sidecars/` |
| `mme-injection-preamble.md` | mmemory | System prompt | `<agentDir>/sidecars/` |
| `mme-recall-preamble.prompt.md` | mmemory | System prompt | `<agentDir>/sidecars/` |
| `mprune-summarizer.prompt.md` | mprune | LLM prompt | `<agentDir>/sidecars/` |
| `mreview-editor.ui.html` | mreview | Browser UI | `<agentDir>/sidecars/` |

---

### 13. m-prompt-template — Declarative Slash Commands

Source: adapted from [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model)
(MIT, Nico Bailon). All `@mariozechner/pi-*` imports rewritten to `@oh-my-pi/pi-*`.
Copied into binary as `packages/coding-agent/src/m-prompt-template/`.

Turn any `.md` file in `~/.pi/prompts/` (or `~/.pi/agent/prompts/` for global templates)
into a `/slash-command` with full model routing, skill injection, and execution control.

**Frontmatter fields:**

| Field | Type | Effect | Enforced? |
|---|---|---|---|
| `name` | string | Slash command name (required). `/name` to invoke. | — |
| `description` | string | Shown in `/help`. | — |
| `role` | role name | Switch model via `modelRoles` config (`slow`, `smol`, `vision`, `qwen`…). Restored after. Unknown role = clean abort. | Yes — API |
| `model` | provider/model string | Switch to an explicit concrete model (`openrouter/qwen/qwen-2.5-72b-instruct`). No role resolution. Restored after. | Yes — API |
| `thinking` | `low`\|`medium`\|`high`\|`none` | Set thinking level for this command. Restored after. | Yes — API |
| `skill` | skill name | Inject skill file body into system prompt as `## Skill: name`. | Yes — sysprompt |
| `tools` | string list | Restrict active tools to this whitelist for the command. Restored after. | Yes — API |
| `memory` | `"none"` | Strip `<observations>/<memories>/<referenced_files>` from system prompt for this command turn. | Yes — sysprompt |
| `chain` | pipeline string | Run commands sequentially: `/cmd1 $@ -> /cmd2 -> /cmd3`. | — |
| `loop` | integer | Repeat body N times with context from previous iteration. | — |

The template body is rendered with `$@` (all args), `$1`, `$2`, etc. as substitution variables.

**Model routing — `role:` vs `model:` (distinct fields):**

```yaml
# role: — resolved via modelRoles config, no provider string needed
role: slow         # → settings.modelRoles["slow"] = openrouter/deepseek/deepseek-v3.2
role: smol         # → settings.modelRoles["smol"] = openrouter/xiaomi/mimo-v2-flash
role: vision       # → settings.modelRoles["vision"] = google/gemini-2.5-flash
role: qwen         # → custom role added to config

# model: — explicit provider/model string, bypasses role resolution
model: openrouter/xiaomi/mimo-v2-flash
model: openrouter/qwen/qwen-2.5-72b-instruct
model: aws-corp/us.anthropic.claude-sonnet-4-5

# Precedence: role: wins if both specified. Unknown role: clean abort (no fallback).
```

**Full-featured example:**

```markdown
---
name: deep-review
role: slow                    # use slow model (deepseek-v3.2)
thinking: high                # extended thinking
skill: architecture-review    # inject architecture context into system prompt
memory: none                  # strip <observations>/<memories> for this command
tools:                        # only these tools available during this command
  - read
  - search
description: Isolated deep review — no memory contamination, limited tools
---

Review this code for correctness, edge cases, and design: $@
```

**What is controlled (enforced, not instructional):**
- `role:` / `model:` — model switches and restores via `pi.setModel()`. API-enforced.
- `thinking:` — thinking level switches and restores via `pi.setThinkingLevel()`. API-enforced.
- `tools:` — active tool set restricted via `pi.setActiveTools()`. API-enforced.
- `skill:` — skill content added to system prompt before the turn. System-prompt-enforced.
- `memory: none` — `<observations>/<memories>/<referenced_files>` filtered from system prompt. System-prompt-enforced.

**What cannot be controlled from template frontmatter:**
- Session conversation history (visible to model; cannot be cleared per-command)
- `alwaysApply: true` skills already in system prompt (cannot be removed)
- Base OMP system prompt (role/contract/rules always present)

**Chain syntax:** Pipe-delimited command sequence:
```
chain: /research $@ -> /draft -> /review
```
Each step receives the output of the previous step as context.

**Where to put templates:**
```
~/.pi/agent/prompts/    ← global (all sessions, all projects)
~/.pi/prompts/          ← project-local (cwd/.pi/prompts/)
```

Files:
- `packages/coding-agent/src/m-prompt-template/index.ts` — main extension (~1770 lines)
- `packages/coding-agent/src/m-prompt-template/activate.ts` — OMP activation wrapper
- `packages/coding-agent/src/m-prompt-template/model-selection.ts` — role resolution
- `packages/coding-agent/src/m-prompt-template/prompt-loader.ts` — template scanning + registration
- `packages/coding-agent/src/utils/m-utils.ts` — `resolveTemplateModelSpec()` shared utility

Config: templates are auto-discovered — no config key required. To disable:
```yaml
disabledCommands:
  - chain-prompts   # disables the built-in /chain-prompts orchestration command
```

---

### 14. app.script.1-10 (Generic Script Executor)

Ten keybinding slots (`app.script.1` through `app.script.10`) that execute
arbitrary shell commands and route their output into the agent session.

**Output protocol (`@omp:` prefix):**
- `@omp:image <path>` — attach image to pending images
- `@omp:text <content>` — insert text at cursor
- Any other output — inserted as text

Config (in `keybindings.json`):
```json
{ "key": "ctrl+alt+v", "command": "app.script.1" }
```
```yaml
appScripts:
  slot1:
    command: "python path/to/script.py --omp"
```

Files:
- `packages/coding-agent/src/config/keybindings-m-scripts.ts`
- `packages/coding-agent/src/config/settings-schema-m-scripts.ts`

---

## Config Surface

All features are controlled via `config.yml`.
See `research/omp/dist-templates/config-ow.yml` for the fully annotated config.

| Feature | Config Key | Default | Docs |
|---|---|---|---|
| Model roles | `modelRoles.*` | (required) | |
| Session continuity | `sessionContinuity.enabled` | `false` | |
| CDP-attach browser | `browser.connectUrl` | `~` | |
| MBrowser tool | `mbrowser.enabled` | `true` | |
| Disabled commands | `disabledCommands[]` | `[]` | |
| Double-escape action | `doubleEscapeAction` | `"tree"` | options: tree\|mtree\|branch\|none |
| mmemory | `mmemory.enabled` | `false` | [docs/mmemory.md](docs/mmemory.md) |
| mmemory storage | `mmemory.storageRoot` | `~/mmemory` | |
| mmemory agent tag | `mmemory.agentTag` | `"default"` | |
| mmemory time-filter model | `mmemory.timeFilterModelRole` | inherits modelRole | |
| mprune | `mprune.enabled` | `false` | [docs/mprune.md](docs/mprune.md) |
| mprune trim | `mprune.trim.softTrimChars` | `12000` | chars (~3k tokens) |
| mprune image aging | `mprune.images.keepTurns` | `5` | |
| MReview command | `mreview.enabled` | `true` | [docs/mreview.md](docs/mreview.md) |
| Script slots | `appScripts.slot1..10.command` | `~` | |
| Prompt templates | auto-discovered from `~/.pi/agent/prompts/` | — | § 13 |

---

## Build

```bash
cd D:\.ai\research\omp\.oh-my-pi

# Binary (from packages/coding-agent/)
bun run build

# Deploy (stop omp first) — copies binary + sidecars
deploy.cmd

# Bundle for distribution
cd D:\.ai\research\omp
bundle.cmd
```

Bundle output: `D:\.ai\research\omp\dist\omp-dist.zip`

Deploy copies `omp.exe` plus `mreview-editor.ui.html` to `%LOCALAPPDATA%\omp\`.
The sidecar system handles all other sidecars at runtime (flushed to `<agentDir>/sidecars/`
on first use — no manual copy needed).

---

## Notes

- The `aws-corp` branch is periodically rebased onto upstream releases.
  Use `MERGE-INSTRUCTIONS.md` for the checklist.
- Config templates live in `research/omp/dist-templates/` (tracked separately).
- Native `.node` binaries are gitignored — must be built per machine.
- Role → model resolution pitfalls are documented in `.role2model-mapping.md`.
- The `detectAvx2Support()` fix in `index.js` ensures the modern binary
  (with full API including the `Process` class) is loaded on Windows machines
  where PowerShell 5 cannot evaluate `[System.Runtime.Intrinsics.X86.Avx2]`.