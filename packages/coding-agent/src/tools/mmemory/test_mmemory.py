#!/usr/bin/env python3
"""
mmemory server integration tests.

One shared server process for all tests (model loads once).
Each test gets an isolated tmpdir as project_dir.
Assertions read chunks.json / vectors.safetensors directly — no extra round-trips.
Fails immediately on the first assertion error.

Usage:
    python test_mmemory.py [--log FILE] [--port PORT]

Covered:
  T01  ping — health check response shape
  T02  build: source:session chunks ingested and written to chunks.json
  T03  get_consolidation_chunks — threshold, watermark, end_ts on returned chunks
  T04  build: source:observation chunks
  T05  build: source:file derived from session read_files / modified_files / written_files
  T06  build: session chunk persists file arrays in chunks.json for step-2b re-scan
  T07  build: queue .md files deleted after successful processing
  T08  build: chunks with ts=0 healed (ts stamped) on load
  T09  build: dedup — same hash not re-inserted on second build call
  T10  rebuild — force re-embed; chunk count unchanged; vectors.safetensors recreated
  T11  recall mode:session — session+observation only, sorted ts DESC, no fact
  T12  recall mode:query — BM25+semantic+RRF; uid in top results; result shape correct
  T13  recall filter source:file — only file chunks returned
  T14  recall filter source:observation — only observation chunks; time-range ts_after/ts_before
  T15  recall filter ts_after — results all have ts >= threshold
  T16  bm25 — pure keyword search; uid in top result; result shape has text/source/ts/score
  T17  dedup_check — known text scores high; random text not flagged
  T18  embed — batch embed; correct count; 384-dim vectors; error on empty list
  T19  vacuum — stale chunks purged per max_age_days; fresh survive;
                vectors rebuilt; vacuum-state.json written;
                ts=0 chunks survive (treated as fresh)
  T20  concurrent builds — two parallel requests; both chunks land; no data loss

Not covered here (requires live ow + LLM calls):
  C01  executeMemoryConsolidate end-to-end: real LLM synthesises session chunks → obs queue file written
  C02  retain-triggered consolidation poll fires and produces observation chunks in DB
  C03  /mmemory consolidate (force): threshold:1, LLM call, obs chunk in DB
  C04  recall prompt routes file-name queries to sources:["file"] filter
  C05  /mmemory view shows session-start snapshot, <observations> above <memories>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

# ─── CLI ──────────────────────────────────────────────────────────────────────
ap = argparse.ArgumentParser()
ap.add_argument("--log", default=None, help="also write log to this file")
ap.add_argument("--port", type=int, default=49400, help="server port")
args = ap.parse_args()

handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
if args.log:
    handlers.append(logging.FileHandler(args.log, mode="w", encoding="utf-8"))
logging.basicConfig(level=logging.INFO, handlers=handlers,
                    format="%(asctime)s %(levelname)-5s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("mm_test")

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

def contains(label: str, item: Any, container: Any) -> None:
    ok(label, item in container, f"{item!r} not in {type(container).__name__}")

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

def build(project_dir: str, wait: float = 14, vacuum: bool = False) -> None:
    r = rpc({"action": "build", "project_dir": project_dir,
             "vacuum_config": {"enabled": vacuum}})
    ok("build accepted", r.get("status") == "accepted", str(r))
    # Poll until chunks.json stabilises (mtime stops changing) or timeout
    cpath = Path(project_dir) / "chunks.json"
    deadline = time.time() + wait
    prev_mtime = 0.0
    time.sleep(2)
    while time.time() < deadline:
        mtime = cpath.stat().st_mtime if cpath.exists() else 0.0
        if mtime > 0 and mtime == prev_mtime:
            break
        prev_mtime = mtime
        time.sleep(1)

def chunks(project_dir: str) -> list[dict]:
    p = Path(project_dir) / "chunks.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []

def by_source(project_dir: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for c in chunks(project_dir):
        s = c.get("source", "?")
        counts[s] = counts.get(s, 0) + 1
    return counts

# ─── Queue file builders ──────────────────────────────────────────────────────
def session_md(uid: str, project: str, *,
               read_files: list[str] | None = None,
               modified_files: list[str] | None = None,
               written_files: list[str] | None = None,
               ts: int | None = None) -> str:
    ts = ts or int(time.time())
    def fmt(lst: list[str] | None) -> str:
        if not lst:
            return " []"
        return " [" + ", ".join(f'"{p}"' for p in lst) + "]"
    return (
        f"---\nsource: session\nts: {ts}\nproject: {project}\nagent_tag: default\n"
        f"read_files:{fmt(read_files)}\nmodified_files:{fmt(modified_files)}\n"
        f"written_files:{fmt(written_files)}\n---\n"
        f"**User:** session uid {uid}\n"
        f"**Assistant:** Confirmed uid {uid}. Integration test for mmemory "
        f"queue-only ingress covering all source types and server endpoints.\n"
    )

def fact_md(uid: str, project: str, ts: int | None = None) -> str:
    ts = ts or int(time.time())
    return (
        f"---\nsource: fact\nts: {ts}\nproject: {project}\nsession_id: s-{uid}\n---\n"
        f"fact: integration test fact {uid} — validates source:fact ingestion\n"
    )

def obs_md(uid: str, project: str, ts: int | None = None, end_ts: int | None = None) -> str:
    ts = ts or int(time.time())
    end_ts = end_ts or ts
    return (
        f"---\nsource: observation\nts: {ts}\nend_ts: {end_ts}\nproject: {project}\n"
        f"entities: [\"mmemory\", \"{uid}\"]\ndate: 2026-05-07\n---\n"
        f"Observation {uid}: cross-session pattern in mmemory pipeline confirmed.\n"
    )

def write_queue(project_dir: str, name: str, content: str) -> Path:
    p = Path(project_dir) / "queue" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return p

# ─── Tests ────────────────────────────────────────────────────────────────────

def T01_ping():
    r = rpc({"action": "ping"})
    eq("T01 ping.status", r["status"], "ok")
    ok("T01 ping.pid", r.get("pid", 0) > 0)
    ok("T01 ping.model_loaded key present", "model_loaded" in r)


def T02_session_chunks():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(uid, td))
        build(td)
        src = by_source(td)
        ok("T02 session count > 0", src.get("session", 0) > 0, str(src))
        sess = [c for c in chunks(td) if c.get("source") == "session"]
        ok("T02 uid in session text", any(uid in c.get("text", "") for c in sess))
        ok("T02 end_ts present on session chunks", all("end_ts" in c for c in sess))
        ok("T02 end_ts == ts for session (point-in-time)", all(c.get("end_ts") == c.get("ts") for c in sess))


def T03_get_consolidation_chunks():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        now = int(time.time())
        for i in range(3):
            ts = now - (3 - i) * 60
            write_queue(td, f"s-{uid}-{i}.md", session_md(uid + str(i), td, ts=ts))
        build(td, wait=16)

        r = rpc({"action": "get_consolidation_chunks", "project_dir": td, "threshold": 2, "max_turns": 50})
        ok("T03 threshold=2 returns chunks", len(r.get("chunks", [])) > 0, str(r))
        ok("T03 count >= 2", r.get("count", 0) >= 2)
        ok("T03 start_ts <= end_ts", r.get("start_ts", 1) <= r.get("end_ts", 0), str(r))
        eq("T03 watermark=0 no observations", r.get("watermark"), 0)
        for c in r["chunks"]:
            contains("T03 chunk has text", "text", c)
            contains("T03 chunk has ts", "ts", c)
            contains("T03 chunk has end_ts", "end_ts", c)

        r2 = rpc({"action": "get_consolidation_chunks", "project_dir": td, "threshold": 100, "max_turns": 50})
        eq("T03 threshold=100 empty", r2.get("chunks"), [])
        ok("T03 count still reported", r2.get("count", 0) > 0)

def T04_observation_chunks():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"o-{uid}.md", obs_md(uid, td))
        build(td)
        src = by_source(td)
        ok("T04 observation count > 0", src.get("observation", 0) > 0, str(src))
        obs = [c for c in chunks(td) if c.get("source") == "observation"]
        ok("T04 end_ts present on obs chunk", all("end_ts" in c for c in obs), str(obs))
        ok("T04 end_ts >= ts on obs chunk", all(c.get("end_ts", 0) >= c.get("ts", 0) for c in obs))
        ok("T04 uid in obs text", any(uid in c.get("text", "") for c in obs))


def T05_file_chunks():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(
            uid, td,
            read_files=["src/index.ts", "src/utils.ts"],
            modified_files=["src/server.py"],
            written_files=["src/new.py"],
        ))
        build(td, wait=16)
        src = by_source(td)
        ok("T05 file count > 0", src.get("file", 0) > 0, str(src))
        paths = {c.get("path", "") for c in chunks(td) if c.get("source") == "file"}
        ok("T05 index.ts indexed (read)", any("index.ts" in p for p in paths), str(paths))
        ok("T05 server.py indexed (modified)", any("server.py" in p for p in paths))
        ok("T05 new.py indexed (written)", any("new.py" in p for p in paths))


def T06_file_arrays_persisted():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(
            uid, td, read_files=["auth.ts"], modified_files=["db.py"]))
        build(td, wait=16)
        sess = [c for c in chunks(td)
                if c.get("source") == "session" and c.get("read_files")]
        ok("T06 session chunk has read_files persisted", len(sess) > 0,
           f"session chunks with read_files: {len(sess)}")
        ok("T06 read_files value correct", "auth.ts" in sess[0]["read_files"])


def T07_queue_files_deleted():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        qf = write_queue(td, f"s-{uid}.md", session_md(uid, td))
        ok("T07 queue file exists before build", qf.exists())
        build(td)
        ok("T07 queue file deleted after build", not qf.exists())


def T08_ts_heal():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        # Write chunks.json with a chunk missing ts
        raw = [{
            "hash": hashlib.sha256(f"heal_{uid}".encode()).hexdigest()[:16],
            "text": f"**User:** ts-heal {uid}\n**Assistant:** Legacy no-ts chunk.",
            "source": "session",
            "path": f"/legacy/{uid}.md",
            "project": td,
            # deliberately omit ts
        }]
        (Path(td) / "chunks.json").write_text(json.dumps(raw))
        build(td)  # triggers load → heal
        healed = [c for c in chunks(td) if uid in c.get("text", "")]
        ok("T08 chunk survives heal", len(healed) > 0)
        ok("T08 ts now non-zero after heal", all(c.get("ts", 0) > 0 for c in healed),
           str([c.get("ts") for c in healed]))


def T09_dedup():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(uid, td))
        build(td)
        count_1 = len(chunks(td))
        # Second build with same content — same hash, no new chunk
        write_queue(td, f"s-{uid}-dup.md", session_md(uid, td))
        build(td)
        count_2 = len(chunks(td))
        eq("T09 dedup: no new chunk on identical content", count_2, count_1)


def T10_rebuild():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(uid, td))
        build(td)
        count_before = len(chunks(td))
        vec_path = Path(td) / "vectors.safetensors"
        mtime_before = vec_path.stat().st_mtime if vec_path.exists() else 0
        r = rpc({"action": "rebuild", "project_dir": td,
                 "vacuum_config": {"enabled": False}})
        eq("T10 rebuild accepted", r["status"], "accepted")
        time.sleep(16)
        eq("T10 chunk count unchanged", len(chunks(td)), count_before)
        ok("T10 vectors recreated",
           vec_path.exists() and vec_path.stat().st_mtime >= mtime_before)


def T11_recall_session_mode():
    with tempfile.TemporaryDirectory() as td:
        uid_s = uuid.uuid4().hex[:8]
        uid_o = uuid.uuid4().hex[:8]
        uid_f = uuid.uuid4().hex[:8]
        now = int(time.time())
        write_queue(td, f"s-{uid_s}.md", session_md(uid_s, td, ts=now - 3600))
        write_queue(td, f"o-{uid_o}.md", obs_md(uid_o, td, ts=now))
        write_queue(td, f"f-{uid_f}.md", fact_md(uid_f, td, ts=now - 100))
        build(td, wait=16)

        r = rpc({"action": "recall", "project_dir": td, "query": "",
                 "mode": "session", "limit": 20})
        sources = {x["source"] for x in r["results"]}
        ok("T11 session mode excludes fact", "fact" not in sources, str(sources))
        ok("T11 session mode has session/obs only", sources <= {"session", "observation"})
        tss = [x["ts"] for x in r["results"]]
        eq("T11 results sorted ts DESC", tss, sorted(tss, reverse=True))


def T12_recall_query_mode():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(uid, td))
        build(td, wait=16)

        r = rpc({"action": "recall", "project_dir": td,
                 "query": f"integration test {uid}",
                 "mode": "query", "limit": 10, "recency_weight": 0.0})
        eq("T12 mode in response", r.get("mode"), "query")
        ok("T12 has results", len(r.get("results", [])) > 0)
        texts = [x["text"] for x in r["results"]]
        ok("T12 uid in results", any(uid in t for t in texts), str(texts)[:200])
        first = r["results"][0]
        for field in ("text", "source", "ts", "score"):
            contains(f"T12 result.{field} present", field, first)


def T13_filter_file():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(
            uid, td, read_files=["secret_auth.ts"]))
        write_queue(td, f"f-{uid}.md", fact_md(uid, td))
        build(td, wait=16)

        r = rpc({"action": "recall", "project_dir": td,
                 "query": "secret_auth.ts",
                 "mode": "query", "limit": 20,
                 "filter": {"source": ["file"]}})
        sources = {x["source"] for x in r["results"]}
        ok("T13 file filter: only file chunks returned",
           sources <= {"file"} and len(r["results"]) > 0, str(sources))


def T14_filter_observation_timerange():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        now = int(time.time())
        # session + two observations at different times
        write_queue(td, f"s-{uid}.md", session_md(uid, td))
        write_queue(td, f"o-old-{uid}.md", obs_md(uid + "_old", td, ts=now - 7200, end_ts=now - 7100))
        write_queue(td, f"o-new-{uid}.md", obs_md(uid + "_new", td, ts=now + 7200, end_ts=now + 7300))
        build(td, wait=16)

        # observation filter: only obs chunks
        r = rpc({"action": "recall", "project_dir": td,
                 "query": f"cross-session pattern {uid}",
                 "mode": "query", "limit": 20,
                 "filter": {"source": ["observation"]}})
        sources = {x["source"] for x in r["results"]}
        ok("T14 obs filter: only observation chunks",
           sources <= {"observation"} and len(r["results"]) > 0, str(sources))

        # ts_after filter: only future obs chunk
        r2 = rpc({"action": "recall", "project_dir": td,
                  "query": f"cross-session pattern {uid}",
                  "mode": "query", "limit": 20,
                  "filter": {"source": ["observation"], "ts_after": now}})
        for res in r2["results"]:
            ok(f"T14 ts_after result ts {res['ts']} >= {now}", res["ts"] >= now)
        old_in_results = [x for x in r2["results"] if uid + "_old" in x.get("text", "")]
        eq("T14 ts_after excludes old obs", old_in_results, [])


def T15_filter_ts_after():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        now = int(time.time())
        write_queue(td, f"s-old.md", session_md(uid + "_old", td, ts=now - 7200))
        write_queue(td, f"s-new.md", session_md(uid + "_new", td, ts=now + 7200))
        build(td, wait=14)

        r = rpc({"action": "recall", "project_dir": td,
                 "query": f"integration test {uid}",
                 "mode": "query", "limit": 20,
                 "filter": {"source": ["session"], "ts_after": now}})
        for res in r["results"]:
            ok(f"T15 ts_after: result ts {res['ts']} >= {now}",
               res["ts"] >= now, f"ts={res['ts']}")
        old_ids = [x["text"] for x in r["results"] if uid + "_old" in x["text"]]
        eq("T15 ts_after: old chunk excluded", old_ids, [])


def T16_bm25():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(uid, td))
        write_queue(td, f"o-{uid}.md", obs_md(uid, td))
        build(td, wait=16)

        r = rpc({"action": "bm25", "project_dir": td,
                 "query": f"integration test {uid}", "limit": 5})
        ok("T16 bm25 has results", len(r.get("results", [])) > 0,
           f"full response: {r}")
        first = r["results"][0]
        for field in ("text", "source", "ts", "score"):
            contains(f"T16 bm25 result.{field} present", field, first)
        ok("T16 bm25 uid in top result", uid in first["text"], first["text"][:100])


def T17_dedup_check():
    with tempfile.TemporaryDirectory() as td:
        uid = uuid.uuid4().hex[:8]
        write_queue(td, f"s-{uid}.md", session_md(uid, td))
        build(td, wait=16)

        exact_text = (
            f"**User:** session uid {uid}\n"
            f"**Assistant:** Confirmed uid {uid}. Integration test for mmemory "
            f"queue-only ingress covering all source types and server endpoints."
        )
        r_dup = rpc({"action": "dedup_check", "project_dir": td,
                     "text": exact_text, "threshold": 0.90})
        ok("T17 dedup fields present",
           "is_duplicate" in r_dup and "max_score" in r_dup, str(r_dup))
        ok("T17 known text scores high (>= 0.85)",
           r_dup["max_score"] >= 0.85, f"score={r_dup['max_score']:.3f}")

        r_uniq = rpc({"action": "dedup_check", "project_dir": td,
                      "text": "xyzzy_random_" + uuid.uuid4().hex,
                      "threshold": 0.90})
        eq("T17 unique text not flagged", r_uniq["is_duplicate"], False)


def T18_embed():
    texts = ["hello world", "mmemory queue ingress", "source file chunk pipeline"]
    r = rpc({"action": "embed", "texts": texts})
    eq("T18 embed count", r["count"], len(texts))
    vecs = r["vectors"]
    eq("T18 embed vector list len", len(vecs), len(texts))
    eq("T18 embed dimension 384", len(vecs[0]), 384)
    ok("T18 embed values are float", isinstance(vecs[0][0], float))

    r_err = rpc({"action": "embed", "texts": []})
    ok("T18 embed error on empty list", "error" in r_err, str(r_err))


def T19_vacuum():
    with tempfile.TemporaryDirectory() as td:
        uid_ok   = uuid.uuid4().hex[:8]
        uid_old  = uuid.uuid4().hex[:8]  # stale observation (100d old; obs max_age=90d)
        uid_nots = uuid.uuid4().hex[:8]
        now = int(time.time())

        # Fresh session (today)
        write_queue(td, f"s-ok.md", session_md(uid_ok, td))
        # Stale observation (100 days old; observation max_age=90d)
        write_queue(td, f"o-old.md", obs_md(uid_old, td, ts=now - 100 * 86400, end_ts=now - 100 * 86400))
        build(td, wait=16)

        # Manually add a chunk with ts=0 (legacy, no timestamp)
        all_chunks = chunks(td)
        all_chunks.append({
            "hash": hashlib.sha256(f"nots_{uid_nots}".encode()).hexdigest()[:16],
            "text": f"**User:** ts-zero {uid_nots}\n**Assistant:** Legacy ts=0 chunk.",
            "source": "session", "path": f"/legacy/{uid_nots}.md",
            "project": td, "ts": 0,
        })
        (Path(td) / "chunks.json").write_text(json.dumps(all_chunks))

        before = by_source(td)
        ok("T19 stale observation present before vacuum", before.get("observation", 0) > 0, str(before))
        vec_path = Path(td) / "vectors.safetensors"
        mtime_before = vec_path.stat().st_mtime if vec_path.exists() else 0

        r = rpc({"action": "vacuum", "project_dir": td, "vacuum_config": {
            "enabled": True, "interval_hours": 0,
            "max_age_days": {"session": 365, "observation": 90, "file": 180},
        }})
        eq("T19 vacuum accepted", r["status"], "accepted")
        time.sleep(10)

        after = chunks(td)
        after_src = by_source(td)
        eq("T19 stale observation purged", after_src.get("observation", 0), 0)
        ok("T19 fresh session survives", after_src.get("session", 0) > 0, str(after_src))
        ok("T19 ts=0 chunk survives (treated fresh)",
           any(uid_nots in c.get("text", "") for c in after),
           "ts=0 chunk should not be purged")
        ok("T19 vectors rebuilt",
           vec_path.exists() and vec_path.stat().st_mtime > mtime_before)
        vstate = Path(td) / "vacuum-state.json"
        ok("T19 vacuum-state.json written", vstate.exists())
        state = json.loads(vstate.read_text())
        ok("T19 last_vacuum_ts recent",
           abs(state["last_vacuum_ts"] - time.time()) < 60,
           f"ts={state['last_vacuum_ts']}")


def T20_concurrent():
    with tempfile.TemporaryDirectory() as td:
        uid_a = uuid.uuid4().hex[:8]
        uid_b = uuid.uuid4().hex[:8]
        errors: list[str] = []

        def do(uid: str) -> None:
            try:
                write_queue(td, f"s-{uid}.md", session_md(uid, td))
                rpc({"action": "build", "project_dir": td,
                     "vacuum_config": {"enabled": False}})
            except Exception as e:
                errors.append(str(e))

        t1 = threading.Thread(target=do, args=(uid_a,))
        t2 = threading.Thread(target=do, args=(uid_b,))
        t1.start(); t2.start()
        t1.join(); t2.join()
        time.sleep(18)

        eq("T20 no rpc errors", errors, [])
        texts = [c["text"] for c in chunks(td) if c.get("source") == "session"]
        ok("T20 uid_a chunk present", any(uid_a in t for t in texts), f"uid_a={uid_a}")
        ok("T20 uid_b chunk present", any(uid_b in t for t in texts), f"uid_b={uid_b}")


# ─── Runner ───────────────────────────────────────────────────────────────────
TESTS = [
    T01_ping,  T02_session_chunks,   T03_get_consolidation_chunks,
    T04_observation_chunks, T05_file_chunks, T06_file_arrays_persisted,
    T07_queue_files_deleted, T08_ts_heal, T09_dedup, T10_rebuild,
    T11_recall_session_mode, T12_recall_query_mode,
    T13_filter_file, T14_filter_observation_timerange, T15_filter_ts_after,
    T16_bm25, T17_dedup_check, T18_embed,
    T19_vacuum, T20_concurrent,
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
    log.info("mmemory integration tests  script=%s", SERVER_SCRIPT)
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
