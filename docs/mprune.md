# mprune — Dynamic Context Pruning

mprune is a session-level context management extension for omp. It intercepts tool
results at write time, batches and summarizes completed reasoning steps with a cheap
LLM, and replaces stale image bytes with lightweight placeholders — all without
touching entries that are still in the active prefix cache.

The problem it solves: long coding sessions accumulate megabytes of tool output.
Without pruning, every agent turn re-sends the full context, driving up latency and
cost. OMP's built-in `pruneToolOutputs` pass is coarse; mprune adds three targeted
mechanisms that preserve cache value while aggressively shrinking context size.

---

## Enabling mprune

In your `config.yml`:

```yaml
mprune:
  enabled: true
```

All other keys have defaults and are optional. `enabled: false` is the default — the
extension is loaded but every handler is a no-op until explicitly enabled.

---

## Configuration Reference

```yaml
mprune:
  enabled: false          # master toggle; false = all handlers are no-ops

  showStatusLine: true    # reserved; not yet wired to the status bar

  images:
    keepTurns: 5          # replace image bytes with a placeholder after N user turns
                          # 0 = never prune images

  trim:
    softTrimChars: 12000  # trim tool results larger than this at write time
                          # ~3k tokens; 0 = disabled
                          # split: 40% head / 60% tail (hardcoded)

modelRoles:
  prune: aws-corp/us.anthropic.claude-haiku-3-5
  # Cheapest available model; needs >= 32k context and multilingual support.
  # Any Claude model works. See: Summarizer model requirements.
```

---

## How It Works

### Insertion-time trim

Fires on the `tool_result` event, before the entry is written to the session store.

When a tool result's text content exceeds `trim.softTrimChars`, the middle is
replaced with a notice and the entry is stored in trimmed form:

```
<first 40% of content>
[... 8432 chars trimmed — re-run for full output ...]
<last 60% of content>
```

The 40/60 head/tail split is hardcoded. The head preserves the beginning of the
output (tool invocation, headers, early lines); the tail preserves the most recent
output (error messages, final state).

Because this fires before the entry enters the session, it never modifies an existing
entry — it is safe with Bedrock prefix caching.

### Batch summarization

Trigger: `turn_end` where `toolResults.length === 0` — the agent sent a text-only
reply, meaning it just finished a complete task step.

Accumulation: every `turn_end` that does include tool results adds a `PruneBatch` to
an in-memory `pendingBatches[]` list. When the text-only turn fires, all pending
batches are serialized and sent to `modelRoles.prune` in a single LLM call.

The summary is injected as a steer message. Each summarized entry is marked
`prunedAt` on the session record. OMP's built-in `pruneToolOutputs` pass checks for
`prunedAt` and skips entries that are already pruned — no double-prune.

Failure is non-fatal: if the LLM call fails, a warning is logged and the session
continues with unpruned entries.

Subagent guard: when `taskDepth > 0` (inside a spawned sub-task), all handlers are
skipped. Subagents have their own session lifecycle; pruning the parent from a child
would corrupt shared state.

### Image aging

Fires on every `turn_end` when `images.keepTurns > 0`.

`findAgedImages` walks the session entries and identifies image blocks whose
attachment turn is more than `keepTurns` user turns ago. Each aged image is replaced
with a text placeholder:

```
[Image pruned: image/png, attached turn 12. Re-paste if needed.]
```

Session entries are rewritten atomically via `sessionManager.rewriteEntries()`. By
the time image aging fires, those entries are past the active prefix cache breakpoint,
so rewriting them does not bust the cache.

---

## `/mprune` Command

Manual on-demand flush. Available in any session when mprune is enabled.

| Subcommand | Behavior |
|---|---|
| `/mprune` or `/mprune flush` | Walk session for unpruned tool results, summarize with `modelRoles.prune`, inject steer message, mark entries `prunedAt`, rewrite session |
| `/mprune stats` | Show per-session and lifetime token savings in a bordered panel (same style as `/context`) |
| `/mprune status` | Show `enabled`, `images.keepTurns`, `trim.softTrimChars`, count of pruned entries |

`flush` is the default when no subcommand is given.

---

## Why Not Every-Turn Pruning

Bedrock prefix caching works by hashing a prefix of the conversation up to a cache
breakpoint. Any modification to a cached prefix — including appending or removing
entries — invalidates the cache and causes a full re-ingestion at input token rates.

A widely-cited incident resulted in a ~$38k Bedrock bill from a tool that pruned on
every tool call. Each prune modified the prefix, busted the cache, and caused the
full context to be re-billed as input tokens on every single turn.
([HN: $38k AWS Bedrock bill caused by a simple prompt caching miss](https://news.ycombinator.com/item?id=47933355))

mprune uses the `agent-message` trigger: summarization fires once per complete
user-to-agent exchange (text-only `turn_end`), not on every tool call. This busts
the cache at most once per exchange — the same rate as a normal conversation turn.
Insertion-time trim never touches existing entries at all.

---

## Summarizer Model Requirements

Set `modelRoles.prune` to the cheapest model available in your deployment that meets:

- Context window >= 32k tokens (tool results can be large)
- Multilingual support if your codebase uses non-ASCII content (Russian, Chinese, etc.)

All Claude models satisfy both requirements. Claude Haiku is the recommended default
for cost. Do not use a large reasoning model for this role — the summarization task
does not warrant it and the cost difference is significant at scale.

---

## Implementation Files

| File | Description |
|---|---|
| `src/extensibility/extensions/m-prune-extension.ts` | Extension factory `createMpruneExtension(api)`; registers all event handlers; entry point loaded by sdk.ts |
| `src/session/compaction/mprune-batch.ts` | `PruneBatch`, `ToolResultEntry`; `captureBatch(event)` builds batches from turn events; `serializeBatchForSummarizer(batch)` formats them for the LLM |
| `src/session/compaction/mprune-trim.ts` | `softTrim(text, maxChars)` and `trimToolResult(content, maxChars)`; implements the 40/60 head/tail split with middle notice |
| `src/session/compaction/mprune-images.ts` | `findAgedImages(entries, currentTurnIndex, keepTurns)`, `hasImageBlock(content)`, `makePlaceholder(mimeType, turnIndex?)`; `ImageEntry` type |
| `src/session/compaction/mprune-prompt.ts` | `buildSummarizerPrompt()` — constructs the system prompt for the prune LLM call |
| `src/config/settings-schema-m-prune.ts` | `PRUNE_SCHEMA_ENTRIES`; spread into `settings-schema.ts` to register all mprune config keys |
| `src/modes/controllers/input-controller-m-scripts-protocol.ts` | Script output protocol handler; extracted from the input controller for testability |
| `src/slash-commands/builtin-registry.ts` | `mpruneHandler` registered here; adds the `/mprune [flush\|status\|stats]` command |
| `src/session/compaction/mprune-stats-pure.ts` | Pure stats functions: `formatTokens`, `charsToTokens`, `estimateTrimSavings`, `estimateBatchSavings`, `accumulateStats`, `buildStatsLines`; no native deps, bun:test safe |
| `src/session/compaction/mprune-stats.ts` | File I/O: `loadPersistentStats`, `savePersistentStats` (atomic tmp→rename); re-exports all pure functions |
| `test/mprune-*.test.ts` | 105 tests covering batch capture, trim behavior, image aging, prompt construction, stats, and script protocol; 0 failures |
