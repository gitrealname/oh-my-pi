# Pi Prompt Template Integration — Full Spec
# Branch: feature/prompt-template-integration
# Date: 2026-05-09
# Status: Approved for implementation

---

## 1. What We Are Building

Three complementary layers that together close all identified gaps:

```
Layer A: Native OMP — AgentDefinition memory flag
  └─ memory: none|inherit|isolated on agent .md files
  └─ ~30 lines, zero risk, needed regardless of extension

Layer B: Native OMP — Skill-level role routing
  └─ role: <role-name> in skill frontmatter
  └─ respected at tool execution time via callWithRole wrapper
  └─ ~50 lines, fully independent of extension

Layer C: Template extension — Phase 1 integration
  └─ .md files in ~/.pi/prompts/ register as /commands
  └─ frontmatter: model, thinking, skill, chain, loop
  └─ omp-adapter.ts bridges old interface to OMP loader
  └─ ~4h, unlocks interactive role-routed commands
```

---

## 2. Layer A: AgentDefinition `memory` Flag

### What
Add `memory?: "none" | "inherit" | "isolated"` to `AgentDefinition`.

- `"inherit"` (default, current behavior) — subagent gets full parent memory injection
- `"none"` — mmemory backend skips injection for this session entirely
- `"isolated"` — mmemory injects but uses a separate storage root (future; design only for now)

### Where to change

**File 1: `packages/coding-agent/src/task/types.ts`**
```typescript
interface AgentDefinition {
  // ... existing fields ...
  memory?: "none" | "inherit";   // default: "inherit"
}
```

**File 2: `packages/coding-agent/src/memory-backend/mmemory-backend.ts`**
In `start(session, config)` — before calling `executeMemoryBuild`:
```typescript
const agentDef = session.getAgentDefinition?.();
if (agentDef?.memory === "none") {
    // skip injection entirely for this session
    return;
}
```

**File 3: `packages/coding-agent/src/task/agents.ts`**
Pass `memory` field through when constructing subagent session from definition. Already
threads `tools`, `thinkingLevel`, `model` — add `memory` to same path.

### Usage in agent files

```markdown
---
name: clean-researcher
description: Fresh agent, no prior context contamination
model: pi/slow
memory: none
tools:
  - read
  - search
  - web_search
---
You are a rigorous researcher. Evaluate evidence without prior assumptions.
```

### Test
```bash
# Spawn clean-researcher, verify no <observations>/<memories> in its system prompt
ow -p "task agent=clean-researcher, assignment='say PING and list your system prompt sections'"
# Check: output does NOT contain "observations" or "referenced_files" block headers
```

---

## 3. Layer B: Skill-Level Role Routing

### What
Skills can declare `role:` in their frontmatter. When the LLM calls a tool that
has been registered as a "skill-bound tool", the call executes under that role.

### The challenge (as discussed)
Skills are passive context — there is no discrete "skill invocation" event.
Role routing only makes sense at **tool execution boundaries**, not at context injection.

### Solution: Skill-aware tool wrapper
When a skill is active (injected into system prompt) AND that skill has `role:` in its
frontmatter, the tool's `execute()` is wrapped with `callWithRole()` — but ONLY for
tools explicitly listed in the skill's `tools:` frontmatter field (new field).

**Skill frontmatter extension:**
```markdown
---
name: vision-capture
role: vision           ← new field: role to use for tools listed below
tools:                 ← new field: which tool calls to route to this role
  - pi
  - mreview
description: Clipboard image capture and analysis
---
When the user wants to capture or analyse an image from clipboard...
```

**File 1: `packages/coding-agent/src/capability/skill.ts`**
```typescript
interface SkillFrontmatter {
  name?: string;
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
  role?: string;          // NEW: model role for tool execution
  tools?: string[];       // NEW: which tool names to apply routing to
}
```

**File 2: `packages/coding-agent/src/tools/index.ts`**
In `createTools()` / tool registration, after loading active skills:
- For each active skill with `role:` and `tools:` defined
- Wrap matching tool's `execute()` with a `callWithRole`-style model-switch wrapper

### Important boundary
This applies at tool-call time, not at LLM response generation time.
The model that DECIDES to call the tool is the session model.
The model that EXECUTES the tool's LLM sub-call (if any) uses the role.
For tools that call no LLM (bash, read, write) — `role:` has no effect and is ignored.

### Usage for `.review` → slow model scenario
```markdown
---
name: deep-review-skill
role: slow
tools:
  - mreview
description: Invoke for deep markdown review using slow model
---
When reviewing markdown files, use careful analysis...
```

With this skill active, `mreview` tool's internal LLM call uses `pi/slow`.

### Test
```bash
# Active skill with role:slow, invoke mreview
# Check mmemory log: callWithRole("slow") in mreview execute path
ow -p "review this file: docs/mmemory.md"
grep "callWithRole.*slow" "$LOG"
```

---

## 4. Layer C: Template Extension Phase 1

### What
`.md` files in `~/.pi/prompts/` register as `/commands`.
Frontmatter controls: model routing, thinking level, skill injection, chain, loop.
Semantic bridge: LLM routes `.pi` → `/pi` etc. via tool descriptions.

### Pre-work (OMP changes, ~30 min)

**File: `packages/coding-agent/src/index.ts`** (pi-coding-agent public API)
Add to exports:
```typescript
export { parseFrontmatter } from "./utils/frontmatter";
```

**File: `D:/.ai/research/omp/.pi-prompt-template-model/index.ts`**
Change line 1:
```typescript
// Before:
export default function promptModelExtension(pi: ExtensionAPI) {
// After:
export default async function promptModelExtension(pi: ExtensionAPI) {
```

**File: `D:/.ai/research/omp/.pi-prompt-template-model/prompt-loader.ts`** (or wherever typebox imported)
```typescript
// Before:
import { Type, Static } from "typebox";
// After:
import { Type, Static } from "@sinclair/typebox";
```

**File: `D:/.ai/research/omp/.pi-prompt-template-model/model-selection.ts`**
Add to `PREFERRED_PROVIDERS`:
```typescript
"aws-corp",
"bedrock-converse-stream",
```

### Adapter: `omp-adapter.ts` (new file in extension dir)

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import promptModelExtension from "./index.js";

// Bridges the extension's interface to OMP's loader contract.
// Handles three gaps:
//   1. ctx.signal absent from ExtensionCommandContext
//   2. model_select event not emitted by OMP
//   3. requestDelegatedRun (subagent workers) gracefully stubbed

export default async function activate(api: ExtensionAPI): Promise<void> {
    // Patch: add signal to every command context
    const originalRegister = api.registerCommand.bind(api);
    (api as any).registerCommand = (name: string, def: any) => {
        const original = def.handler;
        def.handler = async (args: string[], ctx: ExtensionCommandContext) => {
            // Inject abort signal stub if absent
            if (!ctx.signal) {
                const ac = new AbortController();
                (ctx as any).signal = ac.signal;
            }
            // Wrap for model restore guarantee
            return original(args, ctx);
        };
        return originalRegister(name, def);
    };

    // Patch: no-op model_select registration (event doesn't exist yet)
    const originalOn = api.on.bind(api);
    (api as any).on = (event: string, handler: any) => {
        if (event === "model_select") return;  // silent no-op until Phase 2
        return originalOn(event, handler);
    };

    // Activate the real extension
    await promptModelExtension(api);
}
```

**File: `D:/.ai/research/omp/.pi-prompt-template-model/package.json`**
```json
{
  "name": "pi-prompt-template-model",
  "version": "1.0.0",
  "omp": {
    "extensions": ["omp-adapter.ts"]
  }
}
```

### systemPrompt threading fix
In `D:/.ai/research/omp/.pi-prompt-template-model/index.ts`, find the
`before_agent_start` handler (~line 1641). The handler snapshots `event.systemPrompt`
before any handler runs. Change to read the live value (already modified by mmemory):

```typescript
// Before (reads pre-handler snapshot):
const baseSystemPrompt = event.systemPrompt;

// After (reads threaded value including mmemory injection):
// Remove snapshot — reference event.systemPrompt directly throughout handler
```

### Deployment
```bash
# Copy extension to discovery path
cp -r D:/.ai/research/omp/.pi-prompt-template-model \
    C:/Users/common/.omp/agent/extensions/prompt-template-model

# Verify discovery (extension loader scans ~/.omp/agent/extensions/)
ow -p "say PING"
# Check log for: [extension] prompt-template-model loaded
```

---

## 5. The `.review` / Semantic Bridge Pattern

### How it works (confirmed from mreview/tool.ts)

1. `mreview.tool-desc.md` declares `<conditions>: User types .review`
2. LLM reads this and calls `mreview` tool
3. Tool emits `SCHEDULE_SLASH_CHANNEL` with `/mreview <path>`
4. After turn ends, `/mreview` fires as a slash command

**The LLM is the semantic bridge.** `.review` → LLM → tool call → slash command.

### To route `.review` through slow model

Two options:

**Option A: Skill-level routing (Layer B)**
Active skill `deep-review-skill` with `role: slow, tools: [mreview]`.
When LLM calls `mreview`, the tool's internal LLM work uses `pi/slow`.
The routing is invisible to the user — `.review` still works.

**Option B: Template override**
Create `/review` template with `model: pi/slow`.
Update `mreview.tool-desc.md` `<conditions>` to match `.review`:
```
<conditions>
- User asks to review, discuss, annotate, or comment on a markdown file
- User types .review
</conditions>
```
Change the tool to schedule `/review` instead of `/mreview`.
Now `.review` → LLM → mreview tool → `/review` template (pi/slow model) → `/mreview` UI.

**Option A is cleaner** for this case. Option B is for when you want the full
pre-processing turn to use a different model.

### Custom `.xxx` → `/xxx` templates (general pattern)

For any skill/command you want with model routing:

```markdown
# ~/.pi/prompts/pi.md
---
name: pi
model: pi/vision
thinking: low
description: Capture and analyse clipboard image
---
$@
```

Update the relevant tool description's `<conditions>` to say the model explicitly:
```
<conditions>
- User types .pi or asks to capture/analyse a clipboard image
- Routes to /pi template which uses vision model
</conditions>
```

Now `.pi` → LLM → schedules `/pi` (via SCHEDULE_SLASH_CHANNEL) → template fires
with vision model. The `.` prefix continues to work as the semantic trigger.

---

## 6. Test Plan (automated)

### Test runner: `test_prompt_template_integration.py`

Place at: `D:/.ai/research/omp/.pi-prompt-template-model/test_integration.py`

**T0 — Extension loads:**
```bash
ow -p "say PING"
# Pass: log has "prompt-template-model loaded", snippetLen > 0, no EXCEPTION
```

**T1 — Basic template execution:**
Template `test-basic.md`: `model: pi/smol`, body: `Say exactly: TEMPLATE_EXECUTED`
```bash
ow -p "/test-basic"
# Pass: stdout contains TEMPLATE_EXECUTED, no EXCEPTION
```

**T2 — Role routing (pi/slow resolves):**
Template `test-slow.md`: `model: pi/slow`, body: `Say exactly: SLOW_MODEL_USED`
```bash
ow -p "/test-slow"
# Pass: stdout contains SLOW_MODEL_USED
# Also: log shows different model used vs T1
```

**T3 — mmemory coexistence (critical):**
```bash
ow -p "/test-basic"
# Pass: log shows snippetLen on template turn >= snippetLen on plain turn
# Fail signal: snippetLen drops = systemPrompt overwrite bug not fixed
```

**T4 — memory:none subagent:**
```bash
ow -p "task agent=clean-researcher, assignment='list your system prompt section headers'"
# Pass: output does NOT contain 'observations' or 'memories' or 'referenced_files'
# Fail signal: those headers appear = memory:none flag not working
```

**T5 — Skill role routing:**
Create skill with `role: smol, tools: [pi]`. Invoke pi tool.
```bash
ow -p ".pi what colour is this"
# Pass: log shows callWithRole("smol") in pi tool execution path
```

**T6 — Graceful degrade: invalid model:**
Template with `model: nonexistent/xyz-9999`
```bash
ow -p "/test-invalid-model"
# Pass: exit code 0, no crash, meaningful error in stdout
```

**T7 — Chain execution:**
Template with 2-step chain
```bash
ow -p "/test-chain"
# Pass: both steps complete, output from step 2 references step 1 output
```

**T8 — Model restore (manual):**
After `/test-slow` completes, send follow-up: "what model are you?"
Verify: response uses smol/default, not slow.
```
[Manual only — requires two prompts in same session]
```

---

## 7. Implementation Order

```
Day 1 (2-3h):
  1. Layer A: memory:none flag (30 min, OMP core)
     → test T4 immediately
  2. Layer C pre-work: parseFrontmatter export + async + typebox (30 min)
  3. Layer C: omp-adapter.ts + systemPrompt fix + package.json (2h)
     → test T0, T1, T2, T3

Day 2 (2h):
  4. Layer B: SkillFrontmatter role+tools fields (1h)
     → test T5
  5. Update .review routing to use slow model via Layer B or template (30 min)
     → test T5 variant
  6. Full test suite run: T0-T7

Day 3 (1h):
  7. Manual T8 (model restore)
  8. Build, deploy, bundle
  9. Commit and push feature branch
```

---

## 8. Files Changed (complete list)

### OMP core (packages/coding-agent/src/)
| File | Change | Layer |
|---|---|---|
| `task/types.ts` | Add `memory?: "none" | "inherit"` to AgentDefinition | A |
| `memory-backend/mmemory-backend.ts` | Check `memory: none` and skip injection | A |
| `task/agents.ts` | Pass `memory` field through to subagent session | A |
| `capability/skill.ts` | Add `role?: string` and `tools?: string[]` to SkillFrontmatter | B |
| `tools/index.ts` | Wrap skill-matching tools with role-based execution | B |
| `index.ts` (public API) | Export `parseFrontmatter` | C |

### Extension (D:/.ai/research/omp/.pi-prompt-template-model/)
| File | Change | Layer |
|---|---|---|
| `index.ts` | `async function` + systemPrompt threading fix | C |
| `prompt-loader.ts` | `typebox` → `@sinclair/typebox` import | C |
| `model-selection.ts` | Add aws-corp + bedrock-converse-stream to PREFERRED_PROVIDERS | C |
| `package.json` | Add `omp.extensions: ["omp-adapter.ts"]` | C |
| `omp-adapter.ts` | NEW: signal mock + model_select noop + registerCommand wrapper | C |

### Deploy
| File | Change |
|---|---|
| `C:/Users/common/.omp/agent/extensions/prompt-template-model/` | Copy extension dir |
| `C:/Users/common/.omp/agent/agents/clean-researcher.md` | Example memory:none agent |

### Future (Phase 2+, not in this spec)
- `extensibility/extensions/types.ts`: add `model_select` event + `ctx.signal`
- `session/agent-session.ts`: emit `model_select` on model switch
- Subagent runner extension for `workers:` / parallel templates
