# pi-prompt-template-model Integration Handoff
# Target branch: feature/prompt-template-model (branch from aws-corp after merge/14.8.1 lands)
# Prerequisite: merge/14.8.1 complete, tested, fast-forwarded to aws-corp
# Source: D:/.ai/research/omp/.pi-prompt-template-model (branch: omp)
# Generated: 2026-05-09

---

## Prerequisite: What merge/14.8.1 delivers that unlocks this

`legacy-pi-compat.ts` (`src/extensibility/plugins/legacy-pi-compat.ts`) installs a
Bun plugin that rewrites `@mariozechner/pi-*` imports to `@oh-my-pi/pi-*` at load time.
Every import in the extension (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`,
`@mariozechner/pi-agent-core`, `@mariozechner/pi-tui`) is covered. This is a hard
prerequisite — without it every extension import silently resolves to undefined and the
extension fails at first API call.

---

## 1. How extension loading actually works (verified from loader.ts)

**Discovery (no config required):** `discoverAndLoadExtensions()` in
`src/extensibility/extensions/loader.ts` reads:

1. Native `.omp/.pi` capability plugins (built-in only)
2. `getAllPluginExtensionPaths(cwd)` — installed plugins
3. Explicitly configured paths (settings `extensions: [...]` array)

For explicitly configured paths it resolves the directory, reads `package.json`,
and looks for `pkg.omp?.extensions` or `pkg.pi?.extensions` array — these are
relative paths to entry files.

**Fallback:** if no `package.json`, looks for `index.ts` then `index.js`.

**Loading:** `await import(resolvedPath)` — raw Bun native import. Already works
in the compiled binary (this IS the production loader). The `.ts` import question
(Phase 1 in the planning doc) is already answered YES by the existing loader code.
No pre-transpile needed.

**Factory contract:**
```typescript
// The extension must export a default factory function:
export default async function activate(api: ExtensionAPI): Promise<void> {
    api.on("before_agent_start", async (ctx) => { ... });
    api.registerCommand("template", { handler: ... });
    // etc.
}
```
`ExtensionAPI` exposes: `on`, `registerTool`, `registerCommand`, `registerShortcut`,
`registerFlag`, `logger`, `typebox`, `events` (EventBus), `pi` (pi-coding-agent module),
`setModel`, `getThinkingLevel`, `setThinkingLevel`, `sendMessage`, `sendUserMessage`.

**Disabling:** `disabledExtensions: ["extension-module:<name>"]` in settings.
The name is derived from the path via `getExtensionNameFromPath()`.

---

## 2. What needs to change in the extension source

The extension's `index.ts` uses the OLD Pi extension interface:
```typescript
// Current (won't work with OMP loader):
import type { Extension } from "@mariozechner/pi-ai";
export function activate(context: TemplateExtensionContext): void { ... }
export function deactivate(): void { ... }
```

OMP's loader expects a **default-export factory** `(api: ExtensionAPI) => Promise<void>`.
The extension needs an adapter wrapper — NOT a rewrite of its internals.

**Adapter (new file: `omp-adapter.ts` in the extension directory):**
```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createComponentLoader } from "./component-loader.js";
import { createChainRunner } from "./chain-runner.js";

export default async function activate(api: ExtensionAPI): Promise<void> {
    const loader = await createComponentLoader(api);
    const runner = createChainRunner(api);

    // Bridge OMP's before_agent_start to the extension's chain runner
    api.on("before_agent_start", async (ctx: unknown) => {
        await runner.handleBeforeStart(ctx, api);
    });

    // Register /template slash command
    api.registerCommand("template", {
        description: "Run a .md prompt template",
        handler: async (args, ctx) => {
            await runner.runFromCommand(args, ctx, api);
        },
    });
}
```

The extension's internal `activate(context: TemplateExtensionContext)` in
`extension.ts` / `index.ts` still wires component-loader + chain-runner — the adapter
just bridges the interface shape. No changes needed to the extension's core files.

---

## 3. model/skill/thinking frontmatter → OMP API mapping

The extension resolves these frontmatter fields and then calls out to the runtime.
OMP's `ExtensionRuntime` (via `ExtensionAPI`) provides the exact methods needed:

| Template frontmatter | OMP API call | Notes |
|---|---|---|
| `model: claude-sonnet-4` | `api.setModel(modelId)` | Returns `Promise<boolean>` — false if model not found |
| `thinking: medium` | `api.setThinkingLevel("medium")` | `"none"\|"low"\|"medium"\|"high"` |
| `skill: architecture` | Read skill .md, inject via `api.sendMessage()` | Skill files resolved from `~/.omp/agent/skills/` |
| `restore: true` | Save model/thinking before, restore after via same API | Extension handles this via try/finally |

**Model restore pattern:**
```typescript
const prevModel = ...; // captured from session state
const prevThinking = api.getThinkingLevel();
try {
    await api.setModel(resolved.model);
    api.setThinkingLevel(resolved.thinking);
    // ... run template ...
} finally {
    await api.setModel(prevModel);
    api.setThinkingLevel(prevThinking);
}
```
`setModel()` returns `Promise<boolean>` — always check return value; log if false.

---

## 4. Package.json for OMP discovery (drop-in deployment)

Create `D:/.ai/research/omp/.pi-prompt-template-model/package.json` update:
```json
{
    "name": "pi-prompt-template-model",
    "version": "1.0.0",
    "omp": {
        "extensions": ["omp-adapter.ts"]
    }
}
```

**Deploy location:** `C:/Users/common/.omp/agent/extensions/prompt-template-model/`
- Copy the entire extension directory there
- OMP auto-discovers it via `discovery/builtin.ts` → `loadExtensions` →
  reads `package.json` `omp.extensions` field

**No config.yml edit needed.** Auto-discovery handles it.

**To disable:** add `"extension-module:prompt-template-model"` to `disabledExtensions`
array in `agent/config.yml`:
```yaml
disabledExtensions:
  - extension-module:prompt-template-model
```

---

## 5. model-selection.ts compatibility with aws-corp model registry

The extension's `selectModelCandidate()` uses `RegistryLike`:
```typescript
interface RegistryLike {
    find(provider: string, modelId: string): Model | undefined;
    getAll(): Model[];
}
```

OMP's `ModelRegistry` (from `@oh-my-pi/pi-coding-agent`) exposes `.find()` and
`.getAll()`. The `aws-corp` provider (`bedrock-converse-stream`) model ids use
`provider/model-id` slash format — the extension's `getModelCandidates()` has a
slash-index branch that handles this correctly.

**PREFERRED_PROVIDERS alignment:** The extension's `PREFERRED_PROVIDERS` list
does not include `aws-corp` or `bedrock-converse-stream`. When template frontmatter
specifies `model: claude-sonnet`, the selector will find matches in `anthropic` and
`aws-corp` providers. Since `aws-corp` is not preferred, it will fall through to
`anthropic`. **Fix:** add `"aws-corp"` and `"bedrock-converse-stream"` to
`PREFERRED_PROVIDERS` in `model-selection.ts` — one-line change.

---

## 6. mmemory integration (optional, post-integration)

Skill injection today: read a static `.md` file from the skills directory.
Enhanced: if `skill:` frontmatter value matches a known mmemory query pattern,
call `executeMemoryRecall()` and inject the result as skill context.

This requires no extension-side change — the adapter's skill resolution step
can check `api.events` for an active mmemory session and call recall. Future work.

---

## 7. Testing checklist

```
[ ] Phase 1 — Discovery: start ow, check extension loaded message in log
[ ] Phase 2 — Basic template: create test.md with model:/thinking: frontmatter,
              run /template test.md, verify model switches and restores
[ ] Phase 3 — Chain: test 2-step chain, verify context flows between steps
[ ] Phase 4 — Loop: test loop:2, verify 2 iterations
[ ] Phase 5 — Disable: add to disabledExtensions, verify not loaded
[ ] Phase 6 — aws-corp model: specify model: us.anthropic.claude-sonnet-4-5,
              verify bedrock-converse-stream provider resolves correctly
[ ] Phase 7 — mmemory coexistence: run template in session with mmemory active,
              verify no interference (injection still fires, recall still works)
```

---

## 8. Files to create/modify (summary)

| Action | Path | What |
|---|---|---|
| CREATE | `.pi-prompt-template-model/omp-adapter.ts` | OMP factory adapter (bridge old interface to new) |
| MODIFY | `.pi-prompt-template-model/package.json` | Add `"omp": { "extensions": ["omp-adapter.ts"] }` |
| MODIFY | `.pi-prompt-template-model/model-selection.ts` | Add `"aws-corp"`, `"bedrock-converse-stream"` to PREFERRED_PROVIDERS |
| CREATE | `C:/Users/common/.omp/agent/extensions/prompt-template-model/` | Deploy: copy extension dir |
| OPTIONAL | `dist-templates/config-ow.yml` | Add disabledExtensions example (commented out) |
| OPTIONAL | `dist-templates/config-o.yml` | Same |

---

## 9. Branch strategy

```bash
# After merge/14.8.1 is fast-forwarded to aws-corp:
git checkout aws-corp
git checkout -b feature/prompt-template-model

# Make changes (omp-adapter.ts, package.json, model-selection.ts fix)
# Test
# Fast-forward to aws-corp when stable:
git checkout aws-corp
git merge --ff-only feature/prompt-template-model
git push fork aws-corp
```

---

## 10. Time estimate

| Phase | Est. time | Notes |
|---|---|---|
| Write omp-adapter.ts | 1h | Bridge + model-restore pattern |
| package.json update | 5min | One field |
| model-selection.ts fix | 5min | PREFERRED_PROVIDERS one-liner |
| Deploy + discovery test | 15min | Copy, start ow, check log |
| Basic template test | 30min | Create test.md, run, verify |
| Chain/loop tests | 30min | Two more templates |
| aws-corp model test | 15min | Bedrock provider path |
| mmemory coexistence | 15min | Parallel session |
| **Total** | **~3h** | Excluding any unexpected API mismatches |
