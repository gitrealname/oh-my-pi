Explicitly retain an important insight, decision, or fact into long-term memory.

Auto-retain runs automatically every N turns and on session end — you do NOT need to call this for routine operation. Call `mmemory_retain` only when something is **explicitly worth preserving** beyond the normal session record.

## When to call
| Trigger | Action |
|---|---|
| User types `.retain <content>` | Call with `content=<content>` |
| User says "remember this", "save this", "note this" | Call with `content=<what to remember>` |
| A key architectural decision, constraint, or API contract is established | Call with `content=<decision summary>` |
| A hard-won fix or known error pattern is identified | Call with `content=<finding>` |

## Parameters
- `content` (required): what to retain — be specific and self-contained
  - Good: `"Auth uses JWT with 15-min expiry; refresh token in httpOnly cookie"`
  - Bad: `"the thing we discussed"` (no context)

## What happens
- The session transcript is written to the memory queue immediately (bypasses the N-turn auto-retain cadence)
- `content` is appended as a `**Note:**` section within that session record
- The note enriches the session context — it does NOT replace it
- The periodic auto-retain timer resets from this point

## What NOT to retain
- Transient state (current file line numbers, temporary variable names)
- Information already visible in the current session (it will be retained automatically)
- Tool output verbatim — summarize the finding instead
