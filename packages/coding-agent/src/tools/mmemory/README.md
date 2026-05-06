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
Extension (TypeScript)                Python server (TCP, port 49200)
──────────────────────────────        ─────────────────────────────────
before_agent_start → recall  ──────→  _handle_recall  → BM25 + cosine
agent_end → retain           ──────→  _handle_build   → embed + store
/mmemory flush               ──────→  _handle_build   (manual trigger)
```

One Python server process handles all projects. It starts on first use,
idles for 10 minutes, then self-terminates. The next query restarts it.

---

## Storage layout

```
mmemory.storageRoot/
  chunks.json          all session chunks; metadata: project, source, ts, session_id
  vectors.safetensors  embedding index (BAAI/bge-small-en-v1.5, 384 dims)
  vectors.meta.json    model name + chunk count for rebuild validation
  queue/               transient .md files written by extension; deleted after build
  facts.json           structured extraction (Phase 3)
  observations.json    consolidated facts (Phase 3)
  mental_models/       seeded session summaries (Phase 3)
  mmemory-server.log   Python server stderr
  mmemory-server-<port>.pid  server PID (written by server, deleted on clean exit)
```

Queue files carry YAML frontmatter:

```
---
project: <normalized cwd, e.g. D/.ai>
agent_tag: default
source: session
session_id: <id>
ts: <unix seconds>
---

# Memory — YYYY-MM-DD
...
```

Project label is auto-derived from the normalized working directory:
  `D:\.ai` → `D/.ai`, `C:\repos\carity2` → `C/repos/carity2`
Not configurable. Use `agentTag` to isolate memories within the same project.

The server strips the frontmatter before chunking and stores the fields as
chunk metadata, enabling filtered recall.

---

## Config (`mmemory:` block in config.yml)

```yaml
mmemory:
  enabled: true

  # Full path to the storage root. All data is stored here.
  storageRoot: ~/mmemory

  # Model role for LLM calls (fact extraction, reflect synthesis, consolidation).
  # Any model with >= 32k context window works. Cheap/fast preferred.
  modelRoles:
    memory: <provider/model>

  # Recall
  recallMaxQueryChars: 2000   # max chars composed from recent turns for query
  recallTopK: 5               # results injected into system prompt

  # Retain
  retainEveryNTurns: 1        # write queue file after every N agent turns
  retainMission: ""           # optional context included in every queue file

  # Scoping
  agentTag: default           # isolates memories by agent identity within same project
                              # global scope (/mmemory /) bypasses this filter
                              # existing chunks without this field default to "default"

  # Server
  serverPort: 49200
  serverIdleTimeoutMinutes: 10
  # serverLogFile: ~          # default: <storageRoot>/mmemory-server.log

  # Phase 3
  extractionMode: none        # none | llm
  maxRawFacts: 100
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
/mmemory consolidate                merge facts.json → observations.json (Phase 3)
/mmemory mm list                    list mental models
/mmemory mm regenerate              regenerate all mental models
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
  "source":    ["session", "document"],
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
| `mmemory_server.py` | Python TCP server: embed, build, recall, BM25, singleton guard |
| `server-client.ts` | TypeScript TCP client: spawn, ping, query, drain |
| `index.ts` | `loadMmemoryConfig`, `resolvePaths`, `executeMemoryRecall/Build` |
| `../../mmemory-extension.ts` | Extension factory: registers event handlers, slash command |

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

- Reads `index/chunks.json`, backfills metadata (project, source, ts from filename, session_id)
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
