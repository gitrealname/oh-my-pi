# pi-prompt-template-model: Integration Test Plan
# Branch: feature/prompt-template-integration
# Date: 2026-05-09

---

## Key Finding: Slash Commands Work in -p Mode

`session.prompt(text)` with `expandPromptTemplates: true` (the default) processes
extension slash commands FIRST via `#tryExecuteExtensionCommand()` before any LLM call.
This means ALL template features are fully testable headlessly via:

```bash
cd "D:/.ai" && "$LOCALAPPDATA/omp/omp.exe" -p "/template <path>" \
  --no-lsp --no-pty --model "openrouter/xiaomi/mimo-v2-flash" 2>&1
```

No interactive session required. All tests below are automatable.

---

## Test Infrastructure

### Template directory
Place test templates at: `D:/.ai/.pi/prompts/` (extension scans `{cwd}/.pi/prompts/`)

### Log inspection
```python
LOG = 'D:/.ai/.junctions/omp/logs/omp.2026-05-09.log'
before = line_count(LOG)
run_ow("-p", "/template test-basic.md")
delta = read_log_lines(LOG, from=before)
```

### What to look for in logs
- `[extension] prompt-template-model loaded` — discovery worked
- `[mmemory-backend] beforeAgentStartPrompt: sessions=N obs=M files=K snippetLen=L` — mmemory still injecting
- `EXCEPTION:` — any crash in extension or server
- Model switch log line (once we add model_select event)

---

## Test Matrix

### T0 — Extension Discovery
```bash
ow -p "say PING"   # no template invocation
```
**Check:** Log contains extension load message. `snippetLen > 0` (mmemory still injecting).
No `EXCEPTION:` from extension loader. Exit code 0.

---

### T1 — Basic Template (no frontmatter, no model switch)
**Template: `test-basic.md`**
```markdown
---
description: Basic passthrough test
---
Say exactly: TEMPLATE_EXECUTED
```
```bash
ow -p "/template test-basic.md"
```
**Check:** stdout contains `TEMPLATE_EXECUTED`. Exit code 0. No EXCEPTION.

---

### T2 — Model Switching
**Template: `test-model.md`**
```markdown
---
model: openrouter/xiaomi/mimo-v2-flash
description: Model switch test
---
Say exactly: MODEL_SWITCHED
```
```bash
ow -p "/template test-model.md"
```
**Check:** stdout contains `MODEL_SWITCHED`. Exit code 0.
**Also check:** After template completes, the session model is restored to the original.
Verify by sending a second message in the same session (needs a chained test).

---

### T3 — Thinking Level
**Template: `test-thinking.md`**
```markdown
---
thinking: low
description: Thinking level test
---
What is 2 + 2? Say only the number.
```
```bash
ow -p "/template test-thinking.md"
```
**Check:** stdout contains `4`. Exit code 0. No thinking-level API errors.

---

### T4 — Chain (2-step sequential)
**Template: `test-chain.md`**
```markdown
---
description: Sequential chain test
chain:
  - prompt: What is the capital of France? Answer in one word.
  - prompt: Repeat the previous answer in uppercase.
---
```
```bash
ow -p "/template test-chain.md"
```
**Check:** stdout contains `PARIS`. Each step completes in sequence. Exit code 0.

---

### T5 — Loop
**Template: `test-loop.md`**
```markdown
---
description: Loop iteration test
loop: 2
---
Respond with "ITERATION" followed by a number that increments each time you see this.
```
```bash
ow -p "/template test-loop.md"
```
**Check:** stdout contains `ITERATION` twice. Exit code 0. No infinite loop.

---

### T6 — Skill Injection
**Skill file: `D:/.ai/.pi/skills/test-skill.md`**
```markdown
# Test Skill
When answering, always prefix your response with "SKILL_ACTIVE:".
```
**Template: `test-skill.md`**
```markdown
---
skill: test-skill
description: Skill injection test
---
Say hello.
```
```bash
ow -p "/template test-skill.md"
```
**Check:** stdout contains `SKILL_ACTIVE:`. Exit code 0.

---

### T7 — mmemory Coexistence (Critical)
Run a template and verify mmemory injection is NOT clobbered:
```bash
ow -p "/template test-basic.md"
```
**Check log:** `beforeAgentStartPrompt: ... snippetLen=N` where N matches a non-template
session's snippetLen (i.e., mmemory's injection was NOT overwritten by the template extension).

**This is the systemPrompt threading test** — if the fix is applied correctly, snippetLen
on a template-driven turn should be >= snippetLen on a non-template turn (template may ADD
to system prompt via skill injection, it should NEVER reduce it).

---

### T8 — Model Restore After Template
**Two-prompt session:**
```bash
ow -p $'/template test-model.md\n\nWhat model are you? State only the model name.'
```
(Using newline to send a follow-up after the template completes.)

**Check:** The follow-up turn uses the ORIGINAL model (openrouter/xiaomi/mimo-v2-flash),
not the template's model if different. Verify via model name in response.

**Edge case:** If template model == session model, restore is a no-op — pass trivially.
Use a template that switches to a DIFFERENT model to actually test restore.

---

### T9 — Graceful Degrade: Subagent Workers
**Template: `test-workers.md`**
```markdown
---
description: Workers degrade test
workers:
  - prompt: Task 1
  - prompt: Task 2
---
Aggregate results.
```
```bash
ow -p "/template test-workers.md"
```
**Check:** Does NOT crash. Either returns a degraded response (tasks skipped) OR falls back
to sequential execution. Exit code 0. No EXCEPTION. No hang.

---

### T10 — Invalid Model Name (Error Handling)
**Template: `test-invalid-model.md`**
```markdown
---
model: nonexistent/fake-model-xyz
---
Say hello.
```
```bash
ow -p "/template test-invalid-model.md"
```
**Check:** Does NOT crash. Returns a meaningful error message or falls back to default model.
Exit code 0 (graceful error, not crash). No EXCEPTION in mmemory server.

---

### T11 — Template with .recall Integration
**Template: `test-recall.md`**
```markdown
---
description: Template + mmemory recall
---
.recall mmemory architecture
```
```bash
ow -p "/template test-recall.md"
```
**Check:** mmemory_recall tool fires. Response discusses mmemory. No conflict between
template execution and recall tool.

---

### T12 — Deterministic Step
**Template: `test-deterministic.md`**
```markdown
---
description: Deterministic step test
steps:
  - run: echo SHELL_OUTPUT
    type: deterministic
  - prompt: What did the previous step output? Repeat it exactly.
    type: llm
---
```
```bash
ow -p "/template test-deterministic.md"
```
**Check:** stdout contains `SHELL_OUTPUT`. LLM step received the shell output as context.

---

## Automated Test Runner

```python
#!/usr/bin/env python3
"""
Integration test runner for pi-prompt-template-model.
Run from D:/.ai after extension is deployed.
"""
import subprocess, os, time, json

OW = os.path.expandvars('%LOCALAPPDATA%/omp/omp.exe')
FLAGS = ['--no-lsp', '--no-pty', '--model', 'openrouter/xiaomi/mimo-v2-flash']
LOG = 'D:/.ai/.junctions/omp/logs/omp.2026-05-09.log'
TEMPLATE_DIR = 'D:/.ai/.pi/prompts'

TEMPLATES = {
    'test-basic.md': '---\ndescription: Basic test\n---\nSay exactly: TEMPLATE_EXECUTED\n',
    'test-model.md': '---\nmodel: openrouter/xiaomi/mimo-v2-flash\ndescription: Model test\n---\nSay exactly: MODEL_SWITCHED\n',
    'test-thinking.md': '---\nthinking: low\ndescription: Thinking test\n---\nWhat is 2+2? Say only the number.\n',
    'test-invalid.md': '---\nmodel: nonexistent/fake-model\n---\nSay hello.\n',
}

def setup():
    os.makedirs(TEMPLATE_DIR, exist_ok=True)
    for name, content in TEMPLATES.items():
        with open(f'{TEMPLATE_DIR}/{name}', 'w') as f:
            f.write(content)

def run_test(name, prompt, check_fn):
    try:
        before = sum(1 for _ in open(LOG))
    except:
        before = 0
    r = subprocess.run([OW, '-p', prompt] + FLAGS, capture_output=True, text=True, cwd='D:/.ai')
    try:
        with open(LOG) as f:
            delta_lines = f.readlines()[before:]
    except:
        delta_lines = []
    mmemory_lines = [l.strip() for l in delta_lines if 'mmemory' in l.lower()]
    snippet_len = 0
    for l in mmemory_lines:
        try:
            d = json.loads(l)
            msg = d.get('message', '')
            if 'snippetLen=' in msg:
                snippet_len = int(msg.split('snippetLen=')[1].split(' ')[0].split(',')[0])
        except:
            pass
    has_exception = any('EXCEPTION' in l for l in delta_lines)
    result = check_fn(r.stdout, r.returncode, snippet_len, has_exception, mmemory_lines)
    status = 'PASS' if result else 'FAIL'
    print(f'{status}: {name}')
    if not result:
        print(f'  stdout: {r.stdout[:200]}')
        print(f'  exit: {r.returncode}')
        print(f'  snippet_len: {snippet_len}')
        print(f'  exceptions: {has_exception}')
    return result

def main():
    setup()
    results = []

    results.append(run_test('T0 extension discovery',
        'say PING',
        lambda out, rc, slen, exc, _: rc == 0 and not exc and slen > 0))

    results.append(run_test('T1 basic template',
        '/template test-basic.md',
        lambda out, rc, slen, exc, _: 'TEMPLATE_EXECUTED' in out and rc == 0 and not exc))

    results.append(run_test('T2 model switch',
        '/template test-model.md',
        lambda out, rc, slen, exc, _: 'MODEL_SWITCHED' in out and rc == 0 and not exc))

    results.append(run_test('T3 thinking level',
        '/template test-thinking.md',
        lambda out, rc, slen, exc, _: '4' in out and rc == 0 and not exc))

    results.append(run_test('T7 mmemory coexistence',
        '/template test-basic.md',
        lambda out, rc, slen, exc, _: slen > 0 and not exc))

    results.append(run_test('T10 invalid model graceful',
        '/template test-invalid.md',
        lambda out, rc, slen, exc, _: rc == 0 and not exc))

    passed = sum(results)
    total = len(results)
    print(f'\n{passed}/{total} tests passed')
    return 0 if passed == total else 1

if __name__ == '__main__':
    exit(main())
```

---

## What Cannot Be Tested Headlessly (and Why)

| Test | Reason | Alternative |
|---|---|---|
| T8 Model restore (two-prompt session) | Requires two sequential prompts to same session; each `-p` is a new session | Manual: start `ow`, run `/template`, then ask "what model am I using?" |
| T9 Workers graceful degrade | Need to observe EventBus IPC timeout behaviour | Manual: observe log for `PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT` then silence |
| T12 Deterministic step | Shell command output threading | Manual OR headless if `/template` fires the chain and returns shell output in stdout |
| Full chain context flow | Multi-turn within one session | Manual OR future: implement session recording playback |

For T8: the session model tracking is verifiable in logs once `model_select` event is added (Phase 2).

---

## Pass Criteria

| Phase | Gate | Criteria |
|---|---|---|
| Pre-work | Extension loads | T0 PASS (no EXCEPTION, snippetLen > 0) |
| Phase 1 | Basic execution | T1, T2, T3 PASS |
| Phase 1 | mmemory safe | T7 snippetLen on template turn >= snippetLen on non-template turn |
| Phase 1 | Error resilience | T10 PASS (no crash on bad model) |
| Phase 1 | Full suite | T0, T1, T2, T3, T7, T10 all PASS |
| Phase 2 | Model restore | T8 PASS (manual) |
| Phase 2 | Cancel clean | Abort mid-chain, verify model restored in next turn (manual) |
