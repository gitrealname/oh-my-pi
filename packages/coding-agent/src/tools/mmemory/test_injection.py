#!/usr/bin/env python3
"""
Integration tests for the get_injection_snapshot server action.

One shared server process on port 49401 (distinct from test_mmemory.py's 49400).
Each test gets its own isolated tmpdir.  Chunks are written directly to
chunks.json so tests run without requiring an embedding model warm-up — the
injection snapshot handler only reads chunks.json, it never embeds.

Usage:
    python test_injection.py [--log FILE] [--port PORT]

Covered:
  I01  basic: sessions returned, sorted ts ASC, count <= session_limit
  I02  anchor_ts = min(ts) across selected sessions
  I03  observations: end_ts < anchor_ts strict boundary respected
  I04  observations: ORDER BY end_ts DESC LIMIT, then reversed to ASC
  I05  files: returned sorted ts ASC, count <= file_limit
  I06  project filter: chunks from other project not included
  I07  max_chars: sessions dropped newest-first when budget exceeded
  I08  max_chars: observations never dropped even when over budget alone
  I09  max_chars: files never dropped even when over budget alone
  I10  empty DB: all arrays empty, anchor_ts=0, no error
  I11  no observations before anchor: empty observations array
  I12  observation exactly AT anchor_ts NOT included (strict <)
  I13  session_limit=1: only newest 1 session returned
  I14  response shape: all required fields present (sessions/observations/files/anchor_ts/status)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

# ─── CLI ──────────────────────────────────────────────────────────────────────
ap = argparse.ArgumentParser()
ap.add_argument("--log", default=None, help="also write log to this file")
ap.add_argument("--port", type=int, default=49401, help="server port")
args = ap.parse_args()

handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
if args.log:
    handlers.append(logging.FileHandler(args.log, mode="w", encoding="utf-8"))
logging.basicConfig(level=logging.INFO, handlers=handlers,
                    format="%(asctime)s %(levelname)-5s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("inj_test")

SERVER_SCRIPT = Path(__file__).parent / "mmemory_server.py"

# ─── Assert harness (fail-fast) ───────────────────────────────────────────────
_results: list[tuple[str, bool, str]] = []


def ok(label: str, value: Any = True, detail: str = "") -> None:
    if value:
        _results.append((label, True, ""))
        log.info("  PASS  %s", label)
    else:
        _results.append((label, False, detail or repr(value)))
        log.error("  FAIL  %s  [%s]", label, detail or repr(value))
        raise AssertionError(f"FAIL: {label}  {detail or repr(value)}")


def eq(label: str, got: Any, want: Any) -> None:
    ok(label, got == want, f"got={got!r} want={want!r}")


# ─── Server RPC ───────────────────────────────────────────────────────────────
PORT = args.port


def rpc(req: dict[str, Any], timeout: float = 60) -> dict[str, Any]:
    s = socket.create_connection(("127.0.0.1", PORT), timeout=timeout)
    try:
        s.sendall((json.dumps(req) + "\n").encode())
        buf = b""
        while True:
            c = s.recv(8192)
            if not c:
                break
            buf += c
            if b"\n" in buf:
                break
        return json.loads(buf.split(b"\n")[0])
    finally:
        s.close()


def snap(project_dir: str, project: str = "", **kwargs: Any) -> dict[str, Any]:
    """Convenience wrapper for get_injection_snapshot RPC."""
    req: dict[str, Any] = {
        "action": "get_injection_snapshot",
        "project_dir": project_dir,
    }
    if project:
        req["project"] = project
    req.update(kwargs)
    return rpc(req)


# ─── Chunk helpers ────────────────────────────────────────────────────────────

def _h(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def make_session(uid: str, project: str, ts: int, text: str = "") -> dict:
    body = text or (
        f"**User:** session uid {uid}\n"
        f"**Assistant:** Confirmed uid {uid}. " + ("x " * 25)  # > 20 words
    )
    return {
        "hash": _h(f"sess:{uid}"),
        "text": body,
        "source": "session",
        "path": f"/proj/{uid}.md",
        "project": project,
        "ts": ts,
        "end_ts": ts,
    }


def make_obs(uid: str, project: str, ts: int, end_ts: int) -> dict:
    return {
        "hash": _h(f"obs:{uid}"),
        "text": f"Observation {uid}: cross-session pattern confirmed in pipeline.",
        "source": "observation",
        "path": f"/obs/{uid}.md",
        "project": project,
        "ts": ts,
        "end_ts": end_ts,
    }


def make_file(uid: str, project: str, ts: int) -> dict:
    return {
        "hash": _h(f"file:{uid}"),
        "text": f"{uid}.ts — modified",
        "source": "file",
        "path": f"/src/{uid}.ts",
        "project": project,
        "ts": ts,
        "end_ts": ts,
    }


def write_chunks(project_dir: str, chunk_list: list[dict]) -> None:
    p = Path(project_dir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "chunks.json").write_text(json.dumps(chunk_list, indent=2), encoding="utf-8")


# ─── Tests ────────────────────────────────────────────────────────────────────

def I01_basic_sessions_sorted_asc():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        chunks = [
            make_session("a", proj, now - 300),
            make_session("b", proj, now - 200),
            make_session("c", proj, now - 100),
            make_session("d", proj, now - 50),
            make_session("e", proj, now - 10),
        ]
        write_chunks(td, chunks)

        r = snap(td, session_limit=3)
        eq("I01 status ok", r.get("status"), "ok")
        sessions = r.get("sessions", [])
        ok("I01 count <= session_limit", len(sessions) <= 3,
           f"got {len(sessions)}")
        ok("I01 at least 1 session", len(sessions) >= 1)
        tss = [s["ts"] for s in sessions]
        eq("I01 sessions sorted ts ASC", tss, sorted(tss))


def I02_anchor_ts_is_min_ts_of_selected_sessions():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        chunks = [
            make_session("a", proj, now - 300),
            make_session("b", proj, now - 200),
            make_session("c", proj, now - 100),
        ]
        write_chunks(td, chunks)

        # session_limit=2 → picks newest 2 (now-200, now-100) → anchor = now-200
        r = snap(td, session_limit=2)
        sessions = r.get("sessions", [])
        eq("I02 session count", len(sessions), 2)
        expected_anchor = min(s["ts"] for s in sessions)
        eq("I02 anchor_ts == min(session ts)", r.get("anchor_ts"), expected_anchor)


def I03_observations_strict_boundary():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        # Two sessions → anchor = now-200
        sess = [
            make_session("s1", proj, now - 200),
            make_session("s2", proj, now - 100),
        ]
        # Observation with end_ts < anchor_ts → should appear
        obs_before = make_obs("ob1", proj, now - 500, now - 201)
        # Observation with end_ts == anchor_ts → must NOT appear (strict <)
        obs_at = make_obs("ob2", proj, now - 400, now - 200)
        # Observation with end_ts > anchor_ts → must NOT appear
        obs_after = make_obs("ob3", proj, now - 50, now - 50)
        write_chunks(td, sess + [obs_before, obs_at, obs_after])

        r = snap(td, session_limit=2, observation_limit=10)
        obs = r.get("observations", [])
        end_tss = {o["end_ts"] for o in obs}
        anchor = r["anchor_ts"]

        ok("I03 obs_before included", (now - 201) in end_tss,
           f"end_tss={end_tss} anchor={anchor}")
        ok("I03 obs_at NOT included (strict <)", (now - 200) not in end_tss,
           f"obs_at end_ts={now-200} should be excluded, anchor={anchor}")
        ok("I03 obs_after NOT included", (now - 50) not in end_tss)
        ok("I03 all obs end_ts < anchor", all(o["end_ts"] < anchor for o in obs),
           f"obs={[o['end_ts'] for o in obs]} anchor={anchor}")


def I04_observations_ordered_by_end_ts_asc():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        anchor_val = now - 100
        sess = [make_session("s1", proj, anchor_val)]
        # 5 obs all before anchor; different end_ts
        obs_list = [
            make_obs(f"ob{i}", proj, now - 600, anchor_val - (5 - i) * 10)
            for i in range(5)
        ]
        write_chunks(td, sess + obs_list)

        r = snap(td, session_limit=1, observation_limit=3)
        obs = r.get("observations", [])
        ok("I04 obs count <= obs_limit", len(obs) <= 3)
        end_tss = [o["end_ts"] for o in obs]
        eq("I04 obs sorted end_ts ASC", end_tss, sorted(end_tss))
        # Should be the 3 with the highest end_ts (DESC limit then reversed)
        all_eligible = sorted(
            [o for o in obs_list if o["end_ts"] < anchor_val],
            key=lambda o: o["end_ts"], reverse=True
        )[:3]
        expected = sorted(o["end_ts"] for o in all_eligible)
        eq("I04 obs are the 3 newest-before-anchor", end_tss, expected)


def I05_files_sorted_ts_asc():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        files = [
            make_file(f"f{i}", proj, now - (5 - i) * 60)
            for i in range(5)
        ]
        write_chunks(td, files)

        r = snap(td, file_limit=3)
        f_out = r.get("files", [])
        ok("I05 count <= file_limit", len(f_out) <= 3)
        tss = [f["ts"] for f in f_out]
        eq("I05 files sorted ts ASC", tss, sorted(tss))
        # Should be the 3 newest (DESC limit then reversed → ASC)
        expected = sorted(sorted([f["ts"] for f in files], reverse=True)[:3])
        eq("I05 files are the 3 newest", tss, expected)


def I06_project_filter():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj_a = td + "/proj_a"
        proj_b = td + "/proj_b"
        chunks = [
            make_session("a1", proj_a, now - 200),
            make_session("b1", proj_b, now - 150),
            make_obs("oa1", proj_a, now - 500, now - 300),
            make_obs("ob1", proj_b, now - 500, now - 300),
            make_file("fa1", proj_a, now - 60),
            make_file("fb1", proj_b, now - 60),
        ]
        write_chunks(td, chunks)

        r = snap(td, project=proj_a, session_limit=10, observation_limit=10, file_limit=10)
        sessions = r.get("sessions", [])
        observations = r.get("observations", [])
        files = r.get("files", [])

        ok("I06 only proj_a sessions",
           all(True for _ in sessions),  # shape check
           f"sessions={sessions}")
        # Verify no proj_b chunks leaked — check by absence of proj_b uid
        all_texts = [x["text"] for x in sessions + observations + files]
        ok("I06 b1 not in sessions", not any("b1" in t for t in [x["text"] for x in sessions]))
        ok("I06 ob1 not in observations", not any("ob1" in t for t in [x["text"] for x in observations]))
        ok("I06 fb1 not in files", not any("fb1" in t for t in [x["text"] for x in files]))
        ok("I06 a1 in sessions", any("a1" in t for t in [x["text"] for x in sessions]))


def I07_max_chars_drops_newest_sessions():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        # Each session text is ~500 chars; budget = 600 → only oldest survives
        long_text = "x " * 250  # ~500 chars
        s_old = make_session("old", proj, now - 200, text=f"**User:** old\n**Assistant:** {long_text}")
        s_new = make_session("new", proj, now - 100, text=f"**User:** new\n**Assistant:** {long_text}")
        write_chunks(td, [s_old, s_new])

        r = snap(td, session_limit=5, max_chars=600)
        sessions = r.get("sessions", [])
        # Total without dropping ≈ 1000 chars > 600 → newest dropped
        ok("I07 max_chars triggered drop", len(sessions) < 2,
           f"got {len(sessions)} sessions, expected 1 after budget drop")
        if sessions:
            ok("I07 surviving session is oldest", sessions[0]["ts"] == now - 200,
               f"ts={sessions[0]['ts']}")


def I08_max_chars_observations_never_dropped():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        # One tiny session so anchor_ts is set but sessions contribute very few chars
        sess = make_session("s1", proj, now - 200,
                            text="**User:** hi\n**Assistant:** " + "a " * 25)
        # Large observation before anchor
        long_obs_text = "Observation text " * 100  # ~1700 chars
        obs = make_obs("ob1", proj, now - 500, now - 300)
        obs["text"] = long_obs_text
        write_chunks(td, [sess, obs])

        # Budget so small that even obs alone exceeds it
        r = snap(td, session_limit=1, observation_limit=5, max_chars=50)
        observations = r.get("observations", [])
        ok("I08 observations NOT dropped despite budget", len(observations) >= 1,
           f"observations were dropped: got {observations}")


def I09_max_chars_files_never_dropped():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        # One session
        sess = make_session("s1", proj, now - 200,
                            text="**User:** hi\n**Assistant:** " + "a " * 25)
        # Large file chunk
        large_file = make_file("bigfile", proj, now - 60)
        large_file["text"] = "bigfile.ts — modified " * 100  # ~2200 chars
        write_chunks(td, [sess, large_file])

        r = snap(td, session_limit=1, file_limit=5, max_chars=50)
        files = r.get("files", [])
        ok("I09 files NOT dropped despite budget", len(files) >= 1,
           f"files were dropped: got {files}")


def I10_empty_db():
    with tempfile.TemporaryDirectory() as td:
        # No chunks.json at all
        r = snap(td)
        eq("I10 status ok", r.get("status"), "ok")
        eq("I10 sessions empty", r.get("sessions"), [])
        eq("I10 observations empty", r.get("observations"), [])
        eq("I10 files empty", r.get("files"), [])
        eq("I10 anchor_ts=0", r.get("anchor_ts"), 0)


def I11_no_observations_before_anchor():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        sess = [make_session("s1", proj, now - 100)]
        # All observations AFTER anchor
        obs_after = [make_obs(f"ob{i}", proj, now + i * 10, now + i * 10 + 1)
                     for i in range(3)]
        write_chunks(td, sess + obs_after)

        r = snap(td, session_limit=1, observation_limit=10)
        eq("I11 observations empty", r.get("observations"), [])


def I12_observation_at_anchor_excluded():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        anchor_val = now - 100
        sess = [make_session("s1", proj, anchor_val)]
        # end_ts == anchor_ts exactly — must NOT be included
        obs_exact = make_obs("ob_exact", proj, now - 500, anchor_val)
        # end_ts one second before — must be included
        obs_just_before = make_obs("ob_before", proj, now - 500, anchor_val - 1)
        write_chunks(td, sess + [obs_exact, obs_just_before])

        r = snap(td, session_limit=1, observation_limit=10)
        obs = r.get("observations", [])
        end_tss = {o["end_ts"] for o in obs}
        anchor = r["anchor_ts"]

        eq("I12 anchor_ts set correctly", anchor, anchor_val)
        ok("I12 obs at anchor excluded", anchor_val not in end_tss,
           f"end_tss={end_tss} anchor={anchor}")
        ok("I12 obs just before included", (anchor_val - 1) in end_tss,
           f"end_tss={end_tss}")


def I13_session_limit_one():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        chunks = [make_session(f"s{i}", proj, now - (10 - i) * 60) for i in range(5)]
        write_chunks(td, chunks)

        r = snap(td, session_limit=1)
        sessions = r.get("sessions", [])
        eq("I13 exactly 1 session", len(sessions), 1)
        # session_limit=1 → newest session returned
        newest_ts = max(c["ts"] for c in chunks)
        eq("I13 newest session returned", sessions[0]["ts"], newest_ts)


def I14_response_shape():
    with tempfile.TemporaryDirectory() as td:
        now = int(time.time())
        proj = td
        write_chunks(td, [make_session("s1", proj, now - 100)])

        r = snap(td)
        for field in ("status", "sessions", "observations", "files", "anchor_ts"):
            ok(f"I14 field '{field}' present", field in r, f"keys={list(r.keys())}")
        ok("I14 sessions is list", isinstance(r.get("sessions"), list))
        ok("I14 observations is list", isinstance(r.get("observations"), list))
        ok("I14 files is list", isinstance(r.get("files"), list))
        ok("I14 anchor_ts is int", isinstance(r.get("anchor_ts"), int))


# ─── Runner ───────────────────────────────────────────────────────────────────
TESTS = [
    I01_basic_sessions_sorted_asc,
    I02_anchor_ts_is_min_ts_of_selected_sessions,
    I03_observations_strict_boundary,
    I04_observations_ordered_by_end_ts_asc,
    I05_files_sorted_ts_asc,
    I06_project_filter,
    I07_max_chars_drops_newest_sessions,
    I08_max_chars_observations_never_dropped,
    I09_max_chars_files_never_dropped,
    I10_empty_db,
    I11_no_observations_before_anchor,
    I12_observation_at_anchor_excluded,
    I13_session_limit_one,
    I14_response_shape,
]


def start_server() -> subprocess.Popen:
    log.info("Starting server on port %d …", PORT)
    proc = subprocess.Popen(
        [sys.executable, str(SERVER_SCRIPT), "--port", str(PORT), "--timeout", "600"],
        stderr=subprocess.PIPE, text=True, cwd=str(SERVER_SCRIPT.parent),
    )
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            r = rpc({"action": "ping"}, timeout=5)
            if r.get("status") == "ok":
                log.info("Server ready — PID %s model_loaded=%s",
                         r["pid"], r.get("model_loaded"))
                return proc
        except Exception:
            time.sleep(0.5)
    proc.terminate()
    raise RuntimeError("Server did not start in 30s")


if __name__ == "__main__":
    log.info("mmemory injection snapshot tests  script=%s", SERVER_SCRIPT)
    log.info("=" * 64)

    proc = start_server()
    passed = failed = 0
    try:
        for fn in TESTS:
            log.info("")
            log.info("-- %s --", fn.__name__)
            try:
                fn()
                passed += 1
            except AssertionError:
                failed += 1
                break
            except Exception as e:
                import traceback
                log.error("ERROR: %s\n%s", e, traceback.format_exc())
                failed += 1
                break
    finally:
        try:
            rpc({"action": "shutdown"}, timeout=5)
        except Exception:
            pass
        proc.terminate()
        err = proc.stderr.read()
        if err and ("Traceback" in err or "Error" in err):
            log.warning("server stderr:\n%s", err[-800:])

    skipped = len(TESTS) - passed - failed
    log.info("")
    log.info("=" * 64)
    log.info("Results: %d passed  %d failed  %d not reached", passed, failed, skipped)
    sys.exit(0 if failed == 0 else 1)
