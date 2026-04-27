# Upstream Merge Instructions for aws-corp Branch

When merging upstream `main` into `aws-corp`, follow this checklist to ensure
new upstream features respect our customizations.

## Merge Command

```bash
cd D:\.ai\research\omp\.oh-my-pi
git fetch origin main
git log --oneline aws-corp..origin/main   # review changes
git merge origin/main -m "merge: upstream <version> into aws-corp"
```

## Post-Merge Checklist

### 1. New Model Providers

**Where to check:** `packages/ai/src/stream.ts` — look for new entries in `serviceProviderMap`.

**Action:** Add the new provider ID to `disabledProviders` in:
- `~/.omp/agent-work/config.yml` (live ow)
- `~/.omp/agent/config.yml` (live o)
- `research/omp/dist-templates/config-ow.yml` (sample)
- `research/omp/dist-templates/config-o.yml` (sample)

**Example:** When `fireworks` was added in 14.5.3:
```yaml
disabledProviders:
  - fireworks    # added in 14.5.3
```

### 2. New Discovery Providers

**Where to check:** `packages/coding-agent/src/discovery/` — look for new files with `PROVIDER_ID`.

**Action:** Add the new discovery provider ID to `disabledProviders` in the same 4 config files.

**How to identify:** Each discovery provider file has `const PROVIDER_ID = "xxx"`.
Current list: `native`, `claude`, `codex`, `gemini`, `agents-md`, `agents`,
`claude-plugins`, `cline`, `cursor`, `windsurf`, `vscode`, `github`, `mcp-json`,
`opencode`, `ssh-json`.

### 3. New Slash Commands

**Where to check:** `packages/coding-agent/src/slash-commands/builtin-registry.ts` — look for new entries in `BUILTIN_SLASH_COMMAND_REGISTRY`.

**Action:** Decide if the command should be disabled by default. If so, add to
`disabledCommands` in the 4 config files.

### 4. New Tools

**Where to check:** `packages/coding-agent/src/config/settings-schema.ts` — look for new `"xxx.enabled"` settings.

**Action:** Add the new tool with its default state to the 4 config files under
the `# Tools (enabled/disabled)` section.

### 5. New Settings

**Where to check:** `packages/coding-agent/src/config/settings-schema.ts` — diff for new keys.

**Action:** Add to the live config files with their defaults so the full inventory
stays complete.

### 6. Files We Modified (conflict risk)

These files have our custom changes. Merge conflicts are possible:

| File | Our changes |
|------|-------------|
| `packages/ai/src/stream.ts` | aws-corp auth check + routing |
| `packages/ai/src/models.ts` | 21 aws-corp model registrations |
| `packages/ai/src/providers/aws-corp.ts` | NEW — SSO provider |
| `packages/ai/src/providers/amazon-bedrock.ts` | modelIdOverride, getCorpCredentials |
| `packages/coding-agent/src/config/settings-schema.ts` | disabledCommands setting |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | isCommandEnabled guard, getBuiltinSlashCommandDefs |
| `packages/coding-agent/src/extensibility/slash-commands.ts` | getBuiltinSlashCommands dynamic function |
| `packages/coding-agent/src/modes/interactive-mode.ts` | Dynamic command list, showTreeSelectorOriginal |
| `packages/coding-agent/src/modes/types.ts` | showTreeSelectorOriginal interface |
| `packages/coding-agent/src/modes/controllers/selector-controller.ts` | TreePeekComponent wiring |
| `packages/coding-agent/src/modes/components/tree-peek.ts` | NEW — preview pane |
| `packages/coding-agent/src/modes/components/tree-selector.ts` | Public API additions |
| `packages/coding-agent/src/edit/normalize.ts` | Count-based detectLineEnding |

### 7. Build and Test

```bash
# Build
cd D:\.ai\research\omp\.oh-my-pi
bun.exe build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  --define PI_COMPILED=true --root . --external mupdf --target bun-windows-x64-modern \
  ./packages/coding-agent/src/cli.ts --outfile packages/coding-agent/binaries/omp-aws-corp.exe

# Deploy (close ow first)
cp packages/coding-agent/binaries/omp-aws-corp.exe %LOCALAPPDATA%\omp\omp.exe

# Test
ow --new
```

### 8. Update Version Reference

Update `lastChangelogVersion` in live configs to match the new upstream version.

### 9. Commit

```bash
git add -A
git commit -m "merge: upstream <version> into aws-corp

- <list any adjustments made>
- Added <new provider> to disabledProviders
- Updated config inventory"
```

## Quick Diff Commands

```bash
# What we changed vs upstream base
git diff 715eb356b..aws-corp --name-only

# What upstream changed since our base
git log --oneline aws-corp..origin/main

# Potential conflicts (files changed in both)
comm -12 \
  <(git diff --name-only 715eb356b..aws-corp | sort) \
  <(git diff --name-only 715eb356b..origin/main | sort)
```
