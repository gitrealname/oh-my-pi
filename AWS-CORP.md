# aws-corp Branch — Customizations

Fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) with
enterprise and workflow extensions baked into the binary.

Upstream: `origin/main` → periodically merged into `aws-corp`.
See [MERGE-INSTRUCTIONS.md](MERGE-INSTRUCTIONS.md) for merge checklist.

## Extensions (built into binary)

### 1. AWS Corp Provider
**Commits:** `c39db5528`, `0cd9b9a84`, `141d913be`, `b13a2a0ec`

Bedrock provider using AWS SSO auth (no API keys, no CLI dependency).
Translates model IDs to full inference profile ARNs for corp accounting.
Models externalized to `models-ow.yml` (not hardcoded in binary).

- `packages/ai/src/providers/aws-corp.ts` — provider implementation
- `packages/ai/src/models.ts` — hardcoded models removed
- `packages/coding-agent/src/config/model-registry.ts` — `bedrock-converse-stream` API type added

### 2. Prompt Engine
**Commit:** `0221de9f0`
**Inspired by:** [nicobailon/pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model)

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

Wired in `packages/coding-agent/src/sdk.ts` as inline extension.

### 3. Session Continuity
**Commit:** `d7c960079`
**Inspired by:** [middlendian/omp-context-mode-extension](https://github.com/middlendian/omp-context-mode-extension)

Tracks files modified/read and commands executed during a session. On
compaction, injects structured context into the summarization prompt via
`session.compacting` hook. Uses `preserveData` for lossless file list
survival across multiple compactions.

No MCP, no SQLite — pure in-memory accumulation with OMP hooks.

Files:
- `packages/coding-agent/src/prompt-engine/session-state.ts`
- Event handlers in `packages/coding-agent/src/prompt-engine/index.ts`

Config:
```yaml
sessionContinuity:
  enabled: true           # master toggle (default: false)
  maxEvents: 200          # max tracked events per category
  maxContextLines: 30     # max lines injected into compaction prompt
```

## Other Changes

### Browser ConnectUrl
**Commit:** `d5153405a`

`browser.connectUrl` config — attach to running Chrome/Edge via CDP instead
of launching a new browser instance.

### Disabled Commands
**Commit:** `0cae93323`

`disabledCommands` config — hide unwanted slash commands from autocomplete.
Credential isolation for multi-profile setups.

### Enhanced /tree
**Commit:** `e77cf7b94`

Preview pane in tree selector + aws-corp environment fixes.

### Line Ending Detection
**Commit:** `8bda73516`

Count-based heuristic for mixed-ending files instead of first-line detection.

### Native Addon Embedding
**Commit:** `c056769da`

Embeds `pi_natives.win32-x64-baseline.node` path for compiled binary on Windows.

## Config Surface

All features are controlled via `config.yml` — no magic, no hidden defaults:

| Feature | Config Key | Default |
|---------|-----------|---------|
| Model roles | `modelRoles.*` | (required) |
| Session continuity | `sessionContinuity.enabled` | `false` |
| Session continuity limits | `sessionContinuity.maxEvents/maxContextLines` | `200/30` |
| Browser attach | `browser.connectUrl` | (none) |
| Disabled commands | `disabledCommands[]` | `[]` |
| Disabled providers | `disabledProviders[]` | `[]` |
| Memories | `memories.enabled` | `true` |

## Build

```bash
cd /path/to/oh-my-pi
bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  --define PI_COMPILED=true --root . --external mupdf \
  --target bun-windows-x64-modern \
  ./packages/coding-agent/src/cli.ts \
  --outfile packages/coding-agent/binaries/omp-aws-corp.exe
```
