# mmemory — Improvement Plan (Phase 2+)

This document tracks future enhancements to the mmemory extension. Phase 1 (core
BM25+semantic recall, date-stamped storage, auto-retain/recall lifecycle) is complete.

---

## Phase 2: Graph Support + Temporal Graph Layer

**Package:** NetworkX (`pip install networkx`) — pure Python, ~8 MB, zero native deps
**Storage:** `memory_graph.json` via `json_graph.node_link_data()` — human-readable, git-diffable

### Changes
- Extraction additions (backwards-compatible): `entities:[{name,type}]`, `relations:[{from,to,type,date}]`
- Temporal edges: causal chains with timestamps (Phase 1 captures `when` per-fact; Phase 2 links facts across sessions)
- Recall: 1-hop graph expansion after BM25+semantic (related entities surface with context)
- Entity timelines: query how a specific entity's state changed across sessions
- Temporal subgraph queries: "what changed about X between DATE1 and DATE2?"
- **Activation:** auto-enabled when `memory_graph.json` exists in the storage directory (no config change required)

### Implementation notes
- Add `_run_graph_update()` to `mmemory_server.py` `_run_build()` chain
- Graph is updated incrementally alongside vectors (same background build thread)
- `_handle_recall()` calls `_expand_with_graph()` after RRF merge to 1-hop expand results

---

## Phase 3: Memory Browser UI

Similar to `mreview-ui.html` — local HTTP server + browser UI for inspecting and managing memories.

### Features
- Searchable/filterable table of `facts.json` entries
- Click to view full memory file
- Select + delete stale facts (writes updated `facts.json`, triggers rebuild)
- Timeline view: facts ordered by date with recency highlighting
- Triggered via `/mmemory browse` or `MMemoryTool { operation: "browse" }`

### Implementation notes
- Reuse `openMReviewSession` pattern from `tools/mreview/index.ts`
- Static HTML file shipped alongside extension
- Local Express/Bun.serve endpoint for API calls (facts CRUD)

---

## Phase 4: Enhanced Deduplication

Requires Phase 2 (entity-aware merging needs entity extraction).

### Features
- Facts about same entity+aspect detected via entity matching + cosine similarity
- Merged with `when` field showing temporal span ("2026-01 → 2026-05")
- Older superseded facts archived rather than deleted (keeps audit trail)

---

## Phase 5: Consolidation Pipeline

### Features
- Periodic LLM pass: synthesize raw facts → higher-level observations
- Stored as `observations.json`, injected alongside raw recall
- Triggered via `/mmemory consolidate` or on reaching `maxRawFacts` threshold
- Observations are weighted higher than raw facts in recall ranking
- Model: uses `memory` role (same as extraction)

---

## Phase 6: Multi-project Cross-pollination

### Features
- `scoping: global` already exists for recall
- Phase 6 adds semantic routing: when querying globally, weight results by project similarity
- Project similarity computed from tag overlap + recent topic vectors
- Useful for agents working across multiple related codebases

---

## Deferred from Phase 1

These were descoped or deferred during the initial implementation and audit cycle.
All are tracked here as mandatory Phase 2 prerequisites or standalone tasks.

### Deferred — Design gaps

1. **Structured 5-dim extraction (H6)** — `extractionMode: "structured"` config knob exists
   and is active on the `ow` profile, but the LLM extraction call inside `retainSession()`
   is stubbed — it saves the verbatim transcript regardless of the setting.
   **Fix:** wire `mmemory_extract.py` (or direct API call via `ctx.executePython`) in
   `retainSession()` when `extractionMode === "structured"`.
   Status: config knob live, ow profile uses `structured`, extraction stub confirmed.

2. **`per-project-tagged` scope (M3)** — Both configs default to `per-project-tagged` but the
   Python server treats it identically to `per-project`. The cross-project "tagged" lookup
   (search memories shared across projects with a common tag) is not implemented.
   **Fix:** define the tag mechanism in `kb_config.yaml` or a `tags` config field; implement
   `matches_scope()` branch in `mmemory_server.py` for tag-based cross-project recall.
   Status: config value written, behavior is per-project only.

3. **`/mmemory clear` confirmation UI** — Shows a status message but does not actually delete
   files. The `--from / --to / --session` guard logic is present; the deletion + rebuild step
   is missing. Requires: walk `memoryDir`, filter by date range, delete matched `.md` files,
   call server `rebuild` action.
   Status: guard logic present, deletion not implemented.

4. **Server-side `facts.json`** — Written as empty `[]` on first build. Populated only when
   structured extraction is enabled and Phase 2 entities/relations are extracted.

### Deferred — Audit items (from post-implementation audit, 2026-05-03)

5. **C1 partial — Dual server risk** — When both the inline extension (`mmemory-extension.ts`
   via `getOrCreateServerClient`) and a user-triggered tool call hit the server simultaneously,
   two concurrent `build` requests can race. The Python `_build_lock` serializes writes within
   a single server process, but if two separate server processes are ever alive (e.g. two omp
   instances pointing at the same storage path), both can write `vectors.safetensors` without
   coordination.
   **Fix:** cross-process advisory lockfile (`<memoryDir>/.build.lock`) in `mmemory_server.py`
   using `msvcrt.locking` (Windows) / `fcntl.flock` (Unix) before `save_file()`.
   Risk level: low in normal single-instance use; real in multi-instance scenarios.

6. **H2 — Cache invalidation race** — `_invalidate_caches()` runs inside `_build_lock` after
   build completes. A recall running concurrently reads chunk indices from cache, then the
   cache is cleared and rebuilt. Index reference becomes stale only if a file was deleted
   during build (shrinking corpus). Extremely unlikely in normal use.
   **Fix:** invalidate cache entries per-path rather than clearing all; or use a read-write
   lock (readers block during final cache swap only).
   Risk level: negligible unless memory files are actively deleted during a recall query.

7. **H5 — BM25 pruning on small corpora** — `df` pruning threshold `c < N * 0.5` is
   aggressive at N ≥ 4: terms appearing in 2+ of 4 files are pruned. First-run scenario
   (N=1–3) is unaffected (threshold ≤ 1.5, minimum count is 1). Semantic search covers
   the gap. Becomes visible only after 4+ distinct session memory files exist.
   **Fix:** use a minimum absolute threshold: `c < max(2, N * 0.5)` so terms must appear
   in at least 2 docs before pruning kicks in.
   Risk level: low; semantic is primary retrieval path.

8. **M1 — Path resolution on Windows** — `PI_CODING_AGENT_DIR` is set as a Windows-native
   path (e.g. `C:\Users\...\agent-work`). `import.meta.url` in dev mode may yield a
   different separator format. Both TS and Python resolve via `os.path` / Node `path`
   which normalise separators, so collisions are unlikely — but not impossible on edge
   configurations (WSL, network drives, junctions).
   **Fix:** normalise both sides of any path comparison to forward-slash before keying.
   Risk level: negligible on standard Windows installs.

9. **M2 — Chunking logic divergence** — `chunk_markdown()` is defined independently in
   `mmemory_server.py` (embedded in binary) and `mmemory_update.py` (also embedded).
   They are currently identical but can diverge silently over time.
   **Fix:** extract `chunk_markdown()` and `tokenize()` into a shared `mmemory_shared.py`,
   imported by both. Embed the shared module as a third text asset.