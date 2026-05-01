# mreview

Browser-based markdown review and AI discussion for omp.

Built on [Plannotator](https://github.com/backnotprop/plannotator) by backnotprop.
Licensed MIT / Apache-2.0.

See [docs/mreview.md](../../../../../docs/mreview.md) for the full implementation plan,
architecture decisions, and attribution.

## Commands

- `/mreview <file.md>` — open markdown file in browser review UI with AI chat
- `/review <file.md>` — alias
- `/discuss <file.md>` — alias

The `ai/` subdirectory will contain code vendored from Plannotator's `packages/ai/` layer.
See `ai/ATTRIBUTION.md` once vendored.
