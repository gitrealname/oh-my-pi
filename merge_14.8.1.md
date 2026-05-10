# Merge Analysis: aws-corp -> main (v14.8.1)
# Generated: 2026-05-09
# Base (fork point): 3d5abbbbb
# main tip:          d4bb2f3f3 (v14.8.1)
# aws-corp tip:      0bf85c1ae

---

## Summary

36 commits landed in main since the fork point. The merge is non-trivial:
47 files overlap (both sides modified), 68 files are new in main only,
57 files are new in aws-corp only. The branch should be rebased onto main
on a dedicated integration branch before merging.

**Correction from initial analysis**: `utils/m-utils.ts` was incorrectly listed as
an overlap/add-add conflict. It does NOT exist in main at any commit (`git show
main:..m-utils.ts` returns fatal). The false positive came from git seeing the file
on disk from the aws-corp checkout. It arrives cleanly on rebase — no conflict.

---

## 1. Structural Changes in main (must understand before rebasing)

### 1.1 Hashline extracted to its own package (src/hashline/)
`src/edit/modes/hashline.ts` and `src/edit/line-hash.ts` were deleted.
All logic moved to `src/hashline/` (15 new files: anchors, apply, diff,
execute, grammar, hash, index, input, parser, prefixes, recovery, stream,
types, utils, bigrams.json). `src/edit/index.ts` now re-exports from the
new package. `src/edit/streaming.ts` was updated to use the new paths.

Impact on aws-corp: aws-corp has `src/edit/index.ts` and `src/edit/streaming.ts`
in the overlap set. The aws-corp changes in these files are minor (1 deletion
in edit/index.ts; 5+/50- in streaming.ts from the mmemory-extension hook cleanup).
The merge conflict here will be purely structural (import path updates) not
semantic.

### 1.2 eval/js/context-manager.ts rewritten via Babel AST (d4bb2f3f3)
The last commit in main rewrites import resolution using Babel AST instead of
regex. aws-corp also modified context-manager.ts (+3/-75 - removed a large
legacy block). These changes are in different regions (main added Babel import
at top and rewrote a function body; aws-corp removed dead code below it).
Risk: MEDIUM. Need careful 3-way merge to keep both the Babel rewrite AND
the dead-code removal.

### 1.3 session-stats: Rust -> Python
`scripts/session-stats/` Rust crate (Cargo.toml, src/main.rs, cmd_tools.rs,
common.rs) was deleted in main. Replaced by Python `analyze`/`sync` commands
(not in the file list above - added elsewhere). aws-corp lists the Rust files
as [main=D aws=M] - aws-corp modified files that main deleted. This is a
DU conflict: the Rust session-stats changes in aws-corp become moot since the
whole crate is gone. On rebase, those commits will produce empty diffs (files
no longer exist in base). Resolution: discard the aws-corp session-stats changes
- the Python replacement in main is the new canonical implementation.

### 1.4 m-utils.ts — aws-corp only, NOT in main (no conflict)

**Correction**: `src/utils/m-utils.ts` is not present in main at any commit.
The initial diff analysis produced a false positive because git saw the file on
the working tree (checked out from aws-corp) while diffing tree objects.
Verified: `git show main:.../m-utils.ts` → `fatal: path exists on disk, but not in main`.
On rebase, m-utils.ts arrives from aws-corp commits with no conflict. No action required.

### 1.5 legacy-pi-compat.ts plugin (1125ba302, a19ed709f)
New file: `src/extensibility/plugins/legacy-pi-compat.ts`.
Two commits:
- `1125ba302`: `installLegacyPiSpecifierShim()` rewrites `@mariozechner/pi-*`
  imports to `@oh-my-pi/pi-*` at Bun plugin load time
- `a19ed709f`: fixed to also resolve bare imports from extension node_modules

`src/extensibility/plugins/loader.ts` updated to call the shim.
`src/extensibility/extensions/loader.ts` also updated.
`src/extensibility/extensions/types.ts` has overlap (main +10/-3, aws +13/-4).

aws-corp does NOT have this feature. The shim is purely additive and lives in
a separate file. Risk: LOW for the shim itself. The types.ts and loader.ts
conflicts need inspection - aws-corp's changes are likely in different regions
(mmemory extension registration vs. Pi shim).

---

## 2. Overlap File-by-File Risk Assessment

| File | Main delta | aws-corp delta | Risk | Notes |
|---|---|---|---|---|
| `tools/index.ts` | +6 (fileReadCache field on SessionContext) | +33/-80 | LOW | Resolved: main adds a field to SessionContext; aws-corp rewrites tool registrations. Different parts of the file — no semantic conflict. |
| `extensibility/extensions/types.ts` | +CustomEditor type, +EditorComponent import cleanup | +executePython, +taskDepth, systemPrompt string | LOW | Non-overlapping: main changes setEditor() signature; aws-corp adds new capability fields. Union both. |
| `edit/index.ts` | +10/-10 | 1 deletion | LOW | main: redirect imports to hashline package. aws-corp: 1 minor deletion. Apply main's import redirects, keep aws-corp deletion. |
| `edit/streaming.ts` | +6/-5 | +5/-50 | MEDIUM | main: small fix. aws-corp: large cleanup. Need to apply main's fix on top of aws-corp's cleaned version. |
| `eval/js/context-manager.ts` | +91/-47 | +3/-75 | HIGH | main: Babel AST rewrite. aws-corp: dead-code removal in different region. Carefully apply both. |
| `utils/m-utils.ts` | NOT IN MAIN | +314 | **NONE** | aws-corp-only; initial analysis was a false positive. Arrives clean on rebase. |
| `config/model-registry.ts` | +18/-10 | +28/-111 | MEDIUM | main: new providers/models. aws-corp: added aws-corp provider. Both additions are additive. |
| `modes/types.ts` | +4/-1 | +1/-16 | LOW | Likely non-overlapping regions. |
| `edit/modes/hashline.ts` | DELETED | 1 minor change | LOW | File is gone in main. aws-corp change becomes moot. |
| `scripts/session-stats/` (3 files) | DELETED | modified | LOW | Whole crate gone in main. aws-corp changes are moot; discard on rebase. |
| `packages/*/package.json` x8 | version bumps | version bumps | LOW | Take main's versions; aws-corp version bumps are older. |
| `bun.lock`, `Cargo.lock` | regenerated | regenerated | LOW | Regenerate after rebase, don't merge. |
| `CHANGELOG.md` x2 | appended | appended | LOW | Concatenate both sides' entries. |
| `.gitignore` | added *.bak | minor additions | LOW | Union both additions. |

---

## 3. New in main — Items to Carry Forward

These are in main only and do not touch aws-corp files. They arrive automatically
on rebase but deserve review:

### High value
- **`src/hashline/`** (15 files) — extracted package, cleaner architecture
- **`legacy-pi-compat.ts`** — Pi extension backwards compat shim (see section 1.5)
- **`edit/file-read-cache.ts`** — caches file reads during edit operations, reduces I/O
- **`tools/notebook.ts`** — Jupyter notebook cell editing tool
- **`tools/mreview/`** — **CORRECTION: mreview is entirely aws-corp original work** (17 files: tool.ts, server.ts, ai/ subdirectory, HTML UI, docs). Not present in main at any commit. No conflict — arrives on merge as aws-corp's own addition.
- **`tools/todo-write.ts`** changes — todo_write tool updates
- **`session-stats` Python** — replaces Rust implementation

### Medium value
- 5 new issue-repro test files (`ai/test/issue-955/957/959/969/976`)
- mprune test suite (`test/mprune-batch/images/prompt/stats/trim.test.ts`)
- eval intent synthesis (`feat: added intent synthesis for eval tool inputs`)
- Gemini 3 Pro thinking level preservation

### Low value / Churn
- Various test file deletions (workspace-tree, tool-discovery, loop-limit etc.)
- Minor provider fixes (minimax, kimi, preserve custom tool call ids)

---

## 4. New in aws-corp — Our Work Not in main

All mmemory work (57 files). The full list is in the commit messages from
`f6a919dba` and `a8451274d`. Key files main does not have:

```
src/memory-backend/mmemory-backend.ts      ← MemoryBackend impl
src/memory-backend/resolve.ts              ← "mmemory" registered
src/memory-backend/types.ts                ← MemoryBackendId union
src/mmemory-extension.ts                   ← extension event handlers
src/config/settings-schema-m-extensions.ts ← mmemory settings
src/tools/mmemory/                         ← all mmemory tools + server
src/sidecars/mme-*.md                      ← mmemory sidecars
src/slash-commands/builtin-registry.ts     ← /mmemory status additions
docs/mmemory.md                            ← user doc
packages/coding-agent/docs/mmemory.md      ← repo doc
```

---

## 5. mreview — Fully aws-corp original, no conflict

mreview is **not in main at any commit** (`git ls-tree -r d4bb2f3f3` has zero mreview files).
The full 17-file implementation (tool.ts, server.ts, ai/ subdirectory, HTML UI, docs) is
aws-corp original work. The earlier note about "main added 11 files" was incorrect.
No merge action needed — the sidecar and tool are already consistent (both ours).
---

## 6. Rebase Strategy

### Recommended approach: rebase aws-corp onto main

```bash
git checkout -b integrate/aws-corp-onto-14.8.1 main
git rebase --onto integrate/aws-corp-onto-14.8.1 3d5abbbbb aws-corp
```

### Expected conflict points (in order of rebase replay):

1. ~~`utils/m-utils.ts` add-add~~ — **not in main, no conflict.**
2. **`tools/index.ts`** — main adds `fileReadCache?` field to `SessionContext` (comment block + field).
   aws-corp rewrites tool registrations. These are in entirely different sections of the file.
   Take both: keep main's field addition, keep aws-corp's registration block.
3. **`extensibility/extensions/types.ts`** — main changes `setEditor()` to require `CustomEditor`
   subclass (not raw `EditorComponent`) and drops `EditorComponent` import. aws-corp adds
   `executePython?`, `taskDepth`, changes `systemPrompt: string[]→string`. Non-overlapping regions.
   Take both: apply main's setEditor change AND aws-corp's capability additions.
4. **`config/model-registry.ts`** — aws-corp added aws-corp provider; main added
   new public providers. Union: keep all new providers from both sides.
5. **`eval/js/context-manager.ts`** — ~~regions should not overlap~~ **CONFIRMED CONFLICT.**
   Both sides modified the same ~65-line import-rewrite block (BASE lines 491-555).
   Main rewrites to Babel AST; aws-corp removes the whole block as dead code.
   Resolution: take main's Babel rewrite (the block survives, properly rewritten).
   The aws-corp deletion was removing the same code main rewrote — functionally
   the Babel version is strictly better. Do NOT take aws-corp's deletion here.
6. **`edit/streaming.ts`** — apply main's small fix on aws-corp's cleaned version.
7. **Session-stats Rust files** — on rebase these aws-corp commits become
   no-ops (files deleted in main). Let git discard them.
8. **`edit/modes/hashline.ts`** — deleted in main, minor aws-corp change. Discard.
9. **Lock files** — `bun.lock`, `Cargo.lock`: regenerate after rebase completes.

### After rebase
- Run `bun install` to regenerate bun.lock
- Cargo.lock: root workspace NOT affected by session-stats removal (it uses its own
  isolated workspace with a gitignored lock). No cargo rebuild needed.
- Build and run test suite
- Verify mmemory tests still pass (test_mmemory.py 20/20, test_injection.py 14/14,
  test_injection_snapshot.py 43/43)

---

---

## 8. Deep-Dive Uncertainty Analysis (2026-05-09)

Pre-merge investigation of all uncertain areas. All 9 items resolved.

---

### 8.1 context-manager.ts — CONFIRMED REAL CONFLICT (risk was understated)

**Finding:** Both sides modified the **same ~65-line block** (BASE lines 491-555,
the `_rewriteImports()` function). Main rewrote it to use Babel AST; aws-corp
deleted it entirely as dead code. These changes produce a real conflict marker on rebase.

**Resolution:** Take main's Babel rewrite. The aws-corp deletion was removing the
exact code main fixed. Main's version is strictly better (Babel AST over regex);
keeping the deletion would drop the only correct import-rewrite implementation.

**Action on rebase:** When conflict appears, checkout --theirs for this file,
then verify aws-corp's other removals in the file (outside lines 491-555) are
still applied on top. Do not blindly take --ours or --theirs for the whole file.

---

### 8.2 mreview sidecar — CORRECTION: mreview is fully aws-corp original

mreview does not exist in main. The premise of this check was wrong. Both tool.ts and
mreview.tool-desc.md are aws-corp's work, already consistent. No cross-branch
verification needed. **Verdict: NO_CONFLICT (aws-corp-only).**

---

### 8.3 eval intent synthesis — SAFE, zero footprint

`intent = (args) => string | undefined` is a synchronous, purely functional method
added to `EvalTool`. It calls the existing `parseEvalInput()` parser and maps cell
titles to strings. No LLM call, no async, no new settings keys, no hot-path latency.
Also added: `readonly summary` (display string) and `readonly loadMode = "discoverable"`.
aws-corp never touched `tools/eval.ts`. **Verdict: SAFE_TO_MERGE, no action.**

---

### 8.4 sdk.ts — LOW risk, non-overlapping regions

Main's changes: `createSession()` gains a `fileReadCache` initialisation line;
`runAgentLoop()` gets minor streaming type fix. Both in regions aws-corp does not touch.
aws-corp's changes: `beforeAgentStart` hook for mmemory `start()` call, and
`refreshBaseSystemPrompt()` call path. These are in entirely separate sections.
No function signature changes that affect aws-corp's hook points. **Verdict: SAFE.**

---

### 8.5 model-registry.ts — SAFE, additive non-overlapping

Main added new public provider literals (Gemini 3 Pro, kimi-k2, minimax variants).
aws-corp added `aws-corp` and `bedrock-converse-stream`. No key collides. Main's
additions are in the public-providers block; aws-corp's are in a separate aws-corp
block. No structural change to the exported types or `getModelConfig()` signature.
**Verdict: SAFE.**

---

### 8.6 extensibility loaders — SAFE, legacy-pi-compat is purely additive

Main changed `extensibility/plugins/loader.ts` to call `installLegacyPiSpecifierShim()`
at startup. aws-corp did not touch `plugins/loader.ts` at all. Main changed
`extensions/loader.ts` to update import paths (hashline package refactor) — aws-corp
did not touch `extensions/loader.ts`. The only overlap in extensibility is
`extensions/types.ts` (confirmed LOW risk, non-overlapping regions).

`legacy-pi-compat.ts` has zero dependency on anything aws-corp modified. It operates
purely at Bun plugin level, transforms module specifiers before resolution. It does
NOT interact with mmemory-extension.ts or the extension loading order.
**Verdict: SAFE, purely additive.**

---

### 8.7 SessionContext fileReadCache — SAFE, different regions of tools/index.ts

Main adds `fileReadCache?: FileReadCache` to `SessionContext` interface and initialises
it in `createSession()`. This is at the top of tools/index.ts (interface definition).
aws-corp's changes to tools/index.ts are the tool-registration block at the bottom
(adds mmemory tools, removes Phase 3 tools, adds `SETTINGS_SCHEMA` fallback).
No aws-corp mmemory tool references `ctx.fileReadCache` — mmemory uses `ctx.sessionManager`
and `ctx.showStatus`. The new field is additive to the interface; no TypeScript errors.
**Verdict: SAFE, REGION_SEPARATE.**

---

### 8.8 session-stats Rust crate — SAFE_DROP

Deleted in main: `scripts/session-stats/` (Cargo.toml + 5 .rs files).
aws-corp modified these files (DU conflict) — those modifications become moot.
Zero aws-corp TypeScript source imports or spawns the session-stats binary.
The crate uses its own isolated `[workspace]` with a gitignored Cargo.lock.
The root Cargo.lock has no entries from session-stats — no regeneration needed.
Python replacements (`scripts/tool_io.py`, `scripts/analyze_small_edits.py`) arrive
automatically. **Verdict: SAFE_DROP. Discard aws-corp's session-stats changes on rebase.**

---

### 8.9 settings-schema.ts — KEY_COLLISION (benign, manual merge required)

Three collisions found:

**1. `memory.backend` values array — MUST MERGE MANUALLY**
Main adds `"hindsight"` to the enum; aws-corp adds `"mmemory"`. Both sides extend
the same `values: [...] as const` array. Git will conflict-mark this.
Resolution: produce `["off", "local", "hindsight", "mmemory"] as const` with
all four `ui.options` entries (off, local, hindsight, mmemory). Neither side's
entry can be dropped — hindsight is upstream's memory backend; mmemory is ours.

**2. `mreview.enabled` and `mreview.browser` — ADD-ADD, trivially resolved**
Both sides independently added identical definitions. Keep one copy.

**3. No structural break** — `SettingPath`, `SchemaNode`, `Settings.get()` unchanged.
All aws-corp reads (`mmemory.*`, `memory.backend`, `mbrowser.enabled`,
`mreview.enabled`, `disabledCommands`) remain type-safe after merge.

**New hindsight keys from main** (27 keys): `hindsight.apiUrl`, `hindsight.apiToken`,
`hindsight.bankId`, and 24 more. These are additive, do not conflict with
`mmemory.*` or `settings-schema-m-extensions.ts` (separate file, no conflict).

---

### 8.10 Summary Table

| Area | Risk | Confirmed Action |
|---|---|---|
| context-manager.ts | **REAL CONFLICT** | Take main's Babel rewrite; reapply aws-corp's other deletions outside that block |
| settings-schema.ts memory.backend | **MANUAL MERGE** | Produce `["off","local","hindsight","mmemory"]` enum |
| settings-schema.ts mreview.* | ADD-ADD identical | Keep one copy |
| mreview sidecar path | SAFE | Exact match |
| eval intent synthesis | SAFE | No action |
| sdk.ts | SAFE | Non-overlapping regions |
| model-registry.ts | SAFE | Additive, no collision |
| extensibility loaders | SAFE | Purely additive |
| tools/index.ts (fileReadCache) | SAFE | Different regions |
| session-stats Rust crate | SAFE_DROP | Discard aws-corp mods, accept deletion |

**Net result: 2 items require manual resolution** (context-manager.ts conflict region,
memory.backend enum). All other 8 areas are clean merges or trivial resolutions.

## 7. Files Safe to Take Wholesale

These overlap files have low semantic conflict risk and a clear winner:

| File | Take | Why |
|---|---|---|
| `edit/index.ts` | merge (main's redirects + aws-corp deletion) | Structural only |
| `modes/types.ts` | merge | Non-overlapping regions |
| `packages/*/package.json` | main | Version numbers; aws-corp's are older |
| `bun.lock` | regenerate | Lock file |
| `Cargo.lock` | regenerate or main | Lock file |
| `CHANGELOG.md` | concatenate | Both append entries |
| `.gitignore` | union | Both add non-overlapping patterns |
| `scripts/session-stats/` | discard aws-corp changes | Crate deleted in main |
| `edit/modes/hashline.ts` | discard aws-corp change | File deleted in main |

---

## 9. pi-prompt-template-model Integration Plan (post-14.8.1)

**Source:** `D:/.ai/research/omp/.pi-prompt-template-model` (branch `omp`)
**Integration target:** `merge/14.8.1` after all merge actions complete and tested
**Status:** OMP-INTEGRATION-TODO.md exists; all checkboxes unchecked

### 9.1 What the extension actually does

This is not a small plugin. It is a full prompt-template execution engine that turns
plain `.md` files with YAML frontmatter into first-class slash commands with their
own model, skill, thinking level, and execution pipeline. Key capabilities:

**Core (model/skill/thinking frontmatter):**
```markdown
---
model: claude-sonnet-4-20250514
skill: tmux
thinking: medium
description: Debug Python in a REPL session
---
Start a Python REPL and help me debug: $@
```
Running `/debug-python my issue` switches the active session model to Sonnet,
injects the tmux skill as a context message, sets thinking level, then restores
everything when done. No manual model switching, no raw model strings anywhere.

**Chain templates** -- multi-step pipelines:
```markdown
chain: research -> draft -> review
```
Each step runs in sequence; context flows between steps via configurable summaries.

**Loop / boomerang execution** -- iterative refinement:
`loop: 3` runs the prompt N times; `boomerang: true` feeds each output back as
input with a generated summary of what changed.

**Deterministic steps** -- shell commands as pipeline stages:
```markdown
deterministic:
  run: cargo test
  handoff: on-failure
```
Run a command; if it fails, hand off to the LLM with the output.

**Subagent delegation** -- parallel workers via EventBus:
```markdown
workers:
  - agent: worker
    count: 3
```
Spawns parallel subagents; collects results; applies via `finalApplier`.

**Best-of-N / compare lineup** -- runs N candidates, reviewer selects best.

### 9.2 Why this is a game changer

OMP currently requires the user or agent to manually manage model selection:
raw model strings in config, manual `/model` commands, no per-task optimization.
This extension makes **every skill a self-contained execution unit** that
knows what model it needs, what context it requires, and how to clean up after
itself. Combined with OMP's existing skill system and mmemory, the workflow becomes:

```
/deep-refactor my-file.ts
  -> switches to large-context model
  -> injects architecture memory via mmemory_recall (skill context)
  -> runs analysis
  -> restores model
  -> mmemory retains findings
```

The chain + loop capabilities turn ad-hoc multi-step workflows into repeatable,
version-controlled pipelines. The deterministic step integration means shell
commands (tests, linters, builds) become first-class pipeline stages with
conditional LLM handoff.

### 9.3 Feasibility assessment (post-14.8.1 merge)

**Phase 1 -- Compiled Bun dynamic import of .ts files**
UNKNOWN. This is the only hard blocker. OMP ships as a compiled Bun binary.
The extension lives as external .ts files in `~/.omp/agent/extensions/`.
`extensions/loader.ts` uses native Bun `import()` to load them.
Whether compiled Bun can `import()` external .ts files at runtime (not during
compile) is not documented. If it cannot: extensions must be pre-transpiled
to .js before deploy. The `install.cmd` would handle this via `bun build`.
Test: place a minimal `activate/deactivate` extension at the expected path,
run the compiled binary, check if it loads without error.

**Phase 2 -- Import namespace rewrite**
RESOLVED by `legacy-pi-compat.ts` (arriving in 14.8.1 merge).
The shim rewrites `@mariozechner/pi-*` to `@oh-my-pi/pi-*` at Bun plugin
load time. ALL of the extension's imports (`@mariozechner/pi-coding-agent`,
`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-tui`)
are covered. Phase 2 is now a zero-effort no-op.

**Phase 3 -- Scope trim**
NOT required. The extension has no npm dependencies beyond `@mariozechner/*`
(covered by shim) and `node:fs/path/os` (built-in). The subagent EventBus
pattern uses OMP's existing `EventBus` infrastructure -- no separate install.
Chain, loop, deterministic, best-of-N all self-contained.

**Phase 4 -- Config & deploy**
Mechanical. Add extension entry to both `config-ow.yml` and `config-o.yml`:
```yaml
extensions:
  - path: ~/.omp/agent/extensions/prompt-template-model/index.ts
    disabled: false
```
Update `install.cmd` to copy extension files. One-time effort.

**Phase 5 -- Test**
Standard: create a test template with `model:` frontmatter, verify switch+restore
in both `o` and `ow` profiles, verify `disabledExtensions` toggle works.

**Phase 6 -- model-selection.ts alignment**
The extension's `selectModelCandidate()` uses `RegistryLike.find(provider, modelId)`
and `getAll()`. OMP's `ModelRegistry` exposes both. The `aws-corp` provider
(`bedrock-converse-stream`) needs to appear in `PREFERRED_PROVIDERS` or be
handled by the `provider/model-id` path (it is -- `aws-corp/model-id` format
works via the slash-index branch in `getModelCandidates()`).

**mmemory integration opportunity:**
`skill:` frontmatter currently injects a static skill file as context.
An enhanced version could inject mmemory_recall results instead of (or in
addition to) a static skill file -- `.recall architecture` as a dynamic skill
source. This is a future extension point, not required for Phase 1.

### 9.4 Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Compiled Bun cannot `import()` external .ts | MEDIUM | HIGH | Pre-transpile to .js via bun build in install.cmd |
| `parseFrontmatter` from `@oh-my-pi/pi-coding-agent` API changed | LOW | MEDIUM | Verify signature after shim resolves imports |
| `EventBus` subagent events not wired in OMP | LOW | LOW | Subagent features degrade gracefully; core model/skill/thinking unaffected |
| `ModelRegistry.find()` API differs from `RegistryLike` contract | LOW | MEDIUM | Adapter shim in 10 lines if needed |
| `restore: true` model-restore leaves session in wrong state after error | LOW | LOW | OMP session recovery handles this; restore is a best-effort operation |

### 9.5 Action items (ordered)

1. **Merge 14.8.1 first** -- `legacy-pi-compat.ts` is a prerequisite. Phase 2 is free only after it lands.
2. **Phase 1 feasibility test** -- 30 minutes. Create `~/.omp/agent/extensions/test/index.ts` with
   `export function activate() { console.log("loaded"); }`, start `ow`, check console output.
3. **If .ts import works** -- wire Phase 4 (config + deploy) and Phase 5 (test templates). ETA: 2 hours.
4. **If .ts import fails** -- add `bun build --target=bun` pre-transpile step to `install.cmd`. ETA: +1 hour.
5. **mmemory skill integration** -- optional follow-on, not on critical path.

### 9.6 Integration branch strategy

Do NOT integrate on `merge/14.8.1`. Create a separate branch after the merge is clean:
```bash
git checkout aws-corp
git checkout -b feature/prompt-template-model
```
This keeps the 14.8.1 merge diff reviewable and the template integration separately
reversible. Both can be on `aws-corp` via fast-forward merges in sequence.
