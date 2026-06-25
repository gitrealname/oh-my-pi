# open-sdk

Thin fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) that exports OMP internals for external extensions.

## What it adds

Three `open-sdk.ts` files (one per package), a subpath export in `package.json`, and a property on `ExtensionAPI`:

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

Exports: `streamBedrock`, `BedrockOptions`, `BedrockThinkingDisplay`, `resolveAwsCredentials`, `decodeEventStream`, `signRequest`, `transformMessages`, `AssistantMessageEventStream`, `appendRawHttpRequestDumpFor400`, `withHttpStatus`, `parseStreamingJson`, `parseStreamingJsonThrottled`, `normalizeToolCallId`, `resolveCacheRetention`, `toolWireSchema`, `getStreamIdleTimeoutMs`, `getOpenAIStreamIdleTimeoutMs`, `getStreamFirstEventTimeoutMs`, `getOpenAIStreamFirstEventTimeoutMs`, `iterateUntilAbort`, `isRequestDebugEnabled`, `StreamMarkupHealing`, `notifyRawSseEvent`, `resolveSdkTimeoutMs`, `createSdkStreamRequestOptions`

### `packages/tui/src/open-sdk.ts`

TUI utilities not in the public API:

Exports: `KillRing`, `BracketedPasteHandler`

### `packages/coding-agent/package.json`

Explicit subpath export so the bundled-pi registry generator picks it up:

```json
"./open-sdk": {
  "types": "./src/open-sdk.ts",
  "import": "./src/open-sdk.ts"
}
```

### `packages/coding-agent/src/extensibility/extensions/types.ts`

Adds `openSdk` property to `ExtensionAPI` interface:

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
readonly openSdk: typeof PiOpenSdk = PiCodingAgent["./open-sdk"] as typeof PiOpenSdk;
```

### Why these aren't in the public API

The `@oh-my-pi/pi-ai` index intentionally excludes AWS provider internals, stream
utilities, and low-level debug helpers from its public surface. The `"./*"` wildcard
in `package.json` already resolves subpath imports - no package.json changes needed.

## Extension usage

All open-sdk exports are accessible via `pi.openSdk` — a clean, dedicated namespace.
No imports needed beyond the `ExtensionAPI` type:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  const sdk = pi.openSdk; // clean open-sdk namespace

  // LLM calls
  const result = await sdk.complete({
    model: "anthropic/claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "Hello" }],
  });

  // Streaming
  for await (const chunk of sdk.streamSimple({ model: "...", messages: [...] })) {
    process.stdout.write(chunk.text ?? "");
  }

  // Settings and config
  const currentSettings = sdk.settings;

  // Batch runtime overrides (not persisted to config.yml)
  const result = sdk.applyOverrides(sdk.settings, {
    "memory.backend": "off",
    "display.tabWidth": 4,
  }, { fireHooks: true });
  // result.applied = ["memory.backend", "display.tabWidth"]
  // result.skipped = []

  // Dispatch a slash command without sending to LLM
  await sdk.dispatchSlashCommand(session, "/graphify extract");

  // AWS provider internals (custom providers)
  const creds = await sdk.resolveAwsCredentials({ region: "us-east-1" });
  const stream = sdk.streamBedrock({ model: "...", messages: [...], credentials: creds });
  const healing = new sdk.StreamMarkupHealing({ patterns: ["kimi"] });

  // Stream utilities
  const json = await sdk.parseStreamingJson(response.body);
  for await (const event of sdk.iterateUntilAbort(stream, signal)) { /* ... */ }

  // TUI utilities
  const killRing = new sdk.KillRing();
  const pasteHandler = new sdk.BracketedPasteHandler();
}
```

> **Backward compatibility:** `pi.pi.*` still works — open-sdk exports are also re-exported from the root `index.ts`. New extensions should use `pi.openSdk.*` for a cleaner API surface.

## Quick start

### Clone and configure

```bash
git clone https://github.com/gitrealname/oh-my-pi.git
cd oh-my-pi
git remote add upstream https://github.com/can1357/oh-my-pi.git
```

The `main` branch is the open-sdk fork. `upstream` points to official OMP.

### Build and deploy locally

```bash
# Linux/macOS
./install-open-sdk.sh

# Windows
install-open-sdk.cmd

# Or directly
python install-open-sdk.py
```

The script:
1. Fetches upstream main
2. Rebases onto it
3. Checks if anything changed - exits early if not
4. Rebuilds the binary (skips Rust compilation if Cargo.lock unchanged)
5. Runs `omp update` for fresh models.json
6. Hot-swaps our binary on top

### Options

```
--push-origin      Push to origin after deploy
--skip-deploy      Build but don't replace installed binary
--dry-run          Show what would happen
```

## Adding more exports

When you need a function from OMP internals that isn't in the public API:

1. Find which package it lives in (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-tui`, etc.)
2. Add an export line to that package's `open-sdk.ts`
3. It's automatically available in extensions via `pi.openSdk.functionName()`

No core files modified beyond the `open-sdk.ts` files and the subpath export in `package.json`.

## Syncing with upstream

```bash
git fetch upstream main
git rebase upstream/main
python install-open-sdk.py
```

Rebase cost: three `open-sdk.ts` files + `package.json` exports entry + two small hunks in `types.ts`/`loader.ts`. Still trivial — all additive, no shared lines with upstream.

## Public repo

https://github.com/can1357/oh-my-pi (upstream)

Fork: https://github.com/gitrealname/oh-my-pi (main branch)
