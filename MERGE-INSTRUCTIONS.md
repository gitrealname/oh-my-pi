# Upstream Merge Instructions for aws-corp Branch

When merging upstream `main` into `aws-corp`, follow this checklist.

Current merge base: `ae7c4100c` (v14.5.14)

---

## Merge Command

```bash
cd D:\.ai\research\omp\.oh-my-pi
git fetch origin main
git log --oneline aws-corp..origin/main   # review what changed
git merge origin/main -m "merge: upstream <version> into aws-corp"
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
# Stop omp first (baseline.node locked while running)
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
| `packages/coding-agent/src/config/model-registry.ts` | +2 lines: bedrock-converse-stream literals |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | /mtree entry + isCommandEnabled guard |
| `packages/coding-agent/src/extensibility/slash-commands.ts` | isCommandEnabled() + filter |
| `packages/coding-agent/src/modes/interactive-mode.ts` | showMTreeSelector() delegation |
| `packages/coding-agent/src/modes/controllers/selector-controller.ts` | showMTreeSelector() method |
| `packages/coding-agent/src/modes/components/tree-peek.ts` | NEW -- TreePeekComponent |
| `packages/coding-agent/src/modes/components/tree-selector.ts` | getTreeList() exposed |
| `packages/coding-agent/src/tools/mbrowser.ts` | NEW -- MBrowserTool |
| `packages/coding-agent/src/tools/index.ts` | mbrowser registration + SETTINGS_SCHEMA fallback |
| `packages/coding-agent/src/sdk.ts` | createPromptEngine import + push |
| `packages/coding-agent/src/edit/normalize.ts` | Count-based detectLineEnding |
| `packages/natives/native/index.js` | detectAvx2Support os.cpus() fallback |
| `packages/natives/native/embedded-addon.js` | win32-x64 native embed paths |
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

# 2. Tests (our changed files)
bun test packages/coding-agent/test/tools/index.test.ts \
         packages/coding-agent/test/core/python-executor.test.ts \
         packages/coding-agent/test/tools/search-renderer.test.ts \
         packages/ai/test/stream.test.ts

# 3. Build binary
bun.exe build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv ^
  --define PI_COMPILED=true --root . --external mupdf --target bun-windows-x64-modern ^
  ./packages/coding-agent/src/cli.ts --outfile packages/coding-agent/binaries/omp-aws-corp.exe

# 4. Deploy (stop omp first)
copy packages\coding-agent\binaries\omp-aws-corp.exe %LOCALAPPDATA%\omp\omp.exe

# 5. Update version in live configs
#    Set lastChangelogVersion: "X.Y.Z" in both ~/.omp/agent-work/config.yml
#    and ~/.omp/agent/config.yml

# 6. Tag and push
git tag vX.Y.Z-aws-corp
git push && git push --tags
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
