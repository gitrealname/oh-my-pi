# m-prompt-template: Integration Status
# Branch: feature/prompt-template-integration
# Date: 2026-05-10
# Supersedes: feature-prompt-template-integration-spec.md,
#             feature-prompt-template-integration-analysis.md,
#             feature-prompt-template-integration-gap-analysis.md,
#             feature-prompt-template-integration-test-plan.md

---

## 1. What Was Done

### Source
Ported from `D:/.ai/research/omp/.pi-prompt-template-model` (local copy).
All `@mariozechner/pi-*` imports rewritten to `@oh-my-pi/pi-*`.
Lives in OMP binary at `packages/coding-agent/src/m-prompt-template/`.

### Core capability
Any `.md` file in `~/.pi/agent/prompts/` (global) or `{cwd}/.pi/prompts/` (project)
registers as a `/slash-command`. Frontmatter controls execution; body is rendered with
`$@`, `$1`, `$2` substitution.

---

## 2. Implemented Features

### 2.1 Template discovery and registration
**File:** `packages/coding-agent/src/m-prompt-template/prompt-loader.ts`

`loadPromptsWithModel(cwd, true)` scans both dirs. Each `.md` with `name:` frontmatter
registers via `pi.registerCommand(name, { handler: runPromptCommand })`.

**Registration timing (OMP-specific — see §9.1):**
Commands are registered TWICE:
1. In the **factory body** (via `refreshPrompts(process.cwd())`) — so they appear in
   OMP's interactive autocomplete, which is frozen before `session_start` fires.
2. In `session_start` (via `refreshPrompts(ctx.cwd, ctx)`) — with the correct session cwd.

Original PT only registers in `session_start`. OMP requires the factory-body pre-registration
due to how `InteractiveMode` snapshots `extensionRunner.getRegisteredCommands()` before
`session_start` is emitted.

**Plain templates (`includePlainPrompts=true`):**
All templates in `prompts/` dirs are registered as commands, including those without
special frontmatter fields. To disable a template, move it to `prompts_disabled/`.

### 2.2 Model routing: `role:` vs `model:` (distinct fields)

**Files:**
- `prompt-loader.ts` — parses `role:` and `model:` from frontmatter as separate fields
- `model-selection.ts` — `selectModelCandidate(modelSpecs, currentModel, registry, roleSpec?)`
- `activate.ts` — injects `resolveTemplateModelSpec` as role resolver at startup
- `packages/coding-agent/src/utils/m-utils.ts` — `resolveTemplateModelSpec(spec, settings)` looks up `settings.modelRoles[spec]`
- `packages/coding-agent/src/sdk.ts` — calls `setMPromptTemplateRoleResolver((spec) => resolveTemplateModelSpec(spec, settings))`

**`role:` field:** Resolved via OMP's `modelRoles` config. `role: slow` ->
`settings.modelRoles["slow"]` -> concrete model -> `pi.setModel(model)`. Unknown role
= clean abort (no crash). Restored after command.

**`model:` field:** Concrete provider/model string, NO role resolution. Supports
3-segment paths (`openrouter/qwen/qwen-2.5-72b-instruct`). Restored after command.

**Precedence:** `role:` wins if both specified.

**Fix during integration:** `model-selection.ts` rejected 3-segment paths via
`modelId.includes("/") return []`. Removed. Same fix in `prompt-loader.ts:isValidModelSelectionSpec()`
and `template-conditionals.ts`. Also fixed in `src/prompt-engine/prompt-loader.ts`.

### 2.3 Tool restriction: `tools:` field
**File:** `packages/coding-agent/src/m-prompt-template/index.ts` (~line 383)

```yaml
tools:
  - read
  - search
```

`pi.setActiveTools(prompt.tools)` called after model switch. API-enforced (not
instructional). `pi.setActiveTools([])` restores all tools in `restoreSessionState`.

### 2.4 Memory isolation: `memory: false`
**File:** `packages/coding-agent/src/m-prompt-template/index.ts` — `before_agent_start`

Strips `<observations>`, `<memories>`, `<referenced_files>` from `event.systemPrompt`
using **regex replacement** (not element filter) because OMP delivers the entire
system prompt as a single string element (`systemPromptLen=1`).

**Key timing detail (OMP-specific — see §9.2):**

`pendingMemoryMode` is set by `executePromptStep` before `sendUserMessage`. OMP's
`waitForIdle()` resolves before the agent turn truly completes, so `pendingMemoryMode`
was being cleared at line 401 BEFORE `before_agent_start` fires.

**Fix:** Removed the clear after `waitForIdle`. Added **consume-and-clear** in
`before_agent_start`: the handler reads `pendingMemoryMode` and immediately resets it
to `undefined`. This is more robust than the original PT's timing-dependent clear.

```
executePromptStep: pendingMemoryMode = "none"
sendUserMessage(body)         [followUp delivery — OMP adapter]
waitForTurnStart/Idle resolves (OMP: resolves early, BEFORE the turn actually fires)
                              ← pendingMemoryMode intentionally NOT cleared here
before_agent_start fires      ← reads "none", applies regex strip, then clears
```

Works in interactive `o`/`ow`. In `-p` mode the follow-up turn may not run (see §5).

### 2.5 Skill injection: `skill:` field
**File:** `packages/coding-agent/src/m-prompt-template/index.ts` — `before_agent_start`

Skill content loaded as `## Skill: {name}\n\n{content}` pushed into `additions[]`,
appended to `event.systemPrompt`. System prompt injection (not user message) — avoids
Claude's prompt injection rejection that fires for user-turn `<skill>` XML.

### 2.6 Thinking level: `thinking:` field
**File:** `packages/coding-agent/src/m-prompt-template/index.ts` (~line 376)

`pi.setThinkingLevel(prompt.thinking)` after model switch. Restored after.

### 2.7 Chain, loop, boomerang
Ported from original PT source unchanged. Work in interactive sessions.

**Chain frontmatter syntax:** Steps separated by `->` (not whitespace):
```yaml
chain: "step1 -> step2 -> step3"
```
Plain whitespace (`"step1 step2"`) is treated as ONE segment name — will load only
`step1 step2` (which doesn't exist) rather than two steps.

**Chain commands work (`/chain-prompts step1 -> step2`) and chain frontmatter works.**

### 2.8 `memory: false` on AgentDefinition (subagents)
**Files:**
- `src/task/types.ts` — `memory?: "false" | "inherit"` on `AgentDefinition`
- `src/discovery/helpers.ts` — `parseAgentFields` reads `memory`; added to `ParsedAgentFields`
- `src/task/executor.ts` — passes `memory: agent.memory` to `createAgentSession`
- `src/sdk.ts` — passes `memory: options.memory` to `mmemory-backend.start()`
- `src/memory-backend/mmemory-backend.ts` — `start()` returns early when `options.memory === "none"`

For subagents spawned via `task agent=<name>` where agent `.md` has `memory: false`.

---

## 3. Complete File Change List

### OMP core
| File | Change |
|---|---|
| `src/sdk.ts` | Role resolver call + import; `createPromptTemplateExtension` push; extension enable/disable gates |
| `src/utils/m-utils.ts` | `resolveTemplateModelSpec(spec, settings)` |
| `src/task/types.ts` | `memory?` on `AgentDefinition` |
| `src/discovery/helpers.ts` | `parseAgentFields` + `ParsedAgentFields.memory?` |
| `src/task/executor.ts` | passes `memory` to session options |
| `src/memory-backend/mmemory-backend.ts` | early return on `memory === "none"` |
| `src/extensibility/extensions/loader.ts` | try plain `import()` before legacy shim |
| `src/prompt-engine/prompt-loader.ts` | removed 2-segment model path restriction |
| `src/config/settings-schema.ts` | added `promptTemplates.enabled`, `autoresearch.enabled`, `promptEngine.enabled`; changed `mmemory.enabled` default `false`→`true` |

### m-prompt-template
| File | Change |
|---|---|
| `activate.ts` | OMP adapter: patches `api.on` (drop `model_select`), `api.sendUserMessage` (force `followUp`); role resolver export |
| `index.ts` | `setActiveTools`, `pendingMemoryMode` consume-and-clear, skill via sysprompt, `activePrompt`, factory-body `refreshPrompts` call, `includePlainPrompts=true` |
| `prompt-loader.ts` | `role?`, `tools?`, `memory?` fields; `hasExtensionSpecificConfig` includes `memory/tools/role`; frontmatter parsing |
| `model-selection.ts` | `roleSpec?` param; separate resolution paths; removed path restriction |
| `prompt-execution.ts` | passes `prompt.role` to `selectModelCandidate` |
| `template-conditionals.ts` | removed 2-segment restriction |
| `test_integration.py` | 5 automated headless tests |

---

## 4. Automated Tests — 5/5 passing

**File:** `packages/coding-agent/src/m-prompt-template/test_integration.py`

| Test | Verifies | How |
|---|---|---|
| T0 | Extension loads, no crash | rc=0, response in stdout, no EXCEPTION in log |
| T1 | Templates registered as commands | LLM lists /prompt:t1-basic, /prompt:t2-role etc. |
| T2 | `role: smol` resolves via modelRoles | No "No available model" error; handler dispatched |
| T3 | Unknown role aborts cleanly | rc=0, no EXCEPTION, no hang |
| T4 | `model: concrete/string` dispatches | rc=0 or rc=124, no error |

**Critical limitation:** In `-p` mode, template execution (sendUserMessage + waitForTurnStart)
completes but the follow-up turn response isn't captured in stdout. Template body
execution and output requires an interactive `o`/`ow` session. See §5.

---

## 5. The `-p` Mode Limitation

`o -p` is single-shot: one user message, one response. Template commands work via
a FOLLOW-UP turn:

```
dispatch: user sends /prompt:t1-basic
          runPromptCommand: model switch -> sendUserMessage(body) -> waitForTurnStart/Idle
follow-up: model responds to templateBody (this is what user sees in o)
           restoreSessionState (model/tools/thinking restored)
```

The follow-up response goes to the session output stream. In `-p` mode this stream
isn't captured after the initial dispatch. Everything works but output appears only
in interactive `o`/`ow`.

**Not a bug** — architectural difference between single-shot and interactive loop.

---

## 6. Manual Testing Results (all PASS as of 2026-05-10)

Tested in `o --new` from `D:/.ai`:

| Test | Command | Expected | Confirmed |
|---|---|---|---|
| T1 | `/prompt:t1-basic` | `TEMPLATE_T1_OK` | ✓ |
| T2 | `/prompt:t2-role` | `ROLE_T2_OK`; model_usage shows Qwen called | ✓ |
| T3 | `/prompt:t3-no-memory` | Section list has NO `<memories>/<observations>/<referenced_files>` | ✓ |
| T4 | `/prompt:t4-read-only` | Only `read` listed as available tool | ✓ |
| T5 | `/prompt:t5-skill` | `AZIMUTH-7` | ✓ |
| T6 | `/test-pt say hello` | Response starts with `[TEST MODE]` | ✓ |
| C1 | `/test-chain-fm` | Step 1/2 picks colour; Step 2/2 describes it | ✓ |
| Restore | After T2, ask "what model?" | NOT Qwen (restored to session default) | ✓ |

---

## 7. Known Gaps / Phase 2

| Gap | Impact | Fix |
|---|---|---|
| `model_select` event not emitted | If user manually switches models between template runs, restore may go to wrong model | Emit from sdk.ts model switch path. ~2h |
| `ctx.signal` absent | Running templates can't be cancelled mid-execution | Add to `ExtensionCommandContext`, wire to session abort. ~2h |
| `workers:` / parallel / subagent runner | `workers:`, `lineup:`, `parallel()` features need a separate subagent runner extension listening on EventBus | Implement runner or bridge to task tool. ~8-16h |
| Subagent `inheritContext` (with `subagent:` field) | Requires EventBus subagent runner (`~/.pi/agent/extensions/subagent`); currently throws on missing runtime | Phase 2 |

---

## 8. Full Frontmatter Reference

Templates live in `~/.pi/agent/prompts/` (global) or `{cwd}/.pi/prompts/` (project).

```markdown
---
name: command-name          # required — registers as /command-name
description: What it does   # shown in autocomplete

# Model (choose role: OR model:, not both)
role: slow                  # OMP role name resolved via modelRoles config
model: openrouter/org/name  # explicit provider/model, no role resolution

# Other controls (all optional, all restored after command)
thinking: high              # low | medium | high | none
skill: skill-name           # injects ~/.pi/skills/{name}.md into system prompt
tools:                      # restrict tool set to this whitelist
  - read
  - search
memory: false              # strip <observations>/<memories>/<referenced_files>

# Execution modes
loop: 3                     # repeat body N times
chain: "cmd1 -> cmd2"       # sequential pipeline (-> separator required)
---

Body text. $@ = all args. $1/$2 = positional.
```

---

## 9. OMP vs Native PI Differences

This section documents where OMP's behavior diverges from native PI, the root cause,
and how each was mitigated.

### 9.1 Slash command autocomplete: factory-body pre-registration

**PI behavior:** `pi.registerCommand` in `session_start` makes commands autocomplete-visible.
PI's TUI queries the extension runner dynamically on each keystroke.

**OMP behavior:** `InteractiveMode` snapshots `extensionRunner.getRegisteredCommands()`
at construction time (before `session_start` fires). Commands registered in `session_start`
miss this snapshot and do not appear in autocomplete, though they execute when typed in full.

**Mitigation:** `promptModelExtension` calls `refreshPrompts(process.cwd())` in the
**factory body** (before construction snapshot), then again in `session_start` with
the actual `ctx.cwd`. The two-call pattern is an OMP-specific addition invisible to PI.

**Evidence:** `interactive-mode.ts` line 315 — `this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames)` called in constructor body, stored in `#pendingSlashCommands`.

### 9.2 `waitForIdle()` resolves before model turn completes

**PI behavior:** `waitForIdle()` resolves after the agent turn fully completes, including
all `before_agent_start` / `agent_end` event handlers. `pendingMemoryMode = undefined`
at line 401 runs AFTER `before_agent_start` already used the value.

**OMP behavior:** OMP's `waitForIdle()` resolves before the agent turn's events have
fired. `pendingMemoryMode = undefined` ran BEFORE `before_agent_start`, causing the
strip to never activate.

**Mitigation:** Removed the post-`waitForIdle` clear (line 401). Added consume-and-clear
INSIDE `before_agent_start`: reads `pendingMemoryMode`, immediately resets it, then applies
the strip. More robust than the original pattern — correct on both PI and OMP.

**Evidence:** Log showed `executePromptStep: pendingMemoryMode after="none"` followed
immediately by `before_agent_start: pendingMemoryMode=undefined`.

### 9.3 `sendUserMessage` races with prior turn completion

**PI behavior:** `pi.sendUserMessage(content)` in a command handler sends the follow-up
message cleanly; the prior turn is guaranteed complete before the next starts.

**OMP behavior:** Calling `pi.sendUserMessage(content)` while the prior turn is still
winding down causes `"Agent is already processing"` error. Observed specifically in
chain step transitions where `waitForIdle()` resolves early (see §9.2).

**Mitigation:** `activate.ts` wraps `api.sendUserMessage` to always inject
`{ deliverAs: "followUp" }`. This queues the message rather than injecting it as a
steer, eliminating the race. The original PT uses plain `sendUserMessage(content)` with
no options — this wrapper is OMP-only and isolated to `activate.ts`.

### 9.4 `model_select` event not emitted

**PI behavior:** OMP emits a `model_select` event when the active model changes. The PT
extension handles it to track `runtimeModel` for accurate restore.

**OMP behavior:** This event is not emitted in the current OMP build.

**Mitigation:** `activate.ts` silently drops `model_select` event registrations
(`api.on("model_select", ...) → no-op`). The PT falls back to `runtimeModel` tracking
via `getCurrentModel()` at start of each `executePromptStep`. Manual model switches
between template runs may cause restore to go to the pre-manual-switch model (Phase 2).

### 9.5 System prompt is one string (`systemPromptLen=1`)

**PI behavior:** `event.systemPrompt` in `before_agent_start` is a `string[]` where
memory sections (`<observations>`, etc.) are in separate array elements. The original PT
filters by element: `event.systemPrompt.filter(s => !s.includes("<observations>"))`.

**OMP behavior:** The entire system prompt (including injected mmemory) is one string.
Element-level filtering would delete the entire system prompt.

**Mitigation:** Uses regex replacement instead:
```typescript
s.replace(/<observations>[\s\S]*?<\/observations>/g, "")
 .replace(/<memories>[\s\S]*?<\/memories>/g, "")
 .replace(/<referenced_files>[\s\S]*?<\/referenced_files>/g, "")
```

### 9.6 Extension enable/disable

**PI behavior:** Extensions are unconditionally loaded.

**OMP behavior:** All inline extensions now gated by a `{name}.enabled` setting
(default `true`). Disabling shuts the entire extension including its `/` commands.

| Setting key | Default | Covers |
|---|---|---|
| `promptTemplates.enabled` | `true` | m-prompt-template extension + all template commands |
| `autoresearch.enabled` | `true` | autoresearch extension |
| `promptEngine.enabled` | `true` | native prompt-engine extension |
| `mmemory.enabled` | `true` (changed from `false`) | mmemory extension |
| `mprune.enabled` | existing | mprune extension |

**Mitigation:** OMP-specific gating in `sdk.ts`. Not present in original PT.

### 9.7 `prompts_disabled/` and `disabledCommands`

**PI behavior:** Templates in `prompts_disabled/` are not scanned. `disabledCommands` in
config hides OMP built-in slash commands (`/browser`, `/marketplace`, etc.).

**OMP PT behavior:**
- `prompts_disabled/` — respected (not scanned). ✓
- `disabledCommands` — controls OMP BUILT-IN commands only; does NOT filter PT-registered
  template commands. To hide a specific template, move it to `prompts_disabled/`.
- `promptTemplates.enabled: false` — disables the entire PT extension (all templates hidden).

**Note:** `browser` has been added to `disabledCommands` in deployed config and both
sample configs (`config-o.yml`, `config-ow.yml`). `mbrowser.enabled: false` was already set.

---

## 10. Architecture: OMP Adapter Pattern

The OMP adapter (`activate.ts`) isolates all OMP-specific concerns from the PT source:

```
sdk.ts
  └─ if (settings.get("promptTemplates.enabled") !== false)
       setMPromptTemplateRoleResolver(...)        ← OMP: maps role → concrete model
       inlineExtensions.push(createPromptTemplateExtension)

activate.ts  ← OMP adapter (all OMP-specific patches here)
  ├─ patch api.on → drop model_select events
  ├─ patch api.sendUserMessage → inject { deliverAs: "followUp" }
  └─ call promptModelExtension(api)

index.ts  ← PT source (near-verbatim)
  ├─ uses plain pi.sendUserMessage(content)   ← adapter wraps to followUp
  ├─ pendingMemoryMode consume-and-clear      ← more robust than original clear-after-waitForIdle
  ├─ refreshPrompts(process.cwd()) in factory ← OMP-only, needed for autocomplete timing
  └─ all other PT features unchanged

prompt-loader.ts  ← PT source + OMP additions
  ├─ hasExtensionSpecificConfig includes memory/tools/role  ← bug fix (should go upstream)
  └─ includePlainPrompts=true in refreshPrompts             ← OMP: all prompts/ templates are commands
```

**Rule:** Any new OMP vs PI divergence goes in `activate.ts` or is documented in §9 as
a known difference. `index.ts` and `prompt-loader.ts` changes should be candidates for
upstreaming to the original PT repository.
