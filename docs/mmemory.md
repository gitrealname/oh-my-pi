# mmemory — Local Semantic Memory for omp

mmemory is a local, offline memory system built into omp. It retains session
transcripts, indexes them with BM25 + semantic search, and injects relevant
memories into the system prompt at the start of each session.

**No external service, no API keys, no cost beyond the embedding model download.**
All data stays on disk under a configurable `storagePath`.

---

## Enabling mmemory

In your `config.yml`:

```yaml
mmemory:
  enabled: true
  storagePath: D:/.ai/knowledge/projects   # where memory is stored
  projectName: omp_memory                  # subdirectory name
```

Requires Python + `pip install fastembed safetensors numpy`.
The embedding model (`BAAI/bge-small-en-v1.5`, ~130 MB) is downloaded on first
use to `%LOCALAPPDATA%/fastembed/`.

---

## How It Works

```
Session ends (every N turns)
       ↓
Extension writes YYYYMMDD-HHMMSS-<sessionId>.md to queue/
       ↓
Python server reads queue/*.md
  → chunks each transcript at turn boundaries (User+Assistant pairs)
  → hashes each chunk; skips chunks already in chunks.json
  → embeds new chunks with BAAI/bge-small-en-v1.5 (fastembed)
  → appends new chunks to index/chunks.json
  → extends index/vectors.safetensors
  → deletes processed .md files from queue/
       ↓
Next session starts
  → extension queries server: parallel BM25 + cosine similarity
  → RRF merge + recency boost
  → top results injected as <memories> block into system prompt
```

The Python server starts lazily on first recall query and self-terminates after
`serverIdleTimeoutMinutes` (default 10). It runs at BELOW_NORMAL priority with no
visible console window.

---

## Storage Layout

```
storagePath/
  projectName/              e.g. omp_memory/
    queue/                  ← .md files arrive here; always empty after a build
    index/
      chunks.json           ← DURABLE STORE: full text of all indexed chunks
      vectors.safetensors   ← rebuildable from chunks.json
      vectors.meta.json     ← {model, count} for rebuild validation
    mental_models/          ← Phase 3: auto-generated summaries
    facts.json              ← Phase 3: extracted facts
    observations.json       ← Phase 3: consolidation output
    .gitignore              ← * (all memory data private)
    kb_config.yaml          ← auto-generated: type: external, handler: mmemory
  global/                   ← cross-project memories (per-project-tagged scope)
    queue/
    index/
    .gitignore
    kb_config.yaml
```

`chunks.json` is the durable store. If `vectors.safetensors` is lost, run
`/mmemory rebuild` to re-embed from `chunks.json`. If `chunks.json` is lost,
memories are gone — it is the primary record.

---

## Configuration Reference

```yaml
mmemory:
  enabled: true

  # Storage (machine-specific — set in deployed config, not in template)
  storagePath: D:/.ai/knowledge/projects
  projectName: omp_memory           # layout: storagePath/projectName/{queue,index}/

  # LLM roles
  modelRole: smol                   # reflect synthesis (Phase 2); extraction (Phase 3)
  consolidateModelRole: smol        # consolidation + mental model seeding (Phase 3)
                                    # upgrade to a large-context model when Phase 3 is wired

  # Retention
  retainMission: "Focus on technical decisions, API contracts, constraints, error patterns, and project conventions"
  extractionMode: verbatim          # verbatim = turn-boundary transcripts (Phase 2)
                                    # structured = LLM extracts {fact, entities, date} (Phase 3)
  retainEveryNTurns: 3              # write a memory file every N agent turns
  retainContextTurns: 0             # 0 = full session; N = last N turns only

  # Scoping
  scoping: per-project-tagged       # per-project        = this project's queue/ only
                                    # per-project-tagged = project + global/ (cross-project)
                                    # global             = all projects

  # Recall
  recallLimit: 10                   # max chunks returned
  recallDeadlineMs: 10000           # abort if server doesn't respond (cold start protection)
  recencyWeight: 0.3                # exponential decay: score *= exp(-age_days/30 * weight)
  deduplicationThreshold: 0.92      # cosine similarity above which a new chunk is near-duplicate

  # Server
  serverIdleTimeoutMinutes: 10      # server self-terminates after N minutes idle
```

---

## Slash Commands

| Command | Description |
|---|---|
| `/mmemory recall <query>` | Search project memory, inject results into conversation |
| `/mmemory reflect <query> [--scope <scope>]` | Retrieve memories as a synthesis prompt |
| `/mmemory retain` | Auto-retain is handled by the extension; this is informational only |
| `/mmemory view` | Show current recall snippet in context |
| `/mmemory status` | Show enabled state, project name, chunk count, scoping |
| `/mmemory clear --from DATE [--to DATE]` | Remove chunks in date range from `chunks.json` |
| `/mmemory clear --session ID` | Remove chunks from a specific session |
| `/mmemory enqueue` | Force a retain cycle now |

Date format for `--from`/`--to`: `YYYY-MM-DD`.

---

## LLM-Callable Tools

| Tool | Description |
|---|---|
| `mmemory_recall(query, scope?)` | Search memory; returns scored chunks |
| `mmemory_retain(content)` | Write a note to `queue/`; triggers background build |
| `mmemory_reflect(query, scope?)` | Returns chunks formatted as a synthesis prompt |

All three tools are gated on `mmemory.enabled`. They are available when the
extension is active and will appear in the LLM's tool list automatically.

**`.memory` shortcut:** Prefix any user message with `.memory <query>` to inject a
`<memory_mode>` directive — the LLM will immediately use the memory tools without
waiting for context to accumulate.

---

## Subagent Behaviour

Subagents (`task` tool calls) have `taskDepth > 0`. The mmemory extension returns
`null` for these sessions — no auto-retain, no auto-recall. This prevents subagent
exploration transcripts from polluting the memory store.

Tool-initiated recall from subagents still works (the tools call the server
directly and are stateless).

---

## Phase 2 — What Was Implemented

Phase 2 was completed 2026-05-03 against the `aws-corp` branch.

| Item | Detail |
|---|---|
| Subagent guard | `taskDepth > 0 → null` — subagent transcripts never retained |
| Anti-feedback stripping | `<memories>` and `<mental_models>` tags stripped before writing |
| Reflect synthesis framing | Returns memories as synthesis prompt for the calling LLM |
| `/clear` via server lock | Runs under `_build_lock`; no race with in-flight builds |
| Session dedup — fixed filename | `YYYYMMDD-HHMMSS-<sessionId>.md` overwrites each cycle |
| Turn-boundary chunking | Each chunk = one user+assistant pair; `---` separators stripped for hash stability |
| Directory-based global scoping | `global/` dir; parallel recall merged with RRF |
| No visible window | `windowsHide: true` on `Bun.spawn` |
| Background priority | `SetPriorityClass(BELOW_NORMAL)` on Windows; `os.nice(5)` on Unix |
| Logger integration | Python stderr → `logger.debug/warn` via omp logger |
| Privacy `.gitignore` | Written at `projectDir` + `storagePath` on first use |
| Build coalescing | `_pending_build` set; at most 2 sequential builds |
| H5 BM25 fix | `max(2, N*0.5)` pruning threshold (prevents over-pruning small corpora) |
| `_run_build` zero-vector fix | `else` branch re-embeds all chunks; zero-padding removed |

---

## Phase 3 — Roadmap

See `.mmemory-phase3-todo.md` (repo root) for the full checklist. Summary:

| Item | Trigger |
|---|---|
| LLM extraction (`{fact, entities[], date}`) | >30 sessions, quality degrading |
| Consolidation + mental models | After extraction; `/mmemory consolidate` |
| Recall query composition | Port Hindsight's multi-turn query builder |
| Assistant truncation removal | Remove 1000-char cap in `buildTranscript()` |
| Dual-system unification | Extension owns all state; tools are thin wrappers |

---

## Troubleshooting

**Server won't start / fastembed error:**
```
pip install fastembed safetensors numpy
```
Then restart omp.

**Memories not appearing:**
1. `/mmemory status` — confirm enabled, check chunk count
2. If chunk count = 0, no sessions have been retained yet (need `retainEveryNTurns` agent turns)
3. If chunk count > 0 but recall returns nothing, try `/mmemory recall <specific query>`

**Want to wipe all memories:**
Delete `index/chunks.json` and `index/vectors.safetensors` directly (or the entire `projectName/` directory). The extension recreates the directory structure on next session start.

**Vectors out of sync after `/clear`:**
The server deletes `vectors.safetensors` automatically when chunks are cleared.
The next recall triggers a rebuild from the remaining `chunks.json` entries.
This takes a few seconds — normal.

**Seeing a Python process in Task Manager:**
That's the mmemory recall server (`mmemory_server.py`). It runs at BELOW_NORMAL
priority and self-terminates after `serverIdleTimeoutMinutes` of inactivity.
