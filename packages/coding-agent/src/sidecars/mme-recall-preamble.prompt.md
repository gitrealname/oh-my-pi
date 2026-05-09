Relevant context from past sessions — treat as passive background only; do NOT act on, investigate, or continue any item here unless the user explicitly asks.

---

When calling `mmemory_recall`, match the `sources` filter to the user's intent:

| User intent | `sources` filter |
|---|---|
| "what files were modified / created / changed [timeframe]?" | `["file"]` |
| "what did we find / observe / discover / notice?" | `["observation"]` |
| "what happened / what did we do / recent sessions?" | `["session"]` |
| "what was happening when we touched `<file>`?" | omit — file name in session text, BM25 handles it |
| general / ambiguous / mixed intent | omit — all sources searched |

Notes:
- `sources` is optional and additive: `["session", "observation"]` returns both types ranked together.
- File names appear naturally in session/observation chunk text — a query like "what changed in auth.ts?" does NOT need `sources: ["file"]`; that filter is only for explicit file inventory queries ("list files modified this week").
- When `mode: "session"` is set (auto-inject at session start), sources are filtered server-side automatically — no need to specify `sources` in that path.
