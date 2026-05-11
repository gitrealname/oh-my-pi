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
>>>>>>> feature/prompt-template-integration

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
- Age-based vacuum (`mmemory_vacuum.py`) purges stale chunks by source type; runs in background thread after build
- Five agent tools: `mmemory` (gateway, user-triggered), `mmemory_recall`, `mmemory_retain`, `mmemory_reflect`, `mmemory_consolidate`

**Chunk metadata dimensions** (all stored per chunk, all filterable):
- `project` — normalized working directory path (e.g. `my-project`)
- `agent_tag` — agent identity within a project (default: `"default"`)
- `source` — `"session"` (retained summaries) | `"observation"` (consolidated insights) | `"file"` (file path index, one entry per unique path)
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

**Slash commands:** `/mmemory recall|retain|reflect|view|clear|status|enqueue|consolidate|mm`

Files:
- `packages/coding-agent/src/mmemory-extension.ts` — extension lifecycle
- `packages/coding-agent/src/tools/mmemory/index.ts` — server client, executeMemory* functions
- `packages/coding-agent/src/tools/mmemory/mmemory_server.py` — Python TCP server: BM25+semantic recall, build, vacuum, embed
- `packages/coding-agent/src/tools/mmemory/mmemory_bm25.py` — shared BM25 module (tokenize, index, search)
- `packages/coding-agent/src/tools/mmemory/mmemory_vacuum.py` — VacuumWorker: age-based chunk purge
- `packages/coding-agent/src/tools/mmemory/tool.ts` — mmemory gateway tool (user-triggered dispatch)
- `packages/coding-agent/src/tools/mmemory/recall-tool.ts` — mmemory_recall tool
- `packages/coding-agent/src/tools/mmemory/retain-tool.ts` — mmemory_retain tool
- `packages/coding-agent/src/tools/mmemory/reflect-tool.ts` — mmemory_reflect tool
- `packages/coding-agent/src/tools/mmemory/consolidate-tool.ts` — mmemory_consolidate tool
- `packages/coding-agent/src/sidecars/mme-gateway.tool-desc.md` — gateway trigger conditions
- `packages/coding-agent/src/sidecars/mme-recall.tool-desc.md` — recall tool description
- `packages/coding-agent/src/sidecars/mme-retain.tool-desc.md` — retain tool description
- `packages/coding-agent/src/sidecars/mme-reflect.tool-desc.md` — reflect tool description
- `packages/coding-agent/src/sidecars/mme-consolidate.tool-desc.md` — consolidate tool description
- `packages/coding-agent/src/sidecars/mme-time-filter.prompt.md` — time-filter LLM prompt
- `packages/coding-agent/src/sidecars/mme-recall-preamble.prompt.md` — recall source-filter taxonomy

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
| `mme-gateway.tool-desc.md` | mmemory | Tool description | `<agentDir>/sidecars/` |
| `mme-consolidation.prompt.md` | mmemory | LLM prompt | `<agentDir>/sidecars/` |
| `mme-injection-preamble.md` | mmemory | System prompt | `<agentDir>/sidecars/` |
| `mme-recall-preamble.prompt.md` | mmemory | System prompt | `<agentDir>/sidecars/` |
| `mprune-summarizer.prompt.md` | mprune | LLM prompt | `<agentDir>/sidecars/` |
| `mreview-editor.ui.html` | mreview | Browser UI | `<agentDir>/sidecars/` |

---

### 13. m-prompt-template — Declarative Slash Commands

**Source (original):** [`nicobailon/pi-prompt-template-model`](https://github.com/nicobailon/pi-prompt-template-model) (MIT, Nico Bailon).
All `@mariozechner/pi-*` imports rewritten to `@oh-my-pi/pi-*`.
Ported into `packages/coding-agent/src/m-prompt-template/`.

Turn any `.md` file in `<agent-dir>/prompts/` (global, `PI_CODING_AGENT_DIR/prompts/`) or `{cwd}/.pi/prompts/` (project)
into a `/slash-command`. Frontmatter fields control model routing, skill injection, tool
restriction, memory isolation, and chaining. All switches restore after the command.

**OMP additions vs original PT (not in `nicobailon/pi-prompt-template-model`):**
- `role:` field — resolves via OMP `modelRoles` config; original only has `model:` (explicit string)
- `memory: false` — strips injected memory blocks from system prompt; original PT has no memory system
- `promptTemplates.enabled` setting — extension-level enable/disable; original unconditionally loads
- Factory-body pre-registration (`refreshPrompts(process.cwd())`) for OMP autocomplete timing
- `activate.ts` adapter isolating OMP-specific patches (`sendUserMessage` → `followUp` delivery,
  `model_select` event drop) from the PT source

**Frontmatter reference:**

| Field | Type | Effect | Restored? |
|---|---|---|---|
| `name` | string | Slash command name (required). Type `/prompt:name` to invoke. | — |
| `description` | string | Shown in autocomplete. | — |
| `role` | role name | Switch model via `modelRoles` config. Unknown role = clean abort. | ✓ API |
| `model` | provider/model string | Switch to explicit concrete model. No role resolution. | ✓ API |
| `thinking` | `low`\|`medium`\|`high`\|`none` | Set thinking level. | ✓ API |
| `skill` | skill name | Inject `<agent-dir>/skills/{name}.md` into system prompt. | — |
| `tools` | string list | Restrict active tools to this whitelist. | ✓ API |
| `memory` | `"false"` | Strip `<observations>/<memories>/<referenced_files>` from system prompt. | — |
| `chain` | pipeline string | Sequential step pipeline (`->` separator required). | — |
| `loop` | integer | Repeat body N times with prior-iteration context. | — |

Body text substitution: `$@` = all args, `$1`, `$2`, … = positional.

---

**Example: basic (no special fields)**
```yaml
---
name: greet
description: Greet the user
---
Say hello to: $@
```
Invoked with `/prompt:greet Alice` → sends "Say hello to: Alice" on current model.

**Example: role switch**
```yaml
---
name: quick-answer
role: smol                # → modelRoles["smol"] = openrouter/xiaomi/mimo-v2-flash
description: Fast answer on lightweight model
---
$@
```

**Example: memory isolation**
```yaml
---
name: t3-no-memory
memory: false           # strips <observations>/<memories>/<referenced_files>
description: Execute with clean system prompt (no injected memory)
---
List XML section headers from your system prompt.
```

**Example: tool restriction**
```yaml
---
name: read-only-task
tools:
  - read
  - search
description: Task where only read and search are available
---
$@
```

**Example: skill injection**
```yaml
---
name: architecture-advice
skill: architecture-review   # injects <agent-dir>/skills/architecture-review.md
role: slow
description: Architecture review with injected context
---
Review: $@
```

**Example: chain (sequential pipeline)**
```yaml
---
name: research-and-draft
chain: "research $@ -> draft -> review"    # -> separator required
description: Research topic, draft response, review
---
```
Each step sees the prior steps' output in conversation context.
Ad-hoc chains: `/mchain-prompts step1 -> step2 -> step3`

**Example: full-featured (all controls)**
```yaml
---
name: deep-review
role: slow                    # use slow model (deepseek-v3.2)
thinking: high                # extended thinking
skill: architecture-review    # inject skill into system prompt
memory: false                # strip <observations>/<memories> for this command
tools:                        # only these tools available
  - read
  - search
description: Isolated deep review — no memory, limited tools, slow model
---
Review this code for correctness, edge cases, and design: $@
```

**model: vs role: distinction:**
```yaml
role: slow          # resolved via modelRoles config → concrete string
model: openrouter/qwen/qwen-2.5-72b-instruct  # explicit, no resolution
```
`role:` wins if both specified. Unknown role = clean abort, no fallback to `model:`.
3-segment provider paths (`openrouter/org/name`) supported.

**Built-in commands added by this extension:**
- `/mchain-prompts step1 -> step2` — ad-hoc chain without a frontmatter definition
- `/mprompt-tool [on|off|guidance]` — toggle the run-prompt AI tool (lets the model invoke templates)

**Template discovery:**
```
~/.pi/agent/prompts/    ← global (all sessions, all projects)
{cwd}/.pi/prompts/      ← project-local
~/.pi/agent/prompts_disabled/  ← move here to hide without deleting
```

**Enable/disable:**
```yaml
# Disable entire extension (all templates hidden):
promptTemplates:
  enabled: false

# Hide specific built-in commands (OMP disabledCommands list):
disabledCommands:
  - mchain-prompts
  - mprompt-tool
```

**Files:**
- `packages/coding-agent/src/m-prompt-template/index.ts` — main extension
- `packages/coding-agent/src/m-prompt-template/activate.ts` — OMP adapter (patches + role resolver)
- `packages/coding-agent/src/m-prompt-template/model-selection.ts` — role → model resolution
- `packages/coding-agent/src/m-prompt-template/prompt-loader.ts` — template scanning + registration
- `packages/coding-agent/src/utils/m-utils.ts` — `resolveTemplateModelSpec()` shared utility
- `feature-prompt-template-integration-STATUS.md` — detailed integration notes, OMP vs PI differences

Config key: `promptTemplates.enabled` (default: `true`).
See §15 (Config Surface) for the full table.

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
| mmemory | `mmemory.enabled` | `true` | [docs/mmemory.md](docs/mmemory.md) |
| mmemory storage | `mmemory.storageRoot` | `~/mmemory` | |
| mmemory agent tag | `mmemory.agentTag` | `"default"` | |
| mmemory time-filter model | `mmemory.timeFilterModelRole` | inherits modelRole | |
| mprune | `mprune.enabled` | `false` | [docs/mprune.md](docs/mprune.md) |
| mprune trim | `mprune.trim.softTrimChars` | `12000` | chars (~3k tokens) |
| mprune image aging | `mprune.images.keepTurns` | `5` | |
| MReview command | `mreview.enabled` | `true` | [docs/mreview.md](docs/mreview.md) |
| Script slots | `appScripts.slot1..10.command` | `~` | |
| Prompt templates | `promptTemplates.enabled` | `true` | § 13 |

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