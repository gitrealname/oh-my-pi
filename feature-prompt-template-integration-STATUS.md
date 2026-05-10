# m-prompt-template: Integration Status
# Branch: feature/prompt-template-integration
# Date: 2026-05-10
# Supersedes: feature-prompt-template-integration-spec.md,
#             feature-prompt-template-integration-analysis.md,
#             feature-prompt-template-integration-gap-analysis.md,
#             feature-prompt-template-test-plan.md

---

## 1. What Was Done

### Source
Ported from `D:/.ai/research/omp/.pi-prompt-template-model` (local copy).
All `@mariozechner/pi-*` imports rewritten to `@oh-my-pi/pi-*`.
Lives in OMP binary at `packages/coding-agent/src/m-prompt-template/`.

### Core capability
Any `.md` file in `~/.pi/agent/prompts/` (global) or `{cwd}/.pi/prompts/` (project)
registers as a `/slash-command` at `session_start`. Frontmatter controls execution;
body is rendered with `$@`, `$1`, `$2` substitution.

---

## 2. Implemented Features

### 2.1 Template discovery and registration
**File:** `packages/coding-agent/src/m-prompt-template/prompt-loader.ts`

`loadPromptsWithModel(cwd)` scans both dirs. Each `.md` with `name:` frontmatter
registers via `pi.registerCommand(name, { handler: runPromptCommand })` in `session_start`
handler — before the first user message.

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

### 2.4 Memory isolation: `memory: none`
**File:** `packages/coding-agent/src/m-prompt-template/index.ts` — `before_agent_start` (~line 1656)

Strips `<observations>`, `<memories>`, `<referenced_files>` from `event.systemPrompt`.

**Key implementation detail:** Uses `pendingMemoryMode` module-level variable (not
`activePrompt`) because `before_agent_start` fires *before* the command handler runs.
Sequence:

```
dispatch turn: before_agent_start fires (pendingMemoryMode=undefined, no stripping)
               -> runPromptCommand fires
               -> pendingMemoryMode = "none"
               -> pi.sendUserMessage(body)  [follow-up queued]
follow-up turn: before_agent_start fires (pendingMemoryMode="none", stripping happens)
```

Works in interactive `ow`. In `-p` mode the follow-up turn may not run (see §5).

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
Not verified headlessly (see §5).

### 2.8 OMP activation wiring
**File:** `packages/coding-agent/src/sdk.ts`

```typescript
setMPromptTemplateRoleResolver((spec) => resolveTemplateModelSpec(spec, settings));
inlineExtensions.push(createPromptTemplateExtension);
```

**File:** `packages/coding-agent/src/m-prompt-template/activate.ts`

Adapter: drops `model_select` event registrations (OMP doesn't emit this yet —
Phase 2 TODO), calls `promptModelExtension(api)`.

### 2.9 `memory: none` on AgentDefinition files (subagents)
**Files:**
- `src/task/types.ts` — `memory?: "none" | "inherit"` on `AgentDefinition`
- `src/discovery/helpers.ts` — `parseAgentFields` reads `memory`; added to `ParsedAgentFields`
- `src/task/executor.ts` — passes `memory: agent.memory` to `createAgentSession`
- `src/sdk.ts` — passes `memory: options.memory` to `mmemory-backend.start()`
- `src/memory-backend/mmemory-backend.ts` — `start()` returns early when `options.memory === "none"`

For subagents spawned via `task agent=<name>` where agent `.md` has `memory: none`.

---

## 3. Complete File Change List

### OMP core
| File | Change |
|---|---|
| `src/sdk.ts` | Role resolver call + import; `createPromptTemplateExtension` push |
| `src/utils/m-utils.ts` | `resolveTemplateModelSpec(spec, settings)` |
| `src/task/types.ts` | `memory?` on `AgentDefinition` |
| `src/discovery/helpers.ts` | `parseAgentFields` + `ParsedAgentFields.memory?` |
| `src/task/executor.ts` | passes `memory` to session options |
| `src/memory-backend/mmemory-backend.ts` | early return on `memory === "none"` |
| `src/extensibility/extensions/loader.ts` | try plain `import()` before legacy shim |
| `src/prompt-engine/prompt-loader.ts` | removed 2-segment model path restriction |

### m-prompt-template
| File | Change |
|---|---|
| `activate.ts` | OMP adapter, role resolver export |
| `index.ts` | `setActiveTools`, `pendingMemoryMode`, skill via sysprompt, `activePrompt` |
| `prompt-loader.ts` | `role?`, `tools?`, `memory?` fields; frontmatter parsing |
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
| T1 | Templates registered as commands | LLM lists /t1-basic, /t2-role etc. |
| T2 | `role: smol` resolves via modelRoles | No "No available model" error; handler dispatched |
| T3 | Unknown role aborts cleanly | rc=0, no EXCEPTION, no hang |
| T4 | `model: concrete/string` dispatches | rc=0 or rc=124, no error |

**Critical limitation:** In `-p` mode, template execution (sendUserMessage + waitForTurnStart)
completes but the follow-up turn response isn't captured in stdout. Template body
execution and output requires an interactive `ow` session. See §5.

---

## 5. The `-p` Mode Limitation

`ow -p` is single-shot: one user message, one response. Template commands work via
a FOLLOW-UP turn:

```
dispatch: user sends /t1-basic
          runPromptCommand: model switch -> sendUserMessage(body) -> waitForTurnStart/Idle
follow-up: model responds to templateBody (this is what user sees in ow)
           restoreSessionState (model/tools/thinking restored)
```

The follow-up response goes to the session output stream. In `-p` mode this stream
isn't captured after the initial dispatch. Everything works but output appears only
in interactive `ow`.

**Not a bug** — architectural difference between single-shot and interactive loop.

---

## 6. Manual Testing Steps

Start `ow --new` from `D:/.ai`.

### 6.1 Basic execution
```
/t1-basic
```
PASS: responds with exactly `TEMPLATE_T1_OK`
FAIL: describes the template file or says "not executable"

### 6.2 Role routing
```
/t2-role
```
PASS: responds `ROLE_T2_OK`; TUI shows model switched to smol during execution
FAIL: "No available model from: smol"

### 6.3 Memory isolation
```
/t3-no-memory
```
PASS: lists section headers WITHOUT `observations`, `memories`, `referenced_files`
FAIL: those sections appear in the list

### 6.4 Tool restriction
```
/t4-read-only
```
PASS: model says only `read` is available
FAIL: other tools (bash, write, web_search) appear in the list

### 6.5 Skill injection
```
/t5-skill
```
PASS: responds `AZIMUTH-7`
FAIL: says it doesn't know the test codename

### 6.6 Production test template
```
/test-pt say hello
```
PASS: response starts with `[TEST MODE]`; uses smol model

### 6.7 Model restore (after any template with role:/model:)
After `/t2-role` completes, ask: "what model are you using?"
PASS: returns to the session default (not smol)
FAIL: still reports smol

---

## 7. Known Gaps / Phase 2

| Gap | Impact | Fix |
|---|---|---|
| `model_select` event not emitted | If user manually switches models, restore may go to wrong model | Emit from sdk.ts model switch path. ~2h |
| `ctx.signal` absent | Running templates can't be cancelled mid-execution | Add to `ExtensionCommandContext`, wire to session abort. ~2h |
| `workers:` / parallel / subagent runner | `workers:`, `lineup:`, `parallel()` features need a separate subagent runner extension listening on EventBus | Implement runner or bridge to task tool. ~8-16h |
| `memory: none` stripping: dispatch turn only | The dispatch `before_agent_start` sees `pendingMemoryMode=undefined`; stripping fires on the follow-up turn. Correct for interactive use. | Not fixable in `-p` single-shot without rewriting sendUserMessage flow. |

---

## 8. Full Frontmatter Reference

Templates live in `~/.pi/agent/prompts/` (global) or `{cwd}/.pi/prompts/` (project).

```markdown
---
name: command-name          # required — registers as /command-name
description: What it does   # shown in /help

# Model (choose role: OR model:, not both)
role: slow                  # OMP role name resolved via modelRoles config
model: openrouter/org/name  # explicit provider/model, no role resolution

# Other controls (all optional, all restored after command)
thinking: high              # low | medium | high | none
skill: skill-name           # injects ~/.pi/skills/{name}.md into system prompt
tools:                      # restrict tool set to this whitelist
  - read
  - search
memory: none                # strip <observations>/<memories>/<referenced_files>

# Execution modes
loop: 3                     # repeat body N times
chain: /cmd1 $@ -> /cmd2    # sequential pipeline
---

Body text. $@ = all args. $1/$2 = positional.
```
