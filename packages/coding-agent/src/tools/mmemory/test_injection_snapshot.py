"""
test_injection_snapshot.py — Tests for the get_injection_snapshot server action.

Run: python test_injection_snapshot.py
Port: 49402 (isolated from test_mmemory.py:49400 and test_injection.py:49401)

Each test gets its own tmpdir.
"""

import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

# ── locate server script ──────────────────────────────────────────────────────
_HERE = Path(__file__).parent
SERVER_SCRIPT = str(_HERE / "mmemory_server.py")
PORT = 49402
_results: list[tuple[str, bool, str]] = []


# ── helpers ───────────────────────────────────────────────────────────────────

def _rpc(req: dict, port: int = PORT) -> dict:
    s = socket.socket()
    s.settimeout(15)
    s.connect(("127.0.0.1", port))
    s.sendall(json.dumps(req).encode() + b"\n")
    data = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
        try:
            json.loads(data)
            break
        except Exception:
            pass
    s.close()
    return json.loads(data)


def ok(label: str, cond: bool, msg: str = "") -> None:
    _results.append((label, cond, msg))
    status = "PASS" if cond else "FAIL"
    note = f"  -- {msg}" if msg else ""
    print(f"  [{status}] {label}{note}")


def eq(label: str, a, b) -> None:
    ok(label, a == b, f"got {a!r}, expected {b!r}")


def _write_chunk(project_dir: str, chunks: list[dict]) -> None:
    """Write chunks.json (no vectors — server embeds on build if needed)."""
    Path(project_dir).mkdir(parents=True, exist_ok=True)
    path = Path(project_dir) / "chunks.json"
    path.write_text(json.dumps(chunks), encoding="utf-8")


def _session(ts: int, text: str, project: str = "testproj",
             end_ts: int | None = None) -> dict:
    return {
        "hash": f"sess_{ts}",
        "text": text,
        "source": "session",
        "project": project,
        "ts": ts,
        "end_ts": end_ts if end_ts is not None else ts,
    }


def _obs(ts: int, end_ts: int, text: str, project: str = "testproj",
         date: str = "2026-05-01") -> dict:
    return {
        "hash": f"obs_{ts}",
        "text": text,
        "source": "observation",
        "project": project,
        "ts": ts,
        "end_ts": end_ts,
        "date": date,
    }


def _file(ts: int, path: str, action: str = "read",
          project: str = "testproj") -> dict:
    return {
        "hash": f"file_{ts}_{path[-10:]}",
        "text": f"{Path(path).name} - {action}",
        "source": "file",
        "action": action,
        "path": path,
        "project": project,
        "ts": ts,
        "end_ts": ts,
    }


def _snap(project_dir: str, project: str = "testproj",
          session_limit: int = 5,
          observation_limit: int = 3,
          file_limit: int = 5,
          max_chars: int = 8000) -> dict:
    return _rpc({
        "action": "get_injection_snapshot",
        "project_dir": project_dir,
        "project": project,
        "session_limit": session_limit,
        "observation_limit": observation_limit,
        "file_limit": file_limit,
        "max_chars": max_chars,
    })


# ── test cases ────────────────────────────────────────────────────────────────

def T01_response_shape(project_dir: str):
    """Response has required top-level keys and correct types."""
    print("\nT01: response shape")
    _write_chunk(project_dir, [_session(100, "hello world session one")])
    r = _snap(project_dir)
    ok("status=ok",   r.get("status") == "ok")
    ok("has sessions",      isinstance(r.get("sessions"),      list))
    ok("has observations",  isinstance(r.get("observations"),  list))
    ok("has files",         isinstance(r.get("files"),         list))
    ok("has anchor_ts",     isinstance(r.get("anchor_ts"),     int))


def T02_sessions_sorted_asc(project_dir: str):
    """Sessions returned sorted oldest->newest."""
    print("\nT02: sessions sorted ASC")
    chunks = [
        _session(300, "third session"),
        _session(100, "first session"),
        _session(200, "second session"),
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir)
    tss = [c["ts"] for c in r["sessions"]]
    ok("sorted asc", tss == sorted(tss), f"tss={tss}")
    ok("count=3", len(r["sessions"]) == 3)


def T03_session_limit(project_dir: str):
    """session_limit caps returned sessions to newest N."""
    print("\nT03: session_limit")
    chunks = [_session(i * 100, f"session {i}") for i in range(1, 8)]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, session_limit=3)
    ok("count=3",           len(r["sessions"]) == 3)
    # Should be the 3 newest (ts=500,600,700)
    tss = [c["ts"] for c in r["sessions"]]
    ok("newest 3 returned", min(tss) == 500, f"min={min(tss)}")


def T04_anchor_ts_is_min_of_sessions(project_dir: str):
    """anchor_ts = min(ts) of returned session chunks."""
    print("\nT04: anchor_ts = min(session.ts)")
    chunks = [_session(100, "s1"), _session(200, "s2"), _session(300, "s3")]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, session_limit=2)  # returns ts=200, ts=300
    ok("anchor_ts=200", r["anchor_ts"] == 200, f"got {r['anchor_ts']}")


def T05_anchor_zero_when_no_sessions(project_dir: str):
    """anchor_ts = 0 when no session chunks."""
    print("\nT05: anchor_ts=0 with no sessions")
    _write_chunk(project_dir, [])
    r = _snap(project_dir)
    ok("anchor_ts=0", r["anchor_ts"] == 0)
    ok("sessions empty", r["sessions"] == [])


def T06_obs_strict_boundary(project_dir: str):
    """Observations with end_ts < anchor_ts (strict <) are included; at or above are excluded."""
    print("\nT06: observation strict < anchor_ts boundary")
    chunks = [
        _session(1000, "session at 1000"),
        _obs(500, 900, "obs before anchor"),    # end_ts=900 < anchor=1000 -> included
        _obs(200, 1000, "obs at anchor"),       # end_ts=1000 == anchor -> EXCLUDED
        _obs(300, 1100, "obs after anchor"),    # end_ts=1100 > anchor -> EXCLUDED
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, session_limit=1, observation_limit=10)
    ok("anchor=1000",           r["anchor_ts"] == 1000)
    ok("1 obs included",        len(r["observations"]) == 1)
    ok("included obs end_ts=900", r["observations"][0]["end_ts"] == 900)



def T06b_obs_fallback_when_window_covers_all_sessions(project_dir: str):
    """When strict filter excludes all obs but they overlap with the session ts range,
    fall back to include those observations (DB is small, window covers all sessions).
    Obs whose end_ts > max(session.ts) are excluded even in fallback (future obs)."""
    print("\nT06b: obs fallback when window covers all sessions")
    # Session at ts=1000.  anchor_ts=1000.  max_sess_ts=1000.
    # obs A: end_ts=1000  -> strict EXCLUDED; overlapping (1000 <= 1000 <= 1000) -> fallback INCLUDED
    # obs B: end_ts=1001  -> strict EXCLUDED; NOT overlapping (1001 > 1000) -> fallback EXCLUDED
    chunks = [
        _session(1000, "only session"),
        _obs(500, 1000, "obs covering only session"),   # end_ts=1000 -> fallback included
        _obs(600, 1001, "obs after session"),            # end_ts=1001 > max_sess_ts -> excluded
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, session_limit=10, observation_limit=3)
    ok("anchor=1000",              r["anchor_ts"] == 1000)
    ok("fallback: 1 obs returned",  len(r["observations"]) == 1)
    ok("included obs end_ts=1000", r["observations"][0]["end_ts"] == 1000)


def T06c_obs_fallback_respects_limit(project_dir: str):
    """Fallback respects observation_limit; only obs within session ts range included."""
    print("\nT06c: obs fallback respects limit")
    # Session at ts=2000.  anchor=2000.  max_sess_ts=2000.
    # obs i: end_ts = 2000 (all within [anchor, max_sess_ts])
    chunks = [_session(2000, "session")] + [
        _obs(i * 10, 2000, f"obs {i}") for i in range(1, 6)  # all end_ts = 2000
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, session_limit=10, observation_limit=2)
    ok("fallback capped at limit=2", len(r["observations"]) == 2)
    # All 5 obs have end_ts=2000; limit=2 → 2 returned (any 2 since all same end_ts)
    ok("fallback: count is 2",    len(r["observations"]) == 2)


def T07_obs_sorted_asc(project_dir: str):
    """Observations returned sorted oldest->newest (by end_ts)."""
    print("\nT07: observations sorted ASC")
    chunks = [
        _session(2000, "session"),
        _obs(100, 400, "obs A"),
        _obs(200, 300, "obs B"),
        _obs(500, 700, "obs C"),
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, session_limit=1, observation_limit=10)
    end_tss = [c["end_ts"] for c in r["observations"]]
    ok("obs sorted asc", end_tss == sorted(end_tss), f"end_tss={end_tss}")


def T08_obs_limit(project_dir: str):
    """observation_limit caps how many observations are returned (nearest to anchor)."""
    print("\nT08: observation_limit")
    chunks = [_session(2000, "session")] + [
        _obs(i * 100, i * 100 + 50, f"obs {i}") for i in range(1, 8)
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, session_limit=1, observation_limit=3)
    ok("count=3", len(r["observations"]) == 3)
    # Should be the 3 with highest end_ts below anchor (700+50, 600+50, 500+50)
    end_tss = sorted([c["end_ts"] for c in r["observations"]])
    ok("nearest 3 to anchor", end_tss == [550, 650, 750], f"end_tss={end_tss}")


def T09_files_sorted_asc(project_dir: str):
    """Files returned sorted oldest->newest."""
    print("\nT09: files sorted ASC")
    chunks = [
        _session(1000, "session"),
        _file(300, "/a/file3.ts"),
        _file(100, "/a/file1.ts"),
        _file(200, "/a/file2.ts"),
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, file_limit=10)
    tss = [c["ts"] for c in r["files"]]
    ok("sorted asc", tss == sorted(tss))
    ok("count=3", len(r["files"]) == 3)


def T10_file_limit(project_dir: str):
    """file_limit caps returned files to newest N."""
    print("\nT10: file_limit")
    chunks = [_session(1000, "session")] + [
        _file(i * 100, f"/a/f{i}.ts") for i in range(1, 8)
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, file_limit=3)
    ok("count=3", len(r["files"]) == 3)
    tss = [c["ts"] for c in r["files"]]
    ok("newest 3", min(tss) == 500, f"min={min(tss)}")


def T11_project_filter(project_dir: str):
    """Only chunks matching the requested project are included."""
    print("\nT11: project filter")
    chunks = [
        _session(100, "project A session", project="projA"),
        _session(200, "project B session", project="projB"),
        _file(300, "/a/file.ts", project="projA"),
        _file(400, "/b/file.ts", project="projB"),
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, project="projA")
    # project filter: projA has ts=100 session, projB has ts=200 session
    ok("only projA session returned", len(r["sessions"]) == 1)
    ok("projA session ts=100",        r["sessions"][0]["ts"] == 100)
    # projA file has path /a/file.ts, projB has /b/file.ts
    ok("only projA file returned",    len(r["files"]) == 1)
    ok("projA file path /a/",         "/a/" in r["files"][0].get("path", ""))


def T12_max_chars_drops_newest_sessions(project_dir: str):
    """max_chars safety net drops newest sessions first; obs and files never dropped."""
    print("\nT12: max_chars drops newest sessions only")
    big_text = "x" * 1000
    chunks = [
        _session(100, big_text),
        _session(200, big_text),
        _session(300, big_text),
        _file(50, "/a/file.ts"),  # file text is tiny
    ]
    _write_chunk(project_dir, chunks)
    # max_chars=2500 -> 3 sessions * 1000 = 3000 > 2500, one session dropped
    r = _snap(project_dir, session_limit=3, max_chars=2500)
    ok("sessions dropped to 2", len(r["sessions"]) == 2)
    ok("newest session dropped", max(c["ts"] for c in r["sessions"]) == 200)
    ok("file not dropped", len(r["files"]) == 1)


def T13_obs_never_dropped_by_max_chars(project_dir: str):
    """Observations are never dropped by max_chars safety net."""
    print("\nT13: observations never dropped by max_chars")
    big = "o" * 5000
    chunks = [
        _session(1000, "session"),
        _obs(100, 500, big),   # huge obs
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, session_limit=1, observation_limit=10, max_chars=100)
    ok("obs not dropped", len(r["observations"]) == 1)


def T14_file_action_field_present(project_dir: str):
    """File chunks include 'action' field in response."""
    print("\nT14: file action field in response")
    chunks = [
        _session(100, "session"),
        _file(50, "/a/read.ts",     action="read"),
        _file(60, "/a/written.ts",  action="written"),
        _file(70, "/a/modified.ts", action="modified"),
    ]
    _write_chunk(project_dir, chunks)
    r = _snap(project_dir, file_limit=10)
    actions = {c["path"].split("/")[-1].split(".")[0]: c.get("action") for c in r["files"]}
    ok("read action",     actions.get("read")     == "read")
    ok("written action",  actions.get("written")  == "written")
    ok("modified action", actions.get("modified") == "modified")


def T15_empty_db(project_dir: str):
    """Empty DB returns all empty arrays and anchor_ts=0."""
    print("\nT15: empty DB")
    _write_chunk(project_dir, [])
    r = _snap(project_dir)
    ok("sessions=[]",      r["sessions"] == [])
    ok("observations=[]",  r["observations"] == [])
    ok("files=[]",         r["files"] == [])
    ok("anchor_ts=0",      r["anchor_ts"] == 0)
    ok("status=ok",        r["status"] == "ok")


# ── server lifecycle ──────────────────────────────────────────────────────────

def _start_server(project_dir: str) -> None:
    import subprocess, time as _t
    proc = subprocess.Popen(
        [sys.executable, SERVER_SCRIPT, "--port", str(PORT), "--timeout", "60"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    deadline = _t.time() + 30
    while _t.time() < deadline:
        line = proc.stdout.readline().decode("utf-8", errors="replace")
        if not line:  # EOF — process exited
            break
        if "listening on" in line or line.startswith("READY:"):
            return
    raise RuntimeError("Server did not start in time")


def _stop_server() -> None:
    try:
        _rpc({"action": "shutdown"})
    except Exception:
        pass
    time.sleep(1)


# ── main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as base_tmpdir:
        print(f"Starting server on port {PORT}...")
        _start_server(base_tmpdir)
        print("Server ready.\n")

        tests = [
            T01_response_shape,
            T02_sessions_sorted_asc,
            T03_session_limit,
            T04_anchor_ts_is_min_of_sessions,
            T05_anchor_zero_when_no_sessions,
            T06_obs_strict_boundary,
            T06b_obs_fallback_when_window_covers_all_sessions,
            T06c_obs_fallback_respects_limit,
            T07_obs_sorted_asc,
            T08_obs_limit,
            T09_files_sorted_asc,
            T10_file_limit,
            T11_project_filter,
            T12_max_chars_drops_newest_sessions,
            T13_obs_never_dropped_by_max_chars,
            T14_file_action_field_present,
            T15_empty_db,
        ]

        for fn in tests:
            tmpdir = tempfile.mkdtemp(dir=base_tmpdir)
            try:
                fn(tmpdir)
            except Exception as e:
                _results.append((fn.__name__, False, f"EXCEPTION: {e}"))
                print(f"  [FAIL] {fn.__name__} -- EXCEPTION: {e}")

        _stop_server()

        passed = sum(1 for _, ok, _ in _results if ok)
        failed = sum(1 for _, ok, _ in _results if not ok)
        print(f"\n{'='*50}")
        print(f"Results: {passed}/{len(_results)} passed", end="")
        if failed:
            print(f"  ({failed} FAILED)")
            for label, ok_, msg in _results:
                if not ok_:
                    print(f"  FAIL: {label}  {msg}")
        else:
            print("  ALL PASS")
        sys.exit(0 if failed == 0 else 1)
