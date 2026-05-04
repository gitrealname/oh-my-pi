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

These were descoped to avoid blocking the initial release:

1. **Structured 5-dim extraction** — Extension currently saves verbatim transcripts.
   Structured extraction (LLM call during retain) is architecture-complete but needs
   the LLM call to be wired into the extension's `retain()` method via `ctx.executePython`
   or a direct API call. Tracked as `extractionMode: "structured"` config knob.
   Status: config knob exists, verbatim mode is default, structured is stubbed.

2. **`/mmemory clear` confirmation UI** — Currently shows status message; full interactive
   confirmation (shows file count + date range, y/N prompt) requires the TUI select API.
   Low-risk to add in Phase 1.5.

3. **Server-side facts.json** — `facts.json` is populated by Phase 2 structured extraction.
   Phase 1 uses the MD files + chunks.json for BM25; facts.json is written as empty `[]`
   on first build and populated when structured extraction is enabled.
