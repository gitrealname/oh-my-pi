# Attribution

The files in this directory are vendored from Plannotator by backnotprop.

- Source: https://github.com/backnotprop/plannotator
- License: MIT / Apache-2.0 (dual license)
- Copyright (c) 2025 backnotprop

Files copied from `packages/ai/` with minimal modifications (import path fixes only):
- `types.ts`, `base-session.ts`, `session-manager.ts`, `provider.ts`, `context.ts`
- `pi-events.ts` (from `providers/pi-events.ts`)
- `pi-sdk-node.ts` (from `providers/pi-sdk-node.ts`)
- `endpoints.ts` (from `endpoints.ts`, adapted from Fetch API to node:http)

Plannotator's design of a provider-agnostic AI backbone with SSE streaming,
session management, and system-prompt-based context injection is the direct
foundation for mreview's AI chat feature.
