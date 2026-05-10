# OMP Integration TODO

Integrate pi-prompt-template-model as a switchable extension in our OMP fork (aws-corp branch).

## Context

- OMP fork: `research/omp/.oh-my-pi` (branch `aws-corp`)
- This extension: `research/omp/.pi-prompt-template-model` (branch `omp`)
- OMP profiles: `o` (openrouter vanilla), `ow` (aws-corp work)
- OMP binary: compiled with `bun build --compile`

## Approach

Install as an external extension loaded via `config.yml`. Toggle on/off with `disabledExtensions`.

Deploy path: `~/.omp/agent/extensions/prompt-template-model/`

## TODO

### Phase 1: Feasibility

- [ ] Verify compiled Bun binary can `import()` external .ts files at runtime
  - If not: need pre-transpile step to .js
  - Test: place a minimal extension .ts in extensions dir, run compiled binary
- [ ] Confirm `pi.extensions` legacy key in package.json is picked up by OMP loader
  - Extension-loading.md says yes, but verify with actual binary

### Phase 2: Port imports

- [ ] Replace `@mariozechner/pi-coding-agent` → `@oh-my-pi/pi-coding-agent`
- [ ] Replace `@mariozechner/pi-agent-core` → `@oh-my-pi/pi-agent-core`
- [ ] Replace `@mariozechner/pi-ai` → `@oh-my-pi/pi-ai`
- [ ] Replace `@mariozechner/pi-tui` → `@oh-my-pi/pi-tui` (devDependency, used in tests)
- [ ] Update package.json devDependencies to `@oh-my-pi/*` scope
- [ ] Verify `typebox` dependency resolves (OMP uses `@sinclair/typebox` in catalog)

### Phase 3: Trim scope (optional)

Decide which features to include. The extension is large (~60KB index.ts). Features:

- [x] Core: model/skill/thinking frontmatter — **must have**
- [x] Core: model restore after command — **must have**
- [ ] Chain templates — include if no extra deps
- [ ] Loop execution — include if no extra deps
- [x] Subagent delegation — OMP has built-in task/subagent system (`src/task/`). Extension uses EventBus events, not direct imports. Need to wire events to OMP's executor or install pi-subagents as a file-based extension (it's just an `agents.ts` file, not an npm dep). **Include — low risk.**
- [x] Deterministic steps — no extra deps, self-contained
- [x] Best-of-N / compare — same subagent EventBus pattern. **Include if subagent wiring works.**

### Phase 4: Config & deploy

- [ ] Update `dist-templates/config-o.yml` — add extensions entry
- [ ] Update `dist-templates/config-ow.yml` — add extensions entry
- [ ] Add toggle example (commented `disabledExtensions` line)
- [ ] Update `deploy.cmd` / `build.cmd` to copy extension into dist
- [ ] Update `install.cmd` to place extension in `~/.omp/agent/extensions/`

### Phase 5: Test

- [ ] Run extension tests with `@oh-my-pi/*` imports (`bun test`)
- [ ] Create a test prompt template with `model:` frontmatter
- [ ] Verify model switch + restore works in `ow` profile
- [ ] Verify model switch works in `o` profile (openrouter models)
- [ ] Verify `disabledExtensions: extension-module:prompt-template-model` disables it
- [ ] Test with compiled binary (not just `bun dev`)

### Phase 6: Documentation

- [ ] Add section to `dist-templates/README.md` about prompt template model features
- [ ] Create sample prompt templates demonstrating model/skill/thinking usage
- [ ] Document enable/disable in config

## Risks

1. **Compiled binary + external .ts import** — Bun compile may not support dynamic import of .ts. Mitigation: pre-transpile to .js.
2. **API drift** — upstream OMP may change ExtensionAPI. Mitigation: pin to known working version, test on merge.
3. **Package scope mismatch** — if extension tries to import types at runtime that don't match the compiled binary's bundled types. Mitigation: extension only uses the types for compile-time checking; at runtime it receives the API object from the factory parameter.

## Notes

- The extension's `package.json` uses `"pi": { "extensions": ["./index.ts"] }` — OMP's loader accepts this legacy key.
- Extension factory receives `ExtensionAPI` as parameter — no need to import the runtime, only types.
- `typebox` is the only real runtime dependency (used for tool parameter schemas). OMP already bundles `@sinclair/typebox`.
