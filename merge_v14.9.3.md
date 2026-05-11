# Merge Analysis: upstream v14.9.3 → aws-corp

Target branch: `merge/v14.9.3`
Upstream: `origin/main` @ `453fc4ede` (v14.9.3-10-g453fc4ede)
Base: `aws-corp` @ `300de6aee`
New commits: **68**
Date: 2026-05-11

---

## New "tools" — clarification

**No new user-facing tools were added.** The apparent tool additions are:

| Item | What it actually is |
|---|---|
| `listWorkspace` | New **native Rust binding** (`pi-natives`) replacing `glob`-based workspace tree traversal. Internal to `workspace-tree.ts` — not a tool the LLM calls. |
| `json-tree.ts` | **Rendering utility** for tool output display (JSON tree in TUI). Not a tool. |
| `docs/tools/*.md` | New **documentation files** for existing tools. No new tool registrations. |
| `pi-ast` crate | Rust AST analysis library — likely backing future ast-grep improvements. Not yet surfaced as a tool. |
| `pi-shell` crate | Rust shell/process management — likely used by bash tool internals. Not a user-facing tool. |

### Tree tool / mtree question

`workspace-tree.ts` was **significantly refactored** (`060782d76`):
- Old: JS traversal using `glob()` native call
- New: `listWorkspace()` native call (Rust, 5s timeout, returns `GlobMatch[]` with `agentsMdFiles`)
- `WorkspaceTree` now includes `agentsMdFiles: string[]` field
- `buildDirectoryTree` options interface renamed (`directoryEntryLimit` → `perDirLimit`, etc.)

**If aws-corp has an `mtree` extension wrapping `buildWorkspaceTree` or `buildDirectoryTree`:**
The options interface rename is a breaking change — `directoryEntryLimit`, `rootEntryLimit`, `lineCapProtectedDepth`, `excludedNames`, `excludedDirectoryNames` were all removed or renamed. Check if mtree passes any of these options.

---

## Conflict surface (files changed in both branches)

### High — real conflicts expected

| File | Upstream change | aws-corp change | Notes |
|---|---|---|---|
| `src/system-prompt.ts` | Removed `listAgentsMdFiles()`, added `nowPromptTemplate`, `AGENTS_MD_LIMIT` import, `shortenPath` normalization | `m-prompt-template` integration (`getSystemPrompt()` return type changed to `string[]`) | Manual merge required — different sections touched but same file |
| `src/prompts/system/system-prompt.md` | Full rewrite: bracket tags `[role]`, `[env]`, `[coop]`, `[now]`, removed `<\|START_*\|>` markers | No aws-corp changes | Take upstream wholesale |
| `src/prompts/system/subagent-system-prompt.md` | Bracket tag migration + new structure | No aws-corp changes | Take upstream wholesale |
| `src/task/index.ts` | `renderSubagentUserPrompt` refactor, `task/template.ts` deleted | Our abort/signal changes | Significant overlap — careful merge |
| `src/task/executor.ts` | `listWorkspace` plumbing removed from executor; `AGENTS.md` scanning moved to workspace-tree | Our SIGKILL escalation fix | Small conflict — different lines |
| `src/tools/index.ts` | `ToolSession` fields removed (`agentsMdSearch`) | Our `trackTaskExecution` additions | Additive on our side — low conflict |
| `src/sdk.ts` | New `listWorkspace` export wiring, `AgentsMdSearch` removed | Extension gates + `setMPromptTemplateRoleResolver` | Different sections — likely clean |
| `src/workspace-tree.ts` | Full rewrite — native `listWorkspace`, new options interface | No aws-corp changes | Take upstream wholesale |

### Medium — likely auto-merge with spot-check

| File | Notes |
|---|---|
| `packages/agent/src/agent-loop.ts` | `harmony-leak` fix added; our abort changes are in coding-agent not agent-loop |
| `src/config/settings-schema.ts` | Upstream may have new settings; aws-corp added extension toggles |
| `src/extensibility/extensions/m-prune-extension.ts` | Our orphaned-tool-use guard; upstream may have prune changes — check |
| `packages/ai/src/providers/*.ts` | Auth fallback + vision guard additions — no aws-corp overlap |
| `src/tools/bash.ts` | `bash-normalize` removed upstream; aws-corp didn't touch bash.ts |

### Low — take upstream, no conflict

| Files | Notes |
|---|---|
| `crates/pi-ast/`, `crates/pi-shell/` | New Rust crates — pure addition |
| `crates/pi-natives/src/workspace.rs` | New native — pure addition |
| `packages/stats/` | Stats additions — no aws-corp overlap |
| `packages/agent/src/harmony-leak.ts` | New file — pure addition |
| `packages/ai/src/utils/sse-debug.ts` | New file — pure addition |
| `docs/tools/*.md` | New docs — pure addition |
| All `test/issue-*.test.ts` | New regression tests — pure addition |
| `src/tools/bash-normalize.ts` | **Deleted** upstream; aws-corp never modified it — take deletion |

---

## Key upstream improvements worth having

1. **`listWorkspace` native binding** — Rust-speed workspace tree, 5s timeout, AGENTS.md discovery baked in. Replaces slow JS glob traversal.
2. **Bracket tag system prompt** — `[role]`, `[env]`, `[now]` blocks replace `<|START_*|>` markers. More robust parsing. **Important: `m-prompt-template`'s memory regex replacement targets `<memories>` / `<observations>` etc. — verify it doesn't conflict with the new `[TAG]` syntax.**
3. **Harmony leak fix** (`agent/src/harmony-leak.ts`) — GPT-5 produces malformed JSON structures that were leaking state. Important stability fix.
4. **Vision guard** (`ai/src/providers/vision-guard.ts`) — strips unsupported vision content before sending to non-vision models.
5. **Raw SSE diagnostics** — debug tooling for streaming issues.
6. **Subagent auth fallback** — subagent inherits parent model on auth failure (critical for aws-corp/Bedrock).
7. **Compaction auth fallback** — mprune falls back gracefully when auth fails.
8. **IRC teardown guard** — background poll loop stops on session dispose (was leaking).

---

## m-prompt-template specific risk

`3a79e890a` changes system prompt template markers from `<|START_ROLE|>...<|END_ROLE|>` to `[role]...[/role]`. The `m-prompt-template` `activate.ts` does regex replacement on system prompt content to handle `memory: false`. 

**Check**: does `activate.ts` or `index.ts` match on the old `<|START_*|>` syntax? If so the `memory: false` replacement will silently stop working after merge.

---

## Merge complexity estimate

| Cluster | Files | Effort | Risk |
|---|---|---|---|
| System prompt bracket migration | 3 markdown + system-prompt.ts | 30 min | Low — mostly take upstream |
| task/index.ts overlap | 1 file, 2 independent changes | 45 min | Medium — careful diff |
| workspace-tree / listWorkspace | workspace-tree.ts + executor.ts | 20 min | Low — take upstream, patch our fix back |
| m-prompt-template compatibility check | activate.ts + index.ts | 30 min | Medium — regex audit |
| Additive new files | ~20 new files | 5 min | None — `git checkout origin/main -- <file>` |

**Total: ~2–2.5 hours of focused merge work.** Not a big deal. The highest-risk item is the system-prompt bracket tag interaction with `m-prompt-template`'s regex replacement.

---

## Recommended approach

```
git checkout -b merge/v14.9.3 aws-corp
git merge origin/main
# resolve conflicts cluster by cluster (order above)
# after resolving: audit activate.ts regex vs new [TAG] syntax
# build + run integration tests
# push
```
