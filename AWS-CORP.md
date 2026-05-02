# aws-corp Branch -- Customizations

Fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) with
enterprise and workflow extensions baked into the binary.

Current base: upstream v14.5.14 (`ae7c4100c`)
Upstream: `origin/main` -> periodically merged into `aws-corp`.
See [MERGE-INSTRUCTIONS.md](MERGE-INSTRUCTIONS.md) for merge checklist.

---

## Extensions (built into binary)

### 1. AWS Corp Provider

Bedrock provider using AWS SSO auth (no API keys, no CLI dependency).
Translates model IDs to full inference profile ARNs for corp accounting.
Models defined in `models-ow.yml` (not hardcoded in binary).

Files:
- `packages/ai/src/providers/aws-corp.ts` -- provider implementation
- `packages/ai/src/providers/amazon-bedrock.ts` -- +2 lines: bedrock-converse-stream type
- `packages/ai/src/stream.ts` -- streamAwsCorp import + routing + serviceProviderMap entry
- `packages/coding-agent/src/config/model-registry.ts` -- bedrock-converse-stream API type

### 2. Prompt Engine

Registers slash commands from `.md` files in agent `commands/` dirs. Supports:
- `role` field -> resolves via `modelRoles` config (single source of truth)
- `model` field -> direct model spec (fallback)
- `skill` field -> auto-injects SKILL.md content
- `thinking` field -> sets thinking level for the command
- Dot-prefix skill activation (`.pi describe this`) with auto model switch
- Auto-restore of model + thinking after command completes

Files:
- `packages/coding-agent/src/prompt-engine/index.ts`
- `packages/coding-agent/src/prompt-engine/prompt-loader.ts`
- `packages/coding-agent/src/prompt-engine/model-selection.ts`
- `packages/coding-agent/src/prompt-engine/session-state.ts` (session continuity)

Wired in `packages/coding-agent/src/sdk.ts` as inline extension.

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

### 4. MBrowser Tool (CDP-attach browser)

`mbrowser` is a variant of the upstream `browser` tool that auto-attaches to a
running Chrome/Edge instance via `browser.connectUrl` on every `open` action.
No `app.cdp_url` argument needed -- set the URL once in config.

Structurally mirrors the upstream `browser.ts` (same 3 actions: open/close/run),
delegates to the shared `browser/*` infrastructure. The only difference is in
`resolveMBrowserKind()` which reads `browser.connectUrl` from settings.

Files:
- `packages/coding-agent/src/tools/mbrowser.ts` -- MBrowserTool class
- `packages/coding-agent/src/tools/index.ts` -- registration + SETTINGS_SCHEMA fallback
- `packages/coding-agent/src/config/settings-schema.ts` -- mbrowser.enabled

Start Chrome with: `--remote-debugging-port=9222`
Or via helper: `py D:/.ai/scripts/chrome.py open`

### 5. /mtree Command (tree with peek preview)

`/mtree` opens the session tree with a Ctrl+down peek pane that shows a preview
of the selected branch without navigating to it. The upstream `/tree` is
unchanged (no-peek).

Files:
- `packages/coding-agent/src/modes/components/tree-peek.ts` -- TreePeekComponent
- `packages/coding-agent/src/modes/components/tree-selector.ts` -- getTreeList() exposed
- `packages/coding-agent/src/modes/controllers/selector-controller.ts` -- showMTreeSelector()
- `packages/coding-agent/src/modes/interactive-mode.ts` -- showMTreeSelector() delegation
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` -- /mtree entry

### 6. disabledCommands

`disabledCommands: []` config -- hide slash commands from autocomplete and block
execution. Used to suppress commands not relevant to this profile (loop, fast,
share, login, logout, ssh, marketplace).

Files:
- `packages/coding-agent/src/config/settings-schema.ts` -- disabledCommands setting
- `packages/coding-agent/src/extensibility/slash-commands.ts` -- isCommandEnabled() filter
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` -- execution guard

### 7. Local Fixes

| File | Fix |
|---|---|
| `packages/coding-agent/src/edit/normalize.ts` | Count-based majority-wins CRLF detection (vs first-occurrence) |
| `packages/coding-agent/src/modes/components/tree-peek.ts` | ThemeBg/ThemeColor as-any casts; null->undefined for onLabel |
| `packages/coding-agent/src/prompt-engine/index.ts` | renderSkillLoaded updated to new MessageRenderer<T> signature |
| `packages/natives/native/index.js` | detectAvx2Support: os.cpus() fallback for Windows PowerShell 5 |

---

### 8. /mreview Command (browser markdown review + AI chat)

`/mreview <file.md>` opens any markdown file in a browser review UI with two panels:
- **Left**: rendered markdown with inline annotation tools
- **Right**: AI chat sidebar routed directly through the active omp agent session

The user can annotate visually, discuss with the LLM, and hit **Submit Comments** to
inject structured feedback back into the terminal. No subprocess or external AI — the
browser talks to the same agent session already running.

Files:
- `packages/coding-agent/src/tools/mreview/mreview-ui.html` -- custom review SPA (sidecar next to omp.exe)
- `packages/coding-agent/src/tools/mreview/index.ts` -- orchestration, path resolution
- `packages/coding-agent/src/tools/mreview/server.ts` -- node:http server, AI routing, endpoints
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` -- /mreview entry + agent context injection
- `packages/coding-agent/src/config/settings-schema.ts` -- mreview.enabled, mreview.browser
- `packages/coding-agent/src/prompt-engine/prompt-loader.ts` -- mreview/review/discuss in RESERVED_NAMES
- `docs/skills/mreview/SKILL.md` -- optional companion skill (copy to ~/.omp/agent/skills/mreview/)

Deploy note: `mreview-ui.html` must be placed next to `omp.exe` (not embedded in the binary).
Bundle script handles this automatically.

## Config Surface

All features are controlled via `config.yml`:

| Feature | Config Key | Default |
|---------|-----------|---------|
| Model roles | `modelRoles.*` | (required) |
| Session continuity | `sessionContinuity.enabled` | `false` |
| Session continuity limits | `sessionContinuity.maxEvents/maxContextLines` | `200/30` |
| CDP-attach browser | `browser.connectUrl` | `~` (nil) |
| MBrowser tool | `mbrowser.enabled` | `true` |
| Disabled commands | `disabledCommands[]` | `[]` |
| Disabled providers | `disabledProviders[]` | `[]` |
| Memories | `memories.enabled` | `false` |
| MReview command | `mreview.enabled` | `true` |
| MReview browser | `mreview.browser` | blank (system default) |

See `research/omp/dist-templates/config-ow.yml` for the fully annotated config
with all 182 settings, descriptions, defaults, and option enumerations.

---

## Build

```bash
cd D:\.ai\research\omp\.oh-my-pi

# Native addon (required once per machine, or after upstream native changes)
# Stop omp first -- baseline.node is locked while running
TARGET_VARIANT=baseline bun run packages/natives/scripts/build-native.ts
TARGET_VARIANT=modern   bun run packages/natives/scripts/build-native.ts

# Binary
bun.exe build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv ^
  --define PI_COMPILED=true --root . --external mupdf --target bun-windows-x64-modern ^
  ./packages/coding-agent/src/cli.ts --outfile packages/coding-agent/binaries/omp-aws-corp.exe

# Deploy (stop omp first) -- copies binary + mreview-ui.html sidecar
deploy.cmd

# Bundle for distribution
cd D:\.ai\research\omp
py bundle.py --skip-build       # or: bundle.cmd --skip-build
```

Bundle output: `D:\.ai\research\omp\dist\omp-dist.zip`

---

## Notes

- The `aws-corp` branch is periodically rebased onto upstream releases.
  Use `MERGE-INSTRUCTIONS.md` for the checklist.
- Config templates live in `research/omp/dist-templates/` (tracked separately).
- Native `.node` binaries are gitignored -- must be built per machine.
- The `detectAvx2Support()` fix in `index.js` ensures the modern binary
  (with full API including the `Process` class) is loaded on Windows machines
  where PowerShell 5 cannot evaluate `[System.Runtime.Intrinsics.X86.Avx2]`.
