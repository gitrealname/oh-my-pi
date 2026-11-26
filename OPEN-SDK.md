# open-sdk

Thin fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) that exports OMP internals for external extensions.

## Fork policy — read first

- `main` = exactly **ONE commit on top of the upstream RELEASE POINT** of the version the stock natives carry. Never upstream `main` tip.
- The exe **always embeds the stock published natives** (`omp update` installs them into `~/.omp/natives/<version>/`). The tree stays on the release point, so stock natives and JS match by construction.
- **Never build Rust locally.** A version-stamp mismatch between `packages/natives/native/*.node` and `packages/natives/package.json` is a hard stop (the script enforces it), not something to fix by rebuilding crates.
- Sync flow: follow the [future merge sequence](#future-merge-sequence-exact) below — `omp update` first (fresh stock natives), then `python install-open-sdk.py` (rebase onto the latest upstream release commit → verify stock addon → build exe → deploy).

## What it adds

Three `open-sdk.ts` files (one per package), a subpath export in each `package.json`, and a property on `ExtensionAPI`:

### `packages/coding-agent/src/open-sdk.ts`

LLM calls, settings, role resolution, helper functions — and re-exports from `pi-ai` and `pi-tui` open-sdk:

```ts
export { complete, completeSimple, streamSimple } from "@oh-my-pi/pi-ai";
export { resolveRoleSelection } from "./config/model-resolver";
export { settings, isSettingsInitialized } from "./config/settings";
export { applyOverrides, dispatchSlashCommand } from "./open-sdk";
export * from "@oh-my-pi/pi-ai/open-sdk";
export * from "@oh-my-pi/pi-tui/open-sdk";
```

### `packages/ai/src/open-sdk.ts`

AWS provider internals, stream utilities, and low-level helpers:

Exports: `streamBedrock`, `BedrockOptions`, `BedrockThinkingDisplay`, `resolveAwsCredentials`, `decodeEventStream`, `signRequest`, `transformMessages`, `AssistantMessageEventStream`, `appendRawHttpRequestDumpFor400`, `parseStreamingJson`, `parseStreamingJsonThrottled`, `normalizeToolCallId`, `resolveCacheRetention`, `toolWireSchema`, `getStreamIdleTimeoutMs`, `getOpenAIStreamIdleTimeoutMs`, `getStreamFirstEventTimeoutMs`, `getOpenAIStreamFirstEventTimeoutMs`, `isRequestDebugEnabled`, `StreamMarkupHealing`, `notifyRawSseEvent`, `resolveSdkTimeoutMs`, `createSdkStreamRequestOptions`

### `packages/tui/src/open-sdk.ts`

TUI utilities not in the public API:

Exports: `KillRing`, `BracketedPasteHandler`

### Subpath exports (`package.json`, all three packages)

```json
"./open-sdk": {
  "types": "./src/open-sdk.ts",
  "import": "./src/open-sdk.ts"
}
```

### `packages/coding-agent/src/extensibility/extensions/types.ts`

Adds `openSdk` to the `ExtensionAPI` interface:

```ts
import type * as PiOpenSdk from "../../open-sdk";

export interface ExtensionAPI {
  // ...
  /** Open-sdk subpath — clean namespace for LLM calls, settings, stream utils, and TUI helpers */
  openSdk: typeof PiOpenSdk;
}
```

### `packages/coding-agent/src/extensibility/extensions/loader.ts`

Wires the property on `ConcreteExtensionAPI`:

```ts
import * as PiOpenSdk from "../../open-sdk";
// ...
readonly openSdk = PiOpenSdk;
```

### Why these aren't in the public API

The `@oh-my-pi/pi-ai` index intentionally excludes AWS provider internals, stream
utilities, and low-level debug helpers from its public surface.

## Extension usage

All open-sdk exports are accessible via `pi.openSdk` — a clean, dedicated namespace:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  const sdk = pi.openSdk;

  // LLM calls
  const result = await sdk.complete({
    model: "anthropic/claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "Hello" }],
  });

  // Settings (runtime overrides are not persisted to config.yml)
  const { applied, skipped } = sdk.applyOverrides(sdk.settings, {
    "memory.backend": "off",
    "display.tabWidth": 4,
  });

  // Dispatch a slash command without sending to the LLM
  await sdk.dispatchSlashCommand(session, "/graphify extract");

  // AWS provider internals (custom providers)
  const creds = await sdk.resolveAwsCredentials({ region: "us-east-1" });
  const healing = new sdk.StreamMarkupHealing({ patterns: ["kimi"] });

  // TUI utilities
  const killRing = new sdk.KillRing();
}
```

> `pi.pi.*` still works — open-sdk exports are also re-exported from the root `index.ts`. New extensions should use `pi.openSdk.*`.

## Quick start

```bash
git clone https://github.com/gitrealname/oh-my-pi.git
cd oh-my-pi
git remote add upstream https://github.com/can1357/oh-my-pi.git
omp update                      # stock natives into ~/.omp/natives/<version>/
python install-open-sdk.py      # rebase + verify + build + deploy
```

The script:
1. Fetches upstream, rebases the fork commit onto the **latest upstream release commit** (the `chore: bump version to <v>` commit on `packages/natives/package.json` — never upstream `main` tip; pin an older one with `--to <version>`)
2. Retires stale embedded addons, copies the **stock** addon from the omp cache (`~/.omp/natives/<v>/`), and hard-stops on any version-stamp mismatch (never rebuilds Rust)
3. Builds the exe (embeds the stock addon)
4. Runs `omp update` for fresh stock models.json
5. Hot-swaps our binary on top (rename-based; running instances keep the old binary — restart with `omp -c`)

## Adding more exports

1. Find which package the function lives in
2. Add an export line to that package's `open-sdk.ts`
3. Available in extensions as `pi.openSdk.functionName()`

## Future merge sequence (exact)

When upstream releases a new version (18.17.0, …):

1. **`omp update`** — the installed stock omp self-updates and installs the new
   stock natives into `~/.omp/natives/<v>/`. Always first: the exe embeds the
   stock natives from that cache, and this is what keeps JS and natives
   matched by construction.
2. **`python install-open-sdk.py`** — the script, in order:
   - `git fetch upstream main`
   - find the latest `chore: bump version to <v>` commit touching
     `packages/natives/package.json` (or the one `--to <version>` pins) — that
     commit IS the release point; upstream `main` tip is not
   - `git rebase <release commit>` — replays the ONE fork commit onto it
   - retire stale `packages/natives/native/pi_natives.<tag>*.node`, copy the
     stock addons from the omp cache; any version-stamp mismatch is a hard stop
   - `bun install --frozen-lockfile`
   - build the exe (embeds the stock addon)
   - `omp update` (fresh stock models.json), rotate `.bak`, hot-swap the exe
3. **On rebase conflict** the script aborts cleanly and lists the files.
   Resolve by hand (`git rebase --continue`), squash into the ONE fork commit,
   then re-run with `--skip-rebase`.

**Never happens:** local Rust builds, version restamps, rebases onto upstream
`main` tip. If upstream's post-release JS demands natives the stock build
lacks (like a new napi class), the correct answer is to wait for the next
release — not to rebuild crates.

### Options

```
--push-origin      Force-push fork to origin after deploy
--to <version>     Pin the target upstream release (default: latest release commit)
--skip-deploy      Build but don't replace the installed binary
--skip-rebase      Local build + deploy only
--dry-run          Show what would happen
```