# mprune — Dynamic Context Pruning for omp

mprune is a session-level context management extension for the omp aws-corp branch.
It keeps long coding sessions lean by intercepting tool results at write time, batching
and summarizing completed reasoning steps with a cheap LLM, and replacing stale image
bytes with lightweight placeholders — without touching entries that are still in the
active Bedrock/Anthropic prefix cache.

**All processing is local.** No data leaves your session except the summarization
request to the `modelRoles.prune` model (same model that powers your normal session).

---

## The problem

Long sessions accumulate megabytes of tool output. Without pruning, every agent turn
re-sends the full context: thousands of lines of `grep` results, full file reads,
bash output — most of it irrelevant to the current task. This drives up latency and
cost quadratically as sessions grow.

OMP already has `pruneToolOutputs` (coarse truncation to `[Output truncated - N tokens]`).
mprune adds three targeted mechanisms on top of it:

| Mechanism | When it fires | Cache safe? |
|---|---|---|
| Insertion-time trim | On every `tool_result`, before the entry is stored | Always — never modifies existing entries |
| Batch summarization | On `turn_end` with no tool calls (agent finished a task step) | Yes — prunes once per exchange, not per tool call |
| Image aging | On every `turn_end` | Yes — images are past the cache breakpoint by then |

---

## Quick start

```yaml
# config.yml
mprune:
  enabled: true

modelRoles:
  prune: aws-corp/us.anthropic.claude-haiku-3-5
```

That is the minimal config. All other keys have defaults (see below).

---

## Full configuration reference

```yaml
mprune:
  enabled: false          # master toggle; false = all handlers are no-ops (default)
  showStatusLine: true    # reserved — not yet wired to the status bar

  images:
    keepTurns: 5          # replace image bytes with placeholder after N user turns
                          # 0 = never prune images

  trim:
    softTrimChars: 12000  # trim tool results larger than this at write time
                          # ~3k tokens; 0 = disabled
                          # split: 40% head / 60% tail (hardcoded, tail-heavy
                          # for bash/build output where exit codes appear last)

modelRoles:
  # Summarizer model for mprune.
  #
  # Requirements:
  #   - cheapest model on your subscription (this is a background utility call)
  #   - >= 32k context window (tool-call batches can be large)
  #   - multilingual if your work involves non-English content (Russian, Chinese, etc.)
  #
  # All Claude models satisfy all three requirements.
  # Haiku-class is the right default: fast, cheap, fully capable for bullet-point summarization.
  # Do NOT use a reasoning/thinking model here — the cost difference is large and unwarranted.
  prune: aws-corp/us.anthropic.claude-haiku-3-5
```

### Key defaults

| Setting | Default | Notes |
|---|---|---|
| `mprune.enabled` | `false` | Must be set to `true` to activate |
| `mprune.images.keepTurns` | `5` | 0 = image pruning disabled |
| `mprune.trim.softTrimChars` | `12000` | ~3k tokens; 0 = trim disabled |
| `modelRoles.prune` | _(falls back to default model)_ | Set explicitly to a cheap Haiku-class model |

---

## How each mechanism works

### 1. Insertion-time trim

Fires on the `tool_result` event, before the entry is written to the session JSONL.

When a tool result's text content exceeds `trim.softTrimChars`, the middle is replaced
with a notice:

```
<first 40% of softTrimChars>

[... 8432 chars trimmed — re-run for full output ...]

<last 60% of softTrimChars>
```

The 40/60 head/tail split is hardcoded. Head preserves setup/context/early lines; tail
preserves the most recent output (exit codes, final state, error messages — which tend
to appear last in bash and build output).

Because this fires before the entry is persisted, it never touches any existing session
entry. Cache-safe by construction.

**Inspired by:** OpenHands (middle-truncation at 30k chars) and the approach documented
in [Hermes Agent #415](https://github.com/NousResearch/hermes-agent/issues/415) (12k
soft trim with head+tail split). The 40/60 ratio came from the Hermes analysis of where
useful content concentrates in bash/build output.

---

### 2. Batch summarization

**Trigger:** `turn_end` where `toolResults.length === 0` — the agent sent a text-only
reply. This means it just finished a complete task step (no more tool calls in flight).

**Accumulation:** every `turn_end` that does include tool results adds a `PruneBatch` to
an in-memory `pendingBatches[]` list. When the text-only trigger fires, all pending
batches are serialized and sent to `modelRoles.prune` in a single LLM call.

**Routing:** the summary is injected as a steer message. Each summarized tool result
entry is marked `prunedAt` in the session. OMP's built-in `pruneToolOutputs` pass checks
`prunedAt !== undefined` and skips already-pruned entries — no double-prune.

**Failure is non-fatal.** If the LLM call fails, a warning is logged and the session
continues with unpruned entries. The next `agent-message` flush will try again.

**Subagent guard:** when `taskDepth > 0` (inside a spawned sub-task), all handlers are
skipped. Subagents have their own session lifecycle.

**Why `agent-message` and not `every-turn`:**

Bedrock/Anthropic prefix caching caches an identical conversation prefix at 0.1× the
normal input rate. Any modification earlier in the context than the last cache
breakpoint invalidates everything from that point onward and causes a full re-bill.

If mprune fired on every tool call, it would bust the cache 20 times on a 20-tool-call
run — paying full input rate on the entire preceding conversation 20 times instead of
once. The $1-to-lose-$100 scenario: saving 10k tokens by pruning, but losing the cache
hit on a 200k-token prefix.

With `agent-message` trigger: one cache bust per complete user↔agent exchange. During
the entire work batch, context is append-only. Cache hits fire reliably. After the prune,
the stable prefix is shorter — future cache hit rates improve.

A real-world consequence of getting this wrong: a ~$38k AWS Bedrock bill from a
coding agent that silently lost cache hits.
([HN: $38k AWS Bedrock bill caused by a simple prompt caching miss](https://news.ycombinator.com/item?id=47933355))

ProjectDiscovery's Neo platform independently reached the same conclusion (84% cache hit
rate, 59% cost reduction): *"the agentic tax compounds quadratically — caching is the
only structural fix."*
([How We Cut LLM Costs by 59% With Prompt Caching](https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching))

**Inspired by:** [pi-context-prune v0.9.0](https://github.com/getpi/context-prune) — the
batch-capture approach, `agent-message` trigger semantics, and summarize-and-discard
strategy (no side index, no retrieval tool) are directly adapted from pi-context-prune's
design. Key differences: mprune drops `context_tree_query`, `agentic-auto` mode, and the
TUI tree browser; adds OMP's `prunedAt` coordination guard; and integrates with OMP's
own `pruneToolOutputs` pipeline ordering.

---

### 3. Image aging

Fires on every `turn_end` when `images.keepTurns > 0`.

`findAgedImages` walks the session entries and identifies user messages containing image
blocks where the image was attached more than `keepTurns` user turns ago. Each aged image
block is replaced with a text placeholder:

```
[Image pruned: image/png, attached turn 12. Re-paste if needed.]
```

Session entries are rewritten atomically (write to `.tmp` → `fsync` → rename). By the
time image aging fires, those entries are already past the active prefix cache breakpoint
(the cache has moved forward with each subsequent turn). Rewriting them does not bust
any active cache.

Images are the heaviest per-item in context — each inline image is approximately
1200 tokens. Five turns of retention (default) keeps images through the immediate
follow-up turns where they're likely still in scope, then drops them.

---

## `/mprune` command

Manual on-demand flush. Available in interactive mode.

| Subcommand | Behavior |
|---|---|
| `/mprune` or `/mprune flush` | Walk session for unpruned tool results → summarize with `modelRoles.prune` → inject steer message → mark `prunedAt` → rewrite session |
| `/mprune stats` | Show per-session and lifetime token savings in a bordered panel |
| `/mprune status` | Single-line status: `enabled`, `images.keepTurns`, `trim.softTrimChars`, pruned entry count |

`flush` is the default when no subcommand is given.

### `/mprune stats` output

```
mprune token savings

This session:   2.5K tokens saved
  trim:         500 (12 events)
  summarized:   1.8K (3 flushes)
  images:       1.2K (1 pruned)

All time:       47K tokens saved
  trim:         8K (203 events)
  summarized:   34K (61 flushes)
  images:       4.8K (4 pruned)
  last updated: 2026-05-05
```

**Per-session** stats are tracked in memory and reset on session start.
**Lifetime** stats are persisted to `getAgentDir()/mprune-stats.json` after each batch
flush, image prune, and on `session_shutdown`. The file is created on first save.

---

## Interaction with OMP's built-in pruning

OMP already runs `pruneToolOutputs` (in `session/compaction/pruning.ts`) before each
auto-compaction check. It truncates old tool results to `[Output truncated - N tokens]`.

mprune coordinates with it via the `prunedAt` field:

1. mprune fires at `turn_end` (before OMP's threshold check)
2. mprune sets `entry.message.prunedAt = Date.now()` on each summarized tool result
3. OMP's `pruneToolOutputs` checks `message.prunedAt !== undefined` and skips those entries
4. If the session is still above the compaction threshold, OMP compacts the already-summarized content — cheaper than compacting raw output

No configuration needed. The ordering is handled by the event pipeline.

---

## Troubleshooting

**`/mprune stats` shows 0 all time:**
Stats are persisted after each flush. If no flush has run yet (mprune just enabled, or
`enabled: false` until now), the file does not exist yet — that is normal.

**Summarization not firing:**
Check that `mprune.enabled: true` and `modelRoles.prune` is set to a model with an API
key. Run `/mprune status` to confirm config. If the model role is unset, mprune falls
back to the session's default model (higher cost, higher latency than intended).

**Stats file location:**
`~/.omp/agent/mprune-stats.json` (or wherever `getAgentDir()` resolves on your system).

**Images not being pruned:**
Confirm `images.keepTurns > 0` (0 disables image pruning). Image aging fires on every
`turn_end`, so it will catch aged images on the next agent response after the threshold.

**Large tool result not trimmed:**
Confirm `trim.softTrimChars > 0` (0 disables trim). The trim fires on `tool_result`
before the entry is stored — if you are seeing untrimmed entries in an existing session,
those were stored before mprune was enabled. Future tool results in that session will
be trimmed.

---

## Implementation files

| File | Description |
|---|---|
| `src/extensibility/extensions/m-prune-extension.ts` | Extension factory `createMpruneExtension(api)`; registers `tool_result`, `turn_end` (×3), `session_shutdown` handlers; per-session WeakMap state; `getMpruneSessionStats()` export |
| `src/session/compaction/mprune-batch.ts` | `PruneBatch`, `ToolResultEntry`; `captureBatch(event)` builds batches from `TurnEndEvent`; `serializeBatchForSummarizer(batch)` formats for LLM |
| `src/session/compaction/mprune-trim.ts` | `softTrim(text, maxChars)` and `trimToolResult(content, maxChars)`; 40/60 head/tail split with middle notice |
| `src/session/compaction/mprune-images.ts` | `findAgedImages(entries, currentTurnIndex, keepTurns)`, `hasImageBlock(content)`, `makePlaceholder(mimeType, turnIndex?)`; `ImageEntry` type |
| `src/session/compaction/mprune-prompt.ts` | `buildSummarizerPrompt()` — system prompt for the prune LLM call; instructs model to distinguish read-only tools (terse + re-run hint) from mutation tools (verbose, no re-run) |
| `src/session/compaction/mprune-stats-pure.ts` | Pure stats functions — `formatTokens`, `charsToTokens`, `estimateTrimSavings`, `estimateBatchSavings`, `accumulateStats`, `buildStatsLines`; no native deps, bun:test safe |
| `src/session/compaction/mprune-stats.ts` | File I/O layer — `loadPersistentStats`, `savePersistentStats` (atomic); re-exports everything from `mprune-stats-pure.ts` |
| `src/config/settings-schema-m-prune.ts` | `PRUNE_SCHEMA_ENTRIES`; spread into `settings-schema.ts` to register all `mprune.*` config keys |
| `src/slash-commands/builtin-registry.ts` | `mpruneHandler` + `/mprune [flush\|stats\|status]` entry in `BUILTIN_SLASH_COMMAND_REGISTRY` |
| `src/sdk.ts` | `inlineExtensions.push(createMpruneExtension)` — one line, after `createMmemoryExtension` |
| `test/mprune-batch.test.ts` | 18 tests — batch capture, tool name dispatch, prunedAt propagation, multi-block content |
| `test/mprune-trim.test.ts` | 13 tests — passthrough, head/tail math, notice content, image block passthrough |
| `test/mprune-images.test.ts` | 16 tests — hasImageBlock, findAgedImages boundaries, makePlaceholder |
| `test/mprune-prompt.test.ts` | 7 tests — prompt content invariants |
| `test/mprune-stats.test.ts` | 32 tests — formatTokens thresholds, estimation functions, accumulation, buildStatsLines display |
| `test/script-output-protocol.test.ts` | 19 tests — `@omp:` protocol parser (shared with script executor) |

**Total: 105 tests, 0 failures.**

---

## Acknowledgements and prior art

mprune did not emerge from first principles. The following projects and incidents
directly shaped the design — each is cited where its influence appears in the code.

### pi-context-prune (v0.9.0)

The core architecture — batch capture on `turn_end`, `agent-message` trigger semantics,
summarize-and-discard (no side index, no retrieval tool), and the idea of keeping raw
entries in the session as an audit trail while filtering them from LLM context at
request time — is adapted from
[pi-context-prune](https://github.com/getpi/context-prune) by the Pi team.

mprune drops features that add complexity without value for OMP's use case
(`context_tree_query` tool, `agentic-auto` mode, `every-turn` mode, TUI tree browser,
stats accumulator) and adds OMP-specific integration (`prunedAt` coordination with
`pruneToolOutputs`, subagent guard, `session_shutdown` stats flush).

**Image aging is a significant addition that pi-context-prune does not have.** Images
live in user messages, not tool results — pi-context-prune's batch-capture architecture
never touches them. mprune treats images as a separate pruning target because they are
the heaviest per-item in context (each inline image is ~1200 tokens, vs a few hundred
for a typical tool result) and they are uniquely safe to rewrite.

The key architectural difference from tool result pruning:

- **Tool results** use append-only summarization (summary appended as new JSONL entry;
  raw entry filtered at context-build time). Session rewrite is avoided because tool
  results fire frequently and may still be within the active cache prefix.
- **Images** use direct session rewrite (image bytes replaced with a text placeholder
  in-place). This is safe because by the time `images.keepTurns` turns have elapsed,
  those entries are already behind the active cache breakpoint — the cache has moved
  forward. Rewriting them does not bust any active cache hit, and the savings are large
  enough (50k–200k+ tokens per image) to justify the rewrite cost.

The distinction matters: apply the image strategy to tool results and you destroy cache
value. Apply the tool result strategy to images and you forgo the largest savings
available in the session.

### Hermes Agent issue #415

The insertion-time soft trim approach (trim at write time, not retroactively) and the
head+tail split pattern come from a detailed analysis in
[Hermes Agent #415](https://github.com/NousResearch/hermes-agent/issues/415):
*"retroactive mutation of old messages destroys Anthropic/OpenAI prefix cache hit rates.
The cache-friendly alternative: trim at insertion time, not retroactively."*

The 40/60 head/tail ratio is the Hermes recommendation for bash/build output
(tail-heavy, because exit codes and final state appear last).

### OpenHands

Middle-truncation at insertion time (rather than at summarization time) as a complement
to batch summarization is the approach used by OpenHands (30k char threshold with
middle-truncation). The combination of insertion-time trim + periodic summarization is
more robust than either alone: trim handles single outlier results immediately; the
summarizer handles accumulated context over time.

### ProjectDiscovery Neo

The quantified case for `agent-message` timing over `every-turn`:
*"the agentic tax compounds quadratically — caching is the only structural fix."*
84% cache hit rate, 59% cost reduction from prefix cache alone.

[How We Cut LLM Costs by 59% With Prompt Caching — ProjectDiscovery](https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching)

### The $38k Bedrock incident (HN)

The concrete cost consequence of getting `turn_end` trigger timing wrong:
a silent cache miss from retroactive context mutation in a coding agent caused a
~$38k AWS Bedrock bill in a normal (non-runaway) session.

[HN: $38k AWS Bedrock bill caused by a simple prompt caching miss](https://news.ycombinator.com/item?id=47933355)

This is the primary motivation for the `agent-message` trigger design.
