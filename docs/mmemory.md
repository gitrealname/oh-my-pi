# mmemory — Local Semantic Memory for omp

mmemory is a local, offline memory system built into omp. It retains session
transcripts, indexes them with BM25 + semantic search, and injects relevant
memories into the system prompt at the start of each session.

**No external service, no API keys, no cost beyond the embedding model download.**
All data stays on disk under a configurable `storageRoot`.
---

## Enabling mmemory

In your `config.yml`:

```yaml
mmemory:
  enabled: true
  storageRoot: D:/.ai/knowledge/projects/omp_memory   # full path to memory directory
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
  → appends new chunks to chunks.json
  → extends vectors.safetensors
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
storageRoot/                    e.g. D:/.ai/knowledge/projects/omp_memory/
  queue/                        ← .md files arrive here; always empty after a build
  chunks.json                   ← DURABLE STORE: full text of all indexed chunks
  vectors.safetensors           ← rebuildable from chunks.json
  vectors.meta.json             ← {model, count} for rebuild validation
  mental_models/                ← Phase 3: auto-generated summaries
  facts.json                    ← Phase 3: extracted facts
  observations.json             ← Phase 3: consolidation output
  .gitignore                    ← * (all memory data private)
  kb_config.yaml                ← auto-generated: type: external, handler: mmemory
```

Project label is auto-derived from the normalized working directory:
  `D:\.ai` → `D/.ai`, `C:\repos\carity2` → `C/repos/carity2`
Not configurable. Use `agentTag` to isolate memories within the same project.

### Queue file format

Each `.md` file written to `queue/` includes YAML frontmatter:

```yaml
---
project: D/.ai
agent_tag: default
source: session | retain_tool
session_id: <uuid>
ts: 2026-05-05T12:34:56.000Z
---
<transcript content>
```

### Chunk metadata

Each chunk stored in `chunks.json` carries the same fields (`project`, `agent_tag`, `source`,
`session_id`, `ts`) used for filtering during recall.

### Recall filters

`mmemory_recall` and `mmemory_reflect` accept optional filter parameters:

| Filter | Type | Description |
|---|---|---|
| `project` | string | Restrict to chunks from a specific project label |
| `agent_tag` | string | Restrict to chunks from a specific agent tag |
| `source` | string | Restrict to `session` or `retain_tool` chunks |
| `ts_after` | number | Unix seconds — exclude chunks older than this timestamp |
| `ts_before` | number | Unix seconds — exclude chunks newer than this timestamp |

The time-filter system prompt is written to disk on first run and can be customised:
  Compiled : <binary-dir>/prompts/mmemory-time-filter.md
  Dev      : ~/.omp/agent-work/prompts/mmemory-time-filter.md
Edit the local copy to adapt time expressions for different languages or conventions.
The binary version is restored if the local copy is older than the build timestamp.
### Migration

On first build after upgrade, the server automatically migrates the legacy `index/`
layout to the flat layout. No manual intervention is required.

`chunks.json` is the durable store. If `vectors.safetensors` is lost, run
`/mmemory rebuild` to re-embed from `chunks.json`. If `chunks.json` is lost,
memories are gone — it is the primary record.

---

## Configuration Reference

```yaml
mmemory:
  enabled: true

  # Storage (machine-specific — set in deployed config, not in template)
  storageRoot: D:/.ai/knowledge/projects/omp_memory   # full path; project label = auto-derived from cwd

  # LLM roles
  modelRole: smol                   # reflect synthesis (Phase 2); extraction (Phase 3)
  timeFilterModelRole: ~           # model role for time-hint LLM preprocessing;
                                    #   falls back to modelRole. Use a cheap/fast model.
                                    #   Default: inherits modelRole.
  consolidateModelRole: smol        # consolidation + mental model seeding (Phase 3)
                                    # upgrade to a large-context model when Phase 3 is wired

  # Retention
  retainMission: "Focus on technical decisions, API contracts, constraints, error patterns, and project conventions"
  extractionMode: verbatim          # verbatim = turn-boundary transcripts (Phase 2)
                                    # structured = LLM extracts {fact, entities, date} (Phase 3)
  retainEveryNTurns: 3              # write a memory file every N agent turns
  retainContextTurns: 0             # 0 = full session; N = last N turns only

  # Scoping
  scoping: per-project             # per-project = this project's queue/ only
                                    # global      = all projects
  agentTag: default                 # isolates memories by agent identity within same project
                                    # global scope (/mmemory /) bypasses this filter
                                    # existing chunks without this field default to "default"
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


### Scope switching (session-sticky)

```
/mmemory /                          global scope — recall searches all projects
/mmemory .                          reset to current project (default)
/mmemory <name>                     switch to named project (e.g. /mmemory carity2)
/mmemory recall / <query>           one-time global recall without changing session scope
```
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


## Query Examples and Processing Paths

Each scenario below shows what triggers the memory system, what query is built,
and how the result flows back into the session.

---

### 1. Session starts — auto-recall

**Trigger:** `before_agent_start` fires on the first agent turn.

**What happens:**
```
User types: "Continue the refactor from yesterday."

Extension reads last 3 turns of prior context (retainContextTurns=3)
  → composeRecallQuery("Continue the refactor from yesterday.", messages, 3)
  → builds: "Prior context:\nassistant: ...\nuser: ...\n\nContinue the refactor from yesterday."
  → truncateRecallQuery(..., 2000) — trims oldest context lines if over 2000 chars
  → query sent to Python server

Python server:
  1. Embeds query with BAAI/bge-small-en-v1.5
  2. Parallel: cosine similarity against vectors.safetensors
                BM25 keyword search against chunks.json
  3. RRF merge → recency decay → facts.json keyword overlap (1.2×)
                              → observations.json keyword overlap (1.5×)
  4. Returns top-10 chunks/facts/observations sorted by score

Extension injects into system prompt:
  <memories>
  Found 5 relevant memories:
  • User: What's the status of the auth refactor? Assistant: ... (score: 0.821)
  • ...
  </memories>
```

**Slash equivalent:** `/mmemory recall Continue the refactor from yesterday.`
Difference: slash command prompts the agent with the result as a user message
(visible in conversation). Auto-recall injects silently into the system prompt.

---

### 2. `.memory` shortcut — direct memory steering

**User types:** `.memory what error patterns did we hit with the DB connection pool?`

**What happens:**
```
Extension intercepts in before_agent_start (prefix check before turnCount++)
Injects into system prompt:
  <memory_mode>
  Direct memory request. Use mmemory_recall, mmemory_retain, or mmemory_reflect
  immediately based on the user's intent.
  Query: what error patterns did we hit with the DB connection pool?
  </memory_mode>

Agent reads the directive, immediately calls mmemory_recall tool with that query.
Tool response surfaces in the conversation as a tool result (visible).
```

**Slash equivalent:** `/mmemory recall what error patterns did we hit with the DB connection pool?`
Difference: `.memory` steers the agent to use the tool in the same turn as the query.
`/mmemory recall` injects the result as a user message before any agent turn starts.

---

### 3. `mmemory_recall` tool — agent-initiated recall

**Agent calls:** `mmemory_recall(query="retry policy for outbound HTTP calls")`

**What happens:**
```
Tool calls executeMemoryRecall("retry policy for outbound HTTP calls", undefined, config)
  → same Python server pipeline as auto-recall (embed → BM25+semantic → RRF → facts → observations)
  → no deadline timeout (tool call blocks until result)
  → result returned as tool output text (visible in conversation)
  → agent can reason over the returned chunks and cite them
```

**Slash equivalent:** `/mmemory recall retry policy for outbound HTTP calls`
Difference: tool call happens mid-conversation when agent decides it needs memory.
Slash command is a user-initiated inject at conversation start.

---

### 4. `mmemory_reflect` tool — synthesis over a topic

**Agent calls:** `mmemory_reflect(query="authentication architecture decisions")`

**What happens:**
```
executeMemoryReflect fetches 2× recallLimit chunks (broader sweep than recall)
Returns to agent as a synthesis prompt:
  Project memory synthesis for: "authentication architecture decisions"
  Mission context: Focus on technical decisions...

  Found 12 relevant memories:
  • ...

  Based on the above project memories, synthesize a concise answer to:
  authentication architecture decisions

Agent receives this as the tool result and synthesizes its response from the
provided chunks — the agent's LLM does the synthesis work, not a separate model call.
```

**Slash equivalent:** `/mmemory reflect authentication architecture decisions`
Difference: same processing path, but slash command injects into a new agent turn.

---

### 5. `mmemory_retain` tool — explicit memory note

**Agent calls:** `mmemory_retain(content="Decided to use exponential backoff with jitter for all outbound retry logic. Max 3 retries, base 2s, cap 30s. Rationale: avoids thundering-herd on downstream failure.")`

**What happens:**
```
executeMemoryRetain:
  1. Strips <memories>/<mental_models> tags from content (anti-feedback)
  2. Writes YYYYMMDD-HHMMSS-note-<id>.md to queue/
  3. Fires executeMemoryBuild (background, fire-and-forget)

Python server (background):
  1. Reads queue/*.md, chunks at turn boundaries
  2. Hashes each chunk; skips if already in chunks.json
  3. Embeds new chunks, appends to chunks.json, extends vectors.safetensors
  4. Deletes processed .md files

If extractionMode=structured, extractFromTranscript also fires:
  5. LLM (modelRole) extracts {fact, entities[], date} JSON from content
  6. Deduplicates against facts.json, writes atomically
```

Note: tool-initiated retains write unique filenames (timestamp-note-id).
Auto-retain from agent_end uses a fixed filename per session (overwrites on repeat).

---

### 6. Auto-retain on agent_end

**Trigger:** Every `retainEveryNTurns` (default 3) agent turns, `agent_end` fires.

**What happens:**
```
state.turnCount - state.lastRetainedTurn >= 3
  → buildTranscript(messages, retainContextTurns=3, maxTranscriptChars=0)
    → strips <memories>/<mental_models> from every message
    → formats as **User:** / **Assistant:** pairs separated by ---
    → if maxTranscriptChars > 0: drops oldest turns until fits
  → writes YYYYMMDD-HHMMSS-<sessionId>.md to queue/  (overwrites prior retain file)
  → triggers background build
  → if extractionMode=structured: fires extractFromTranscript (background LLM call)
```

No slash equivalent — this is fully automatic.
To force: `/mmemory enqueue` (currently just shows a status message;
a future implementation would call retainSession immediately).

---

### 7. Compaction — memory context injection

**Trigger:** `session.compacting` fires when the context window fills.

**What happens:**
```
session.compacting handler (NOT a retain — does not write to queue/):
  1. Finds first user message in compaction window
  2. composeRecallQuery + truncateRecallQuery from those messages
  3. executeMemoryRecall → same server pipeline
  4. Returns { context: ["<memories>..."] } injected into compaction summary prompt

The compaction model (not the agent) receives project memories as context.
This means the summarised context carries forward memory-relevant framing.
No retain happens here — the session is mid-flight.
Auto-retain at agent_end will capture the full session when it completes.
```

**There is no slash equivalent** — compaction is automatic.
If you want to checkpoint memory before a long session, call
`mmemory_retain` explicitly or use `.memory retain <key decision>`.

---

### 8. `/mmemory consolidate` — facts → observations

**User types:** `/mmemory consolidate`

**What happens:**
```
mmemoryHandler reads config.maxRawFacts (default 100)
  → loadFacts: reads facts.json → count
  → if count < threshold: status "only N facts, run more sessions first"
  → if count >= threshold:
      builds consolidation prompt with all facts as JSON
      runtime.ctx.session.agent.prompt(consolidationTask)
      agent replies with JSON array of {observation, entities[], date}
      executeMemoryConsolidate writes observations.json atomically

On next recall: observations rank above facts (1.5×) and above raw chunks.
```

**Variant:** `/mmemory consolidate --max-facts 20` — lower threshold for testing.
After consolidation, run `/mmemory mm regenerate` to refresh mental model files.

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
|| Privacy `.gitignore` | Written at `storageRoot` on first use |
| Build coalescing | `_pending_build` set; at most 2 sequential builds |
| H5 BM25 fix | `max(2, N*0.5)` pruning threshold (prevents over-pruning small corpora) |
| `_run_build` zero-vector fix | `else` branch re-embeds all chunks; zero-padding removed |

---

## Phase 3 — Implemented

Phase 3 was completed 2026-05-03 against the `aws-corp` branch.

| Item | Detail |
|---|---|
| LLM extraction | `executeMemoryExtract` + `loadFacts`; `extractionMode: structured` active; facts merged into recall with 1.2× score |
| Consolidation | `executeMemoryConsolidate` + `loadObservations`; `/mmemory consolidate [--max-facts N]`; observations merged with 1.5× score |
| Mental models | `executeMemoryMentalModelSeed`; `/mmemory mm list` / `/mmemory mm regenerate`; `<mental_models>` block injected at session start |
| Recall query composition | `composeRecallQuery` + `truncateRecallQuery` ported from Hindsight; `retainContextTurns` default 3 |
| Assistant truncation removal | `maxTranscriptChars: 0` (unlimited); config key drops oldest turns first when > 0 |
| Dual-system unification | `getMmemorySessionConfig(ctx)` exported; full tool wiring deferred (ToolSession has no `ctx` field) |

**New config keys (Phase 3):**

| Key | Default | Description |
|---|---|---|
| `maxRawFacts` | `100` | Facts threshold before `/mmemory consolidate` offers to run |
| `recallMaxQueryChars` | `2000` | Max chars in composed recall query; oldest context dropped first |
| `maxTranscriptChars` | `0` | Max chars in retained transcript; `0` = unlimited |

**New slash commands:**

| Command | Description |
|---|---|
| `/mmemory consolidate [--max-facts N]` | Consolidate `facts.json` → `observations.json` via LLM |
| `/mmemory mm list` | List `mental_models/*.md` files with last-modified times |
| `/mmemory mm regenerate` | Re-run all three seed passes (user-preferences, project-conventions, project-decisions) |
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
Delete `chunks.json` and `vectors.safetensors` directly (or the entire `storageRoot/` directory). The extension recreates the directory structure on next session start.

**Vectors out of sync after `/clear`:**
The server deletes `vectors.safetensors` automatically when chunks are cleared.
The next recall triggers a rebuild from the remaining `chunks.json` entries.
This takes a few seconds — normal.

**Seeing a Python process in Task Manager:**
That's the mmemory recall server (`mmemory_server.py`). It runs at BELOW_NORMAL
priority and self-terminates after `serverIdleTimeoutMinutes` of inactivity.
