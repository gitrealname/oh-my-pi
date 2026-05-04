# mmemory vs Hindsight — Gap Analysis

Analysis date: 2026-05-03  
mmemory ref: `aws-corp` branch  
Hindsight ref: `origin/main` (`src/hindsight/`, `src/tools/hindsight-*.ts`)

This document compares mmemory (local Python-based memory) with the Hindsight
pipeline already present in upstream omp. Gaps are categorized by feasibility and
risk.

---

## 1. Retrieval Architecture

### Hindsight
Four retrieval pathways, run in parallel on the server side:
1. **Semantic** — dense vector search (text-embedding-3-small, 1536-dim)
2. **BM25** — keyword search over retained observations
3. **Knowledge graph** — 1-hop entity traversal over extracted relations
4. **Temporal** — time-based lookup; recency ordering is a first-class axis

Results from all four are fused (Reciprocal Rank Fusion or server-side merge) before
returning to the caller. The server owns this logic entirely — the omp client issues
a single `recall(bankId, query, opts)` call and receives ranked results.

### mmemory
Two retrieval pathways, run in parallel inside `_handle_recall()`:
1. **Semantic** — cosine similarity over fastembed vectors (BAAI/bge-small-en-v1.5, 384-dim)
2. **BM25** — keyword search over `chunks.json`

RRF merge is implemented locally (`rrf_merge()`). A recency boost is applied
post-merge using exponential decay keyed on the session filename date (`YYYY-MM-DD`).

**Knowledge graph (gap 1):** No graph layer. Phase 2 of the improvement plan adds
NetworkX-based entity traversal. Skipped in Phase 1 because the entity extraction
stub is not yet wired (`extractionMode: "structured"` saves verbatim).

**Temporal retrieval as a dedicated axis (gap 2):** mmemory approximates recency
via filename-date decay inside `_handle_recall()`. Hindsight's temporal retrieval
is a separate pathway that can surface facts from a specific date range independent
of semantic similarity. mmemory cannot answer "what happened to X between DATE1 and
DATE2" without loading all chunks.

---

## 2. Retention Pipeline

### Hindsight
- Retain sends raw content to the Hindsight HTTP API (`POST /memories`).
- Server-side LLM (configurable; default same model as reflect) extracts structured
  facts from the content immediately.
- Extracted facts are deduplicated and consolidated server-side — the server
  maintains observations across the bank, not raw verbatim transcripts.
- `retainBatch` sends N items in one request; server deduplicates them together.
- `retain` is fire-and-forget from the tool perspective: `async: true` lets the
  server respond immediately and process in background.
- Auto-retain triggers on `agent_end`; the debounced `HindsightRetainQueue`
  (batch size 16, 5 s timer) coalesces tool-initiated retains separately from
  auto-retain, which submits the full session transcript as one item.

### mmemory
- `retainSession()` in `mmemory-extension.ts` writes the full (or windowed)
  transcript to a `.md` file and fires a background `build` action.
- Build action (`_run_build()`) chunks the file, incremental-diffs against
  existing vectors, embeds new chunks, saves safetensors + BM25 JSON.
- No server-side fact extraction: the full transcript is stored and chunked as-is
  (verbatim mode). Structured mode config knob exists but the LLM extraction call
  is stubbed (improvement-plan item H6 / gap 3 below).
- Tool-initiated `mmemory_retain` writes a note `.md` file directly and triggers
  build — no queue, no batching.
- Deduplication is post-build: `dedup_check` action available but not called
  automatically during `retainSession` (improvement-plan item C1/H2).

**Gap 3 — Server-side LLM extraction:** Hindsight never stores raw transcripts.
Every retained item is passed through an LLM that extracts what/when/where/who/why
facts before storage. mmemory Phase 1 skips this entirely and stores verbatim
session transcripts. This is the deepest architectural difference: Hindsight's
retrieval quality improves over time as consolidation synthesizes observations from
raw facts, while mmemory retrieval degrades linearly as the corpus grows (more noise,
longer BM25 token lists, more chunks to score).

**Gap 4 — Automatic consolidation:** Hindsight runs a background consolidation pass
when the bank reaches thresholds, merging related raw facts into higher-level
observations. mmemory has no equivalent (Phase 5 of improvement plan).

**Gap 5 — Batch deduplication at retain time:** Hindsight's `retainBatch` sends
multiple items together so the server can detect near-duplicates within the batch
before committing. mmemory's incremental build detects exact-hash matches but has
no semantic dedup at write time (only `dedup_check` action for manual use, and
improvement-plan item Phase 4).

---

## 3. Tool Interface

### Hindsight
- `retain(items[])` — array of items; `content`, optional `context`, `tags`,
  `metadata`, `documentId`, `updateMode`, `observationScopes`, `strategy` per item.
- `recall(query, opts)` — typed `types[]`, `maxTokens`, `budget` (low/mid/high),
  tag filter + match mode.
- `reflect(query, opts)` — separate endpoint; server-side LLM synthesizes answer
  from relevant memories using a `reflectMission` prompt. Returns prose, not a list.

### mmemory
- `mmemory_retain(content)` — single content string, no batch, no tags, no
  strategy override.
- `mmemory_recall(query, scope?)` — returns bullet list of raw chunk texts with
  scores; no budget/type filtering.
- `mmemory_reflect(query, scope?)` — implemented as `recall` with 2× limit;
  returns the same bullet list, not a synthesized prose answer.

**Gap 6 — Reflect is not reflect:** Hindsight's `reflect` is a server-side
`POST /reflect` that runs an LLM over the retrieved memories to produce a direct
answer to the query. mmemory's `executeMemoryReflect` is `recall` with a higher
limit. The output format and quality are fundamentally different.

**Feasibility note:** Implementing true reflect requires an LLM call inside the
Python server. This needs either a local model (too heavy for a background process)
or routing through `ctx.executePython` to call the omp LLM API. The latter requires
the `executePython` bridge that was added to `ExtensionContext` for Phase 1; it is
the correct path for Phase 2. Not skipped for difficulty — skipped because it
depends on structured extraction (gap 3) being wired first.

**Gap 7 — `retain` batching and tagging:** mmemory_retain does not support batch
submission, per-item tags, or `observationScopes`. These are lower priority since
mmemory does not use a tag-based cross-project model by default, but `tags` would
be needed to implement `per-project-tagged` scoping correctly (improvement-plan M3).

---

## 4. Auto-recall Lifecycle

### Hindsight
- `maybeRecallOnAgentStart()` fires on every `agent_start` event until
  `hasRecalledForFirstTurn = true`.
- `beforeAgentStartPrompt()` fires synchronously on the first user turn before
  the LLM call; it races the recall against
  `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS` so the mental-model block (if loaded)
  lands first, then recall appends.
- The recall snippet is injected into `buildDeveloperInstructions()` on every
  subsequent turn, so the LLM always has it in the system prompt.
- On `session.compacting`, `recallForCompaction()` issues a fresh recall against
  the last user message so the compacted context retains memory grounding.

### mmemory
- `before_agent_start` fires; on the first turn it calls `executeMemoryRecall`
  with a 400-char slice of the prompt.
- Result is cached in `state.lastRecallSnippet` and injected on every subsequent
  turn via the same `before_agent_start` handler (not a separate
  `buildDeveloperInstructions` path).
- On `session.compacting` it queries against the first user message.
- No `agent_start` fallback separate from `before_agent_start`.

**Gap 8 — Recall snippet re-injection approach:** Hindsight injects through
`buildDeveloperInstructions`, a separate hook that rebuilds the system prompt on
every turn. mmemory injects through `before_agent_start` and caches the snippet —
meaning the snippet does not refresh within a session even if later recalls would
return different results. In practice this is acceptable since mmemory does not
update the memory store mid-session, but it means the LLM never sees memories
retained by a concurrent session.

---

## 5. Mental Models

### Hindsight
Mental models are named, server-maintained, LLM-generated summaries that are:
- Seeded from `seeds.json` on first session (idempotent create-only)
- Refreshed by the server after each consolidation pass
- Loaded asynchronously at session start; cached with a TTL
- Rendered into a `<mental_models>` block injected into developer instructions
- Three built-in seeds: `user-preferences`, `project-conventions`,
  `project-decisions`

### mmemory
No equivalent. The `facts.json` is empty until structured extraction is wired
(Phase 2). There is no concept of a curated, auto-refreshed summary.

**Gap 9 — Mental models (most impactful gap):** Hindsight's mental models provide
stable, synthesized context that does not require per-turn recall. They amortize
the cost of extracting patterns from the memory bank across sessions. Without them,
recall quality degrades as the corpus grows because no higher-level synthesis exists.

**Feasibility:** Mental models require server-side consolidation + LLM reflection
(gaps 3, 4). They cannot be added without first resolving those. Phase 5
(consolidation) enables a simplified version. Deferred to Phase 5.

---

## 6. Scoping

### Hindsight
Three modes: `global`, `per-project`, `per-project-tagged`.
`per-project-tagged` uses a single shared bank with `project:<cwd-basename>` tags
on retain and an `any` tag match on recall (so global memories surface alongside
project-tagged ones).

### mmemory
Three modes in config; `per-project-tagged` is the default. However, the Python
server's `_handle_recall()` treats `per-project-tagged` identically to
`per-project`: it filters by `project.lower() in chunk_path.lower()`. The tag
mechanism is not implemented.

**Gap 10:** Documented in improvement-plan item M3. The scoping model is
architecturally aligned with Hindsight's but the cross-project "tagged" retrieval
path (surfacing global memories alongside project ones) is not implemented.
Per-project isolation works correctly today.

---

## 7. Subagent Handling

### Hindsight
Subagents (`taskDepth > 0`) receive an alias `HindsightSessionState` that
references the parent's bank, client, tags, and missionsSet. Alias states skip
auto-recall and auto-retain — only the root session drives those. Tool calls
from subagents persist to the same bank as the parent.

### mmemory
The extension creates a new `MmemorySessionState` for every `session_start`
event. There is no alias/delegation mechanism. If a subagent writes a memory file,
it will trigger a background build, and any recall by the subagent will query the
same storage root (same `storagePath`). Auto-retain is not suppressed in subagents.

**Gap 11:** Subagent recall is correct (same storage), but subagent auto-retain
will write a separate session `.md` file for the subagent's transcript. This is
undesirable: subagent exploration transcripts pollute the memory store. The fix is
to detect `taskDepth > 0` (or an equivalent extension hook) and suppress
`autoRetain` for subagent sessions.

**Feasibility:** Requires `ExtensionContext` to expose `taskDepth` (or an
`isSubagent` flag). This field exists on `MemoryBackendStartOptions`
(`options.taskDepth > 0` in `hindsight/backend.ts`) but is not currently forwarded
to the extension `ctx`. Low-effort patch; Phase 2 prerequisite.

---

## 8. Clear / Delete

### Hindsight
`clear()` in `hindsight/backend.ts` drains the retain queue and wipes local state.
It explicitly does NOT delete the upstream bank; operators must use the Hindsight
UI. A notice is logged.

### mmemory
`/mmemory clear` guard logic exists in `builtin-registry.ts` but the deletion step
(walk `memoryDir`, filter by date, delete `.md` files, trigger rebuild) is not
implemented (improvement-plan gap 3).

**Gap 12:** Documented. Local file deletion is feasible and straightforward; no
external API dependency. The guard + confirmation UI structure already exists.

---

## Summary Table

| Feature | Hindsight | mmemory Phase 1 | Gap # | Priority |
|---|---|---|---|---|
| Semantic retrieval | ✓ text-embedding-3-small (1536d) | ✓ bge-small-en-v1.5 (384d) | — | — |
| BM25 keyword retrieval | ✓ | ✓ | — | — |
| RRF fusion | ✓ server-side | ✓ local | — | — |
| Recency boost | ✓ temporal axis (separate pathway) | ✓ filename-decay heuristic | 2 | Phase 2 |
| Knowledge graph retrieval | ✓ 1-hop entity expansion | ✗ | 1 | Phase 2 |
| Server-side LLM extraction | ✓ structured facts (5-dim) | ✗ verbatim transcript | 3 | Phase 2 |
| Automatic consolidation | ✓ background LLM pass | ✗ | 4 | Phase 5 |
| Batch dedup at retain | ✓ within-batch | ✗ | 5 | Phase 4 |
| Reflect = prose synthesis | ✓ server LLM call | ✗ (= recall ×2) | 6 | Phase 2 |
| Batch retain / per-item tags | ✓ | ✗ single item | 7 | Phase 2 |
| Recall snippet re-injection | ✓ `buildDeveloperInstructions` | ~cached snippet | 8 | Low |
| Mental models | ✓ 3 seeded, auto-refresh | ✗ | 9 | Phase 5 |
| `per-project-tagged` cross-project | ✓ tag-filtered recall | ✗ (= per-project) | 10 | Phase 2 |
| Subagent auto-retain suppression | ✓ alias state | ✗ | 11 | Phase 2 |
| `/clear` file deletion | N/A (server-side) | ✗ | 12 | Phase 2 |

---

## Embedding Model Comparison

### mmemory: BAAI/bge-small-en-v1.5 via fastembed
- **Dimensions:** 384
- **Parameters:** ~33M (small)
- **MTEB average:** ~58–60
- **Storage per 1k chunks:** ~1.5 MB (384 × 4 bytes × 1000)
- **Inference:** local CPU, no network call, no API cost
- **fastembed note:** fastembed wraps bge-small-en-v1.5 with mean pooling + L2
  normalization at inference; the wrapper produces already-normalized vectors.

### Hindsight default: text-embedding-3-small (OpenAI)
- **Dimensions:** 1536 (default; can be reduced via `dimensions` parameter)
- **Parameters:** unknown (proprietary)
- **MTEB average:** ~62.3 (roughly 3–4 points higher than bge-small-en-v1.5)
- **Storage per 1k chunks:** ~6 MB (1536 × 4 bytes × 1000) at full dimensions
- **Inference:** API call to OpenAI; network latency, per-token cost, requires API key

### Assessment

**Quality gap is real but modest at small corpus sizes.** text-embedding-3-small
scores ~3–4 MTEB points higher than bge-small-en-v1.5, primarily on retrieval and
STS tasks. In practice the gap manifests as reduced recall on semantically distant
paraphrases — bge-small-en-v1.5 handles exact or near-paraphrase queries well.

**The more important gap is structural, not model:** Hindsight's retrieval quality
advantage comes primarily from its consolidation pipeline (raw facts → observations
→ reflect synthesis) and graph layer, not from the embedding model itself. Using
text-embedding-3-small on top of verbatim transcript chunks (mmemory's current
approach) would not close gap 3 (extraction) or gap 9 (mental models).

**Upgrade path:** fastembed supports `BAAI/bge-base-en-v1.5` (768-dim, ~110M params,
MTEB ~63.6) and `BAAI/bge-large-en-v1.5` (1024-dim, MTEB ~63.6) as drop-in
replacements. `bge-base-en-v1.5` is a material improvement at 2× storage/compute
cost and would narrow the gap to text-embedding-3-small. However, upgrading the
model invalidates all existing vectors — a full rebuild is required. Recommend
deferring to Phase 2 alongside the extraction rewrite, where rebuild is already
required.

**Not recommended:** Using text-embedding-3-small or another API model in the Python
server would introduce network latency into every build, require API key management
in the Python subprocess, and add per-token cost. The local model is the correct
architecture for an offline background process.
