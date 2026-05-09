# mmemory — Local Semantic Memory Extension

Local, fully-offline session memory for omp (aws-corp branch).
Stores conversation context as searchable semantic + BM25 chunks, recalled
automatically at the start of each agent turn to give the model persistent memory
across sessions.

No cloud embedding API required. Uses [fastembed](https://github.com/qdrant/fastembed)
with `BAAI/bge-small-en-v1.5` (~25 MB model, first-run download only).

---

## Architecture

```
Extension (TypeScript)                    Python server (TCP, port 49200)
──────────────────────────────            ─────────────────────────────────────
session_start → get_injection_snapshot ─→  returns sessions + obs + files blocks
before_agent_start (per turn) → same   ─→  obs fallback when anchor covers all
agent_end → retain → build             ─→  _handle_build  → embed + store
/mmemory recall / reflect               ─→  _handle_recall → BM25 + cosine
vacuum (background)                     ─→  _handle_vacuum → purge stale chunks
```

One Python server process handles all projects. It starts on first use,
idles for 10 minutes, then self-terminates. The next query restarts it.

---

## Storage layout

```
mmemory.storageRoot/
  chunks.json              durable store: session + file + observation chunks
  vectors.safetensors      embeddings (BAAI/bge-small-en-v1.5, 384 dims); rebuildable
  vectors.meta.json        {model, count} for rebuild validation
  queue/                   transient .md files written by extension; empty after build
  vacuum-state.json        {last_vacuum_ts} written by vacuum on completion
  mmemory-server.log       Python server stderr
  mmemory-server-<port>.pid  server PID (written by server, deleted on clean exit)
```

Queue files carry YAML frontmatter:

```
---
project: <normalized cwd, e.g. D/.ai>
source: session | file | observation
ts: <unix seconds>
read_files: []        # absolute paths; session source only
modified_files: []    # absolute paths; session source only
written_files: []     # absolute paths; session source only
---

<transcript content>
```

File chunks (`source: file`) use `path:` and `action: read|write|modified` frontmatter
instead of transcript content. `agent_tag` and `session_id` are not written to queue files.

Project label is auto-derived from the normalized working directory:
  `D:\.ai` → `D/.ai`, `C:\repos\carity2` → `C/repos/carity2`
Not configurable. Use `agentTag` to isolate memories within the same project.

The server reads frontmatter fields as chunk metadata for filtering. Source-specific
fields (read_files/modified_files/written_files) are parsed into per-path file chunks.

---

## Config (`mmemory:` block in config.yml)

```yaml
mmemory:
  enabled: true
  storageRoot: ~/mmemory          # full path; project label auto-derived from cwd

  # LLM roles
  modelRole: memory               # recall synthesis, reflect; requires cheap/fast model
  timeFilterModelRole: ~          # time-hint LLM; falls back to modelRole when null
  consolidateModelRole: memory    # consolidation LLM

  # Retention
  retainMission: ""               # context injected into every queue file
  extractionMode: verbatim        # verbatim = turn-boundary transcripts (current)
  retainEveryNTurns: 3
  retainContextTurns: 3
  autoRetain: true

  # Scoping
  agentTag: default
  scoping: per-project            # per-project | global

  # Recall
  recall:
    limit: 10
    deadlineMs: 10000
    maxQueryChars: 2000
    recencyWeight: 0.3
    fileLimit: 20
    includeReadFiles: false
    observationLimit: 10

  # Injection snapshot (system prompt)
  injection:
    sessionLimit: 5
    observationLimit: 3
    fileLimit: 5
    maxChars: 8000

  # Consolidation
  consolidationMinTurns: 10
  consolidationMaxTurns: 50
  consolidationPollIntervalMinutes: 5
  consolidationMaxObservationChars: 400

  # Vacuum
  vacuum:
    enabled: true
    intervalHours: 24
    sessionMaxAgeDays: 365
    observationMaxAgeDays: 90
    fileMaxAgeDays: 180

  # Server
  serverPort: 49200
  serverIdleTimeoutMinutes: 10
  serverLogFile: ~                # null = <storageRoot>/mmemory-server.log

  maxTranscriptChars: 0
  deduplicationThreshold: 0.92
```

---

## Slash commands

```
/mmemory recall <query>             recall with current session scope
/mmemory recall / <query>           one-time global recall (no project filter)
/mmemory reflect <query>            reflect synthesis (LLM pass over recalled chunks)
/mmemory retain                     write queue file now (no wait for turn end)
/mmemory view                       show current recall snippet
/mmemory clear [--from D] [--to D]  delete chunks by time range
/mmemory clear --session <id>       delete chunks from one session
/mmemory enqueue <text>             manually add text to the queue
# (Phase 3 slash commands removed — consolidate/mm are not yet implemented)
/mmemory status                     show scope, chunk count, enabled, path

# Scope switching (session-sticky)
/mmemory /                          global scope — no project filter
/mmemory .                          reset to current project (default)
/mmemory <name>                     switch to named project (e.g. /mmemory carity2)
```

Scope set via `/mmemory /`, `.`, or `<name>` persists for the session.
`/mmemory recall / <query>` overrides scope for that one query without changing session state.

---

## Recall filter

`_handle_recall` accepts an optional `filter` object:

```json
{
  "project":   "D/.ai",
  "agent_tag": "default",
  "source":    ["session", "file", "observation"],
  "ts_after":  1746000000,
  "ts_before": 1747000000
}
```

All fields are optional. Missing field = no constraint. Applied as a post-RRF
mask: chunks not matching are excluded before top-K selection.

---

## Time-filter prompt override

The temporal query pre-processor uses a system prompt baked into the binary at build time.
On first run it is written to disk so you can customise it:

- Compiled: `<binary-dir>/mme-time-filter.prompt.md`
- Dev: `~/.omp/mme-time-filter.prompt.md`

Edit the local copy to adapt time expressions for different languages or regional conventions.
The embedded version is restored if the local copy is older than the binary build timestamp
(same pattern as `mreview-ui.html`).

## Files

| File | Purpose |
|---|---|
| `mmemory_server.py` | Python TCP server: build/recall/vacuum/consolidate/get_injection_snapshot |
| `mmemory_vacuum.py` | VacuumWorker: reads chunks, returns surviving paths (no I/O side-effects) |
| `server-client.ts` | TypeScript TCP client: spawn, ping, query, drain |
| `index.ts` | `loadMmemoryConfig`, `resolvePaths`, `executeMemoryRecall/Build/Consolidate` |
| `mmemory-backend.ts` | `MemoryBackend` impl: start, beforeAgentStartPrompt, buildDeveloperInstructions |
| `time-filter.ts` | LLM temporal query parser; returns `TimeFilter` with ts_after/ts_before/source |
| `retain-tool.ts` | `mmemory_retain` LLM-callable tool |
| `recall-tool.ts` | `mmemory_recall` LLM-callable tool |
| `reflect-tool.ts` | `mmemory_reflect` LLM-callable tool |
| `../../mmemory-extension.ts` | Extension: event handlers, slash command, session retain |
---

## Singleton guard (server)

Three-layer guard prevents multiple server instances when two OMP windows start simultaneously:

1. Pre-spawn port ping — exit if a live server already answers
2. PID file double-write CAS — last writer wins (50ms window)
3. `SO_EXCLUSIVEADDRUSE` on Windows / `SO_REUSEADDR` on Linux — OS-level bind guard

---

## Migration

On the first build after upgrading from an older layout (`storageRoot/index/`),
the server automatically migrates existing chunks to the flat layout:

- Reads `index/chunks.json`, backfills metadata (project, source, ts from filename)
- Writes `chunks.json` atomically
- Copies `index/vectors.safetensors` → `vectors.safetensors`
- Deletes `index/`

No manual action required.

---

## Requirements

```
pip install fastembed safetensors numpy
```

Python 3.9+. Model downloads on first use to `~/.cache/fastembed/`.
