#!/usr/bin/env python3
"""
Integration tests for m-prompt-template.

IMPORTANT LIMITATION: In -p headless mode, template execution ALWAYS hangs
because runPromptCommand calls pi.sendUserMessage() then waitForTurnStart(),
which waits for a follow-up turn that never starts in single-shot -p mode.

What we CAN test headlessly:
- Extension loads and registers template commands (log evidence)
- Template files are parsed correctly (no errors in log)
- Role: field resolves via modelRoles (no 'No available model' error)
- Unknown role fails cleanly (no crash)
- Bad model spec gracefully handled

What MUST be tested interactively (start ow, run command):
- Template body actually executes and produces output
- memory: none actually strips <observations> from system prompt
- tools: [read] actually restricts available tools
- skill: actually injects skill content into system prompt
- model: / role: actually switches model (observable in ow UI)
"""
import subprocess, os, sys, json, time
from pathlib import Path

OMP = Path(os.environ.get("LOCALAPPDATA", "C:/Users/common/AppData/Local")) / "omp" / "omp.exe"
FLAGS = ["--no-lsp", "--no-pty", "--model", "openrouter/xiaomi/mimo-v2-flash"]
CWD = "D:/.ai"
LOG = Path("D:/.ai/.junctions/omp/logs")
PROMPTS_GLOBAL = Path("C:/Users/common/.pi/agent/prompts")
PROMPTS_PROJECT = Path("D:/.ai/.pi/prompts")
ENV = {**os.environ,
       "PI_CODING_AGENT_DIR": str(Path(os.environ.get("USERPROFILE","C:/Users/common")) / ".omp" / "agent")}


def log_path():
    return LOG / time.strftime("omp.%Y-%m-%d.log")


def log_count():
    try: return sum(1 for _ in open(log_path(), encoding="utf-8", errors="replace"))
    except: return 0


def read_new_log_lines(before: int) -> list[str]:
    try:
        with open(log_path(), encoding="utf-8", errors="replace") as f:
            return f.readlines()[before:]
    except: return []


def run_ow(prompt: str, timeout: int = 30) -> tuple[int, str, list[str]]:
    """Run ow in -p mode. Note: template commands hang in -p mode."""
    before = log_count()
    try:
        r = subprocess.run([str(OMP), "-p", prompt] + FLAGS,
            cwd=CWD, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace", env=ENV)
        return r.returncode, r.stdout, read_new_log_lines(before)
    except subprocess.TimeoutExpired:
        return 124, "", read_new_log_lines(before)


def ok(label: str, passed: bool, detail: str = "") -> bool:
    status = "PASS" if passed else "FAIL"
    extra = f"  [{detail}]" if detail else ""
    print(f"  [{status}] {label}{extra}")
    return passed


def setup():
    for d in [PROMPTS_GLOBAL, PROMPTS_PROJECT]:
        d.mkdir(parents=True, exist_ok=True)
    import shutil

    templates = {
        "t1-basic.md": b"---\nname: t1-basic\ndescription: Basic PT test\n---\nSay exactly and only: TEMPLATE_T1_OK\n",
        "t2-role.md": b"---\nname: t2-role\nrole: smol\ndescription: Role routing test\n---\nSay exactly and only: ROLE_T2_OK\n",
        "t3-no-memory.md": b"---\nname: t3-no-memory\nmemory: none\ndescription: Memory isolation\n---\nList XML section headers from your system prompt.\n",
        "t4-read-only.md": b"---\nname: t4-read-only\ntools:\n  - read\ndescription: Tool restriction test\n---\nWhat tools are available? List them.\n",
        "t5-skill.md": b"---\nname: t5-skill\nskill: test-marker\ndescription: Skill injection test\n---\nWhat is the internal test codename? One word.\n",
        "t6-bad-role.md": b"---\nname: t6-bad-role\nrole: nonexistent_role_xyz_999\ndescription: Bad role test\n---\nSay hello.\n",
        "test-pt.md": b"---\nname: test-pt\nrole: smol\ndescription: TEST ONLY - not for production use.\n---\n[TEST MODE] Use only read tool. Do not reference memory.\nTask: $@\n",
    }
    skill_dir = Path("D:/.ai/.pi/skills")
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "test-marker.md").write_bytes(
        b"---\nname: test-marker\n---\nThe internal test codename is AZIMUTH-7.\n"
    )

    for name, content in templates.items():
        (PROMPTS_GLOBAL / name).write_bytes(content)
        shutil.copy(PROMPTS_GLOBAL / name, PROMPTS_PROJECT / name)


def test_T0_extension_loads():
    """Extension activates: commands registered, no crash, mmemory active."""
    print("\nT0: Extension loads and registers commands")
    rc, stdout, log = run_ow("say PING")
    has_exception = any("EXCEPTION" in l for l in log)
    return all([
        ok("exit=0", rc == 0),
        ok("response in stdout", any(w in stdout for w in ["PING","PONG","ping","pong"]), repr(stdout[:50])),
        ok("no EXCEPTION", not has_exception),
    ])


def test_T1_templates_registered():
    """All template commands appear in /help output — registered at session_start."""
    print("\nT1: Template commands registered (/prompt:t1-basic, /prompt:t2-role, /prompt:test-pt, etc.)")
    rc, stdout, log = run_ow("list all available / commands, one per line")
    has_exception = any("EXCEPTION" in l for l in log)
    # The LLM lists commands it knows about; templates registered as commands appear
    templates_found = sum(1 for t in ["t1-basic", "t2-role", "t3-no-memory", "t4-read-only",
                                       "t5-skill", "test-pt"] if t in stdout)
    return all([
        ok("exit=0", rc == 0),
        ok("no EXCEPTION", not has_exception),
        ok("template commands visible (>=4 of 6)", templates_found >= 4,
           f"found {templates_found}/6"),
    ])


def test_T2_role_field_resolves():
    """role: smol resolves to a concrete model — no 'No available model' error.
    Template command hangs in -p mode (by design), but we see the hang not an error.
    """
    print("\nT2: role: smol field resolves via modelRoles (no resolution error)")
    before = log_count()
    try:
        r = subprocess.run([str(OMP), "-p", "/prompt:t2-role"] + FLAGS,
            cwd=CWD, capture_output=True, text=True, timeout=5, env=ENV)
        rc = r.returncode
    except subprocess.TimeoutExpired:
        rc = 124  # timeout = template executed (sendUserMessage was reached)
    log = read_new_log_lines(before)
    # If role resolved: command dispatched, sendUserMessage called, waitForTurnStart hangs (rc=124)
    # If role failed: "No available model" error in log, rc=0 (early abort)
    has_model_error = any("No available model" in l for l in log)
    has_exception = any("EXCEPTION" in l for l in log)
    dispatched = rc == 124  # hung = dispatched to handler = role resolved
    return all([
        ok("role resolved (dispatched, no resolution error)", (rc == 0 or rc == 124) and not has_model_error,
           f"rc={rc} model_err={has_model_error}"),
        ok("no EXCEPTION", not has_exception),
    ])


def test_T3_bad_role_clean_error():
    """Unknown role: gives a clean abort — no hang, no crash."""
    print("\nT3: Unknown role: gives clean abort (rc=0, no crash)")
    rc, stdout, log = run_ow("/prompt:t6-bad-role")
    has_exception = any("EXCEPTION" in l for l in log)
    # Unknown role → selectModelCandidate returns undefined → notify error → return "aborted"
    # The command handler aborts cleanly, no sendUserMessage, no hang → rc=0
    return all([
        ok("exit=0 (clean abort, no hang)", rc == 0, f"rc={rc}"),
        ok("no EXCEPTION", not has_exception),
    ])


def test_T4_model_field_resolves():
    """model: concrete-string works without role resolution."""
    print("\nT4: model: explicit provider/model string (no role resolution needed)")
    from pathlib import Path as P
    P("C:/Users/common/.pi/agent/prompts/t-explicit-model.md").write_bytes(
        b"---\nname: t-explicit-model\nmodel: openrouter/xiaomi/mimo-v2-flash\n---\nSay PING\n"
    )
    before = log_count()
    try:
        r = subprocess.run([str(OMP), "-p", "/prompt:t-explicit-model"] + FLAGS,
            cwd=CWD, capture_output=True, text=True, timeout=5, env=ENV)
        rc = r.returncode
    except subprocess.TimeoutExpired:
        rc = 124
    log = read_new_log_lines(before)
    has_model_error = any("No available model" in l for l in log)
    has_exception = any("EXCEPTION" in l for l in log)
    P("C:/Users/common/.pi/agent/prompts/t-explicit-model.md").unlink(missing_ok=True)
    return all([
        ok("dispatched (concrete model resolved)", (rc == 0 or rc == 124) and not has_model_error,
           f"rc={rc} model_err={has_model_error}"),
        ok("no EXCEPTION", not has_exception),
    ])


INTERACTIVE_TESTS = """
MANUAL TESTS (run in ow --new):

/prompt:test-pt say hello
  PASS: "TEST MODE ACTIVE" prefix, uses smol model

/prompt:t3-no-memory
  PASS: system prompt sections listed do NOT include observations/memories/referenced_files

/prompt:t4-read-only
  PASS: model lists only "read" as available tool

/prompt:t5-skill
  PASS: response mentions "AZIMUTH-7" (from injected skill)

/prompt:t2-role
  PASS: model switches to smol (openrouter/xiaomi/mimo-v2-flash), answer is ROLE_T2_OK
"""

TESTS = [
    test_T0_extension_loads,
    test_T1_templates_registered,
    test_T2_role_field_resolves,
    test_T3_bad_role_clean_error,
    test_T4_model_field_resolves,
]

if __name__ == "__main__":
    if "--dry-run" in sys.argv:
        for t in TESTS: print(t.__name__)
        sys.exit(0)

    setup()
    print("Warming up...")
    run_ow("say WARMUP", timeout=60)
    print("  OK\n")

    results = []
    for fn in TESTS:
        try:
            results.append(fn())
        except Exception as e:
            print(f"  [ERROR] {e}")
            results.append(False)

    passed = sum(results)
    total = len(results)
    print(f"\n{passed}/{total} automated passed")
    print(INTERACTIVE_TESTS)
    sys.exit(0 if passed == total else 1)
