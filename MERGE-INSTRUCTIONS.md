# Upstream Merge Instructions for aws-corp Branch

When merging upstream `main` into `aws-corp`, follow this checklist.

Current merge base: `3d5abbbbb` (v14.8.0 — last point before 14.8.1 delta; where aws-corp forked from main)
Last completed merge: `merge_14.6.3.md` (c533b1820 -> 671caba66)
In progress: `merge_14.8.1.md` — branch `merge/14.8.1` created from aws-corp tip `0bf85c1ae`

---

## Merge Command

```bash
cd D:\.ai\research\omp\.oh-my-pi

# Fetch upstream
git fetch origin
git log --oneline aws-corp..origin/main   # review what changed

# Suggested: rebase onto main on a dedicated branch (preferred over merge)
git checkout aws-corp
git checkout -b merge/<version>
git rebase origin/main
# Resolve conflicts (see merge_<version>.md for per-file guidance)
# Build, test, then fast-forward aws-corp:
git checkout aws-corp && git merge --ff-only merge/<version>
git push fork aws-corp

# Alternative: merge commit (simpler but creates noisier history)
# git merge origin/main -m "merge: upstream <version> into aws-corp"
```

---

## Post-Merge Checklist

### 1. New Model Providers

**Where:** `packages/ai/src/stream.ts` -- new entries in `serviceProviderMap`.

**Action:** Add the new provider ID to `disabledProviders` in all 4 config files:
- `~/.omp/agent-work/config.yml`
- `~/.omp/agent/config.yml`
- `research/omp/dist-templates/config-ow.yml`
- `research/omp/dist-templates/config-o.yml`

### 2. New Discovery Providers

**Where:** `packages/coding-agent/src/discovery/` -- files with `PROVIDER_ID`.

**Action:** Add to `disabledProviders` in all 4 config files.

Current known list: `native`, `claude`, `codex`, `gemini`, `agents-md`, `agents`,
`claude-plugins`, `cline`, `cursor`, `windsurf`, `vscode`, `github`, `mcp-json`,
`opencode`, `ssh-json`, `github-copilot`, `fireworks`.

**Check at merge time:** diff `packages/ai/src/stream.ts` serviceProviderMap and
`packages/coding-agent/src/discovery/` for new PROVIDER_ID constants.

### 3. New Slash Commands

**Where:** `packages/coding-agent/src/slash-commands/builtin-registry.ts`.

**Action:** Decide if it should be disabled. If so, add to `disabledCommands`.

### 4. New Tools / Settings

**Where:** `packages/coding-agent/src/config/settings-schema.ts`.

**Action:** Diff the schema for new keys. Add to all 4 config files with:
- Description of what the setting does
- `# (default: X)` if kept at default
- `# options: a | b | c` for enum types
- URL to public docs if it's a third-party component

### 5. Native addon changes

**Where:** `crates/pi-natives/` -- check if any new Rust API was added.

**Action if yes:**
```bash
# Use build.cmd (canonical) -- stop omp first
D:\.ai\research\omp\build.cmd
D:\.ai\research\omp\deploy.cmd
D:\.ai\research\omp\bundle.cmd

# Or manually if isolating native-only rebuild:
TARGET_VARIANT=baseline bun run packages/natives/scripts/build-native.ts
TARGET_VARIANT=modern   bun run packages/natives/scripts/build-native.ts
```

Note: `packages/natives/native/index.js` has our AVX2 detection patch
(`os.cpus()` fallback). Verify it survives if upstream touches that file.

### 6. browser/* changes

**Where:** `packages/coding-agent/src/tools/browser/`

`mbrowser.ts` imports from `browser/*` (registry, tab-supervisor, tab-protocol,
readable). Verify these still export the same API after merge:
- `acquireBrowser`, `BrowserHandle`, `BrowserKind`, `BrowserKindTag` from `browser/registry`
- `acquireTab`, `runInTab`, `releaseTab`, `releaseAllTabs`, `getTab`, `dropHeadlessTabs` from `browser/tab-supervisor`
- `Observation`, `ScreenshotResult` from `browser/tab-protocol`
- `extractReadableFromHtml`, `ReadableFormat`, `ReadableResult` from `browser/readable`

---

## Files We Modify (conflict risk every merge)

| File | Our changes |
|------|-------------|
| `packages/ai/src/stream.ts` | streamAwsCorp import + bedrock-converse-stream routing + serviceProviderMap entry |
| `packages/ai/src/providers/aws-corp.ts` | NEW -- SSO/Bedrock provider |
| `packages/ai/src/providers/amazon-bedrock.ts` | +2 lines: bedrock-converse-stream model type |
| `packages/coding-agent/src/config/settings-schema.ts` | disabledCommands + mbrowser.enabled settings |
| `packages/coding-agent/src/config/settings-schema-m-extensions.ts` | NEW -- mmemory settings schema |
| `packages/coding-agent/src/config/model-registry.ts` | +2 lines: bedrock-converse-stream literals |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | /mtree + /mmemory status + isCommandEnabled guard |
| `packages/coding-agent/src/extensibility/slash-commands.ts` | isCommandEnabled() + filter |
| `packages/coding-agent/src/extensibility/extensions/types.ts` | +executePython, +taskDepth, systemPrompt string->string[] revert |
| `packages/coding-agent/src/memory-backend/mmemory-backend.ts` | NEW -- MemoryBackend impl |
| `packages/coding-agent/src/memory-backend/resolve.ts` | "mmemory" registered |
| `packages/coding-agent/src/memory-backend/types.ts` | MemoryBackendId union |
| `packages/coding-agent/src/mmemory-extension.ts` | NEW -- extension event handlers |
| `packages/coding-agent/src/session/agent-session.ts` | setMmemoryBackendState/getMmemoryBackendState |
| `packages/coding-agent/src/tools/mmemory/` | NEW -- all mmemory tools + Python server + test suites |
| `packages/coding-agent/src/tools/index.ts` | mmemory registrations + SETTINGS_SCHEMA fallback; mbrowser registration |
| `packages/coding-agent/src/sdk.ts` | createPromptEngine import + push |
| `packages/coding-agent/src/sidecars/mme-*.md` | NEW -- mmemory sidecars (consolidation, injection, recall, reflect, retain, time-filter) |
| `packages/coding-agent/src/sidecars/mreview.tool-desc.md` | NEW -- mreview sidecar |
| `packages/coding-agent/src/utils/m-utils.ts` | NEW -- createSidecar, sidecarPath, callWithRole, empty-string guard |
| `packages/coding-agent/src/modes/interactive-mode.ts` | showMTreeSelector() delegation |
| `packages/coding-agent/src/modes/controllers/selector-controller.ts` | showMTreeSelector() method |
| `packages/coding-agent/src/modes/components/tree-peek.ts` | NEW -- TreePeekComponent |
| `packages/coding-agent/src/modes/components/tree-selector.ts` | getTreeList() exposed |
| `packages/coding-agent/src/tools/mbrowser.ts` | NEW -- MBrowserTool |
| `packages/coding-agent/src/edit/normalize.ts` | Count-based detectLineEnding |
| `packages/natives/native/index.js` | detectAvx2Support os.cpus() fallback |
| `packages/natives/native/embedded-addon.js` | win32-x64 native embed paths |
| `docs/mmemory.md` | NEW -- user doc |
| `.gitignore` | /.*  pattern + binaries/ + **/.index.html |

### Conflict resolution rule

Both sides make additive changes to these files. Always keep BOTH sides.
Never drop our block to accept upstream wholesale.

---

## Build and Test

```bash
# 1. Compile check
bun tsc --noEmit --project packages/coding-agent/tsconfig.json
bun tsc --noEmit --project packages/ai/tsconfig.json

# 2. TypeScript tests (changed files)
bun test packages/coding-agent/test/core/python-executor.test.ts
bun test packages/ai/test/stream.test.ts
# Note: tools/index.test.ts, workspace-tree, tool-discovery, loop-limit tests
# were deleted upstream -- do not run

# 3. mmemory Python tests (must pass 115/115)
cd packages/coding-agent/src/tools/mmemory
python3 test_mmemory.py           # 20/20
python3 test_injection.py         # 14/14
python3 test_injection_snapshot.py  # 43/43

# 4. Build/deploy/bundle (use canonical scripts)
D:\.ai\research\omp\build.cmd
D:\.ai\research\omp\deploy.cmd
D:\.ai\research\omp\bundle.cmd

# 5. Update version in live configs
#    Set lastChangelogVersion: "X.Y.Z" in both ~/.omp/agent-work/config.yml
#    and ~/.omp/agent/config.yml

# 6. Tag and push
git tag vX.Y.Z-aws-corp
git push fork aws-corp && git push fork --tags
```

---

## Quick Diff Commands

```bash
# What we changed vs upstream
git diff origin/main aws-corp --stat

# What upstream changed since last merge
git log --oneline aws-corp..origin/main

# Files changed in both (conflict candidates)
comm -12 \
  <(git diff --name-only origin/main aws-corp | sort) \
  <(git diff --name-only $(git merge-base aws-corp origin/main) origin/main | sort)
```
