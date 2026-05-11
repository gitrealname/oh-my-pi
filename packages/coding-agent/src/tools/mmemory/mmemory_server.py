#!/usr/bin/env python3
"""mmemory recall server.

Inspired by Hindsight (https://github.com/vectorize-io/hindsight) by Vectorize — MIT License.
The retain/recall/reflect API naming, bank_id→project scoping model, retain_mission concept,
and async consolidation pattern are derived from Hindsight. Fact schema simplified to
{fact, entities, date} vs Hindsight's 5-dimension what/when/where/who/why extraction.

TCP socket server, line-delimited JSON protocol (localhost only).
Holds the fastembed model in memory for fast repeated recall.
Auto-stops after idle timeout. Port is fixed (passed via --port).
stderr is redirected to --log-file; nothing is written to stdout.


Storage layout (managed by this server):
    project_dir/
      queue/                 transient .md files; deleted after build (queue-only ingress)
      chunks.json            DURABLE STORE — full chunk texts + source:"file" entries
      vectors.safetensors    rebuildable from chunks.json

Build contract:
    1. Read all queue/*.md, parse into turn-boundary chunks
    2. Filter chunks whose hash already exists in chunks.json (skip)
    2b. Upsert source:"file" chunks from session file arrays
    3. Embed new chunks, append to chunks.json, extend vectors
    4. Delete processed .md files
    5. Invalidate in-memory cache
    6. Trigger vacuum if interval elapsed

Protocol:
    Request:  {"action": "ping|recall|build|rebuild|dedup_check|bm25|vacuum|embed|shutdown", ...}\\n
    Response: {"status": "ok", ...}\\n

Actions:
    ping          Health check.
    recall        Parallel BM25+semantic retrieval with RRF merge + recency boost.
    build         Background build: queue → chunks.json + vectors, delete .md files.
    rebuild       Force full re-embed of all chunks in chunks.json (model change etc.).
    dedup_check   Check cosine similarity for a text against existing vectors.
    bm25          Pure BM25 search over chunks (no embedding required).
    vacuum        Age-based purge of stale chunks and vectors.
    shutdown      Graceful stop.
    embed         Batch embed texts via the loaded fastembed model; allows semantic_server to delegate embedding.

Usage:
    python mmemory_server.py --port 49200           # fixed port (required)
    python mmemory_server.py --port 49200 --timeout 10
    python mmemory_server.py --port 49200 --log-file /path/to/server.log
"""

import collections
import traceback
import hashlib
import json
import math
import os
import re
import socket
import sys
import tempfile
import threading
import time
from datetime import date, datetime
from pathlib import Path

import numpy as np

from mmemory_bm25 import tokenize, build_bm25_index, bm25_search  # noqa: F401
DEFAULT_TIMEOUT = 10  # minutes
MODEL_NAME = "BAAI/bge-small-en-v1.5"
MODEL_CACHE = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".cache"))) / "fastembed"

if sys.platform == "win32":
    sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]


# ── Turn-boundary chunker ────────────────────────────────────────────────────
#
# Parses the turn-boundary transcript format written by mmemory-extension.ts
# buildTranscript(): **User:** <text>\n\n**Assistant:** <text>
#
# Each chunk = one user+assistant turn pair. Long assistant responses are split
# at word boundaries with the user message as context prefix on each sub-chunk.
# This is the single canonical chunker — mmemory_update.py is not bundled.

TURN_MARKER = re.compile(r"\*\*(User|Assistant):\*\*\s*")
MAX_TURN_WORDS = 400
MIN_CHUNK_WORDS = 20


def chunk_by_turns(text: str, file_path: str) -> list[dict]:
    """Split a retained transcript at turn boundaries."""
    if not text.strip():
        return []

    # Strip turn separators (---) that buildTranscript() inserts between pairs.
    # Without this, the trailing --- on each assistant block changes when a new
    # turn is added, producing different hashes for unchanged turns.
    text = re.sub(r"\n\s*-{3,}\s*\n", "\n\n", text)

    parts = TURN_MARKER.split(text)
    # parts: [preamble, role1, content1, role2, content2, ...]
    chunks = []
    i = 1
    while i + 1 < len(parts):
        role = parts[i].strip()
        content = parts[i + 1].strip()
        i += 2

        if role != "User":
            continue

        user_text = content
        asst_text = ""
        if i + 1 < len(parts) and parts[i].strip() == "Assistant":
            asst_text = parts[i + 1].strip()
            i += 2

        if not user_text and not asst_text:
            continue

        combined_words = f"User: {user_text}\nAssistant: {asst_text}".split()
        if len(combined_words) <= MAX_TURN_WORDS:
            chunk_text = f"User: {user_text}\nAssistant: {asst_text}".strip()
            chunk_hash = hashlib.sha256(chunk_text.encode()).hexdigest()[:16]
            chunks.append({"text": chunk_text, "path": file_path, "hash": chunk_hash})
        else:
            # Long response: split into blocks, each prefixed with user context
            user_prefix = f"User: {user_text[:200]}"
            words = asst_text.split()
            start = 0
            part_idx = 0
            while start < len(words):
                end = min(start + MAX_TURN_WORDS, len(words))
                block = " ".join(words[start:end])
                chunk_text = f"{user_prefix}\nAssistant (part {part_idx + 1}): {block}"
                chunk_hash = hashlib.sha256(chunk_text.encode()).hexdigest()[:16]
                chunks.append({"text": chunk_text, "path": file_path, "hash": chunk_hash})
                start = end
                part_idx += 1
    return chunks


def date_from_filename(filename: str) -> date | None:
    """Extract date from YYYYMMDD-HHMMSS-<id>.md or legacy YYYY-MM-DD-<id>.md."""
    name = Path(filename).name
    # New format: YYYYMMDD-HHMMSS-...
    m = re.match(r"^(\d{4})(\d{2})(\d{2})-\d{6}-", name)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    # Legacy format: YYYY-MM-DD-...
    m2 = re.match(r"^(\d{4}-\d{2}-\d{2})", name)
    if m2:
        try:
            return datetime.strptime(m2.group(1), "%Y-%m-%d").date()
        except ValueError:
            pass
    return None


# ── Cosine + RRF ─────────────────────────────────────────────────────────────

def cosine_similarity(query_vec: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    q = query_vec / (np.linalg.norm(query_vec) + 1e-10)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-10
    return (matrix / norms) @ q


def rrf_merge(sem: list[tuple[int, float]], bm: list[tuple[int, float]], k: int = 60) -> list[tuple[int, float]]:
    scores: dict[int, float] = {}
    for rank, (idx, _) in enumerate(sem):
        scores[idx] = scores.get(idx, 0.0) + 1.0 / (k + rank + 1)
    for rank, (idx, _) in enumerate(bm):
        scores[idx] = scores.get(idx, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)



def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Strip YAML frontmatter block from text. Returns (metadata_dict, body)."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    fm_text = text[4:end]
    body = text[end + 5:]
    meta: dict = {}
    for line in fm_text.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    return meta, body

# ── Server ───────────────────────────────────────────────────────────────────

class MmemoryServer:
    def __init__(self, port: int, timeout_minutes: int, pid_file: "Path | None" = None) -> None:
        self.port = port
        self.timeout = timeout_minutes * 60
        self.pid_file = pid_file
        self.last_activity = time.time()
        self.running = True
        self.model = None

        # In-memory caches keyed by index file path
        self._chunks_cache: dict[str, list[dict]] = {}
        self._vectors_cache: dict[str, np.ndarray] = {}
        self._bm25_cache: dict[str, dict] = {}

        self._build_locks: dict[str, threading.Lock] = {}
        # Coalescing: project dirs that arrived while a build was in flight
        self._pending_build: set[str] = set()
        self._pending_build_lock = threading.Lock()  # protects set mutation — prevents lost wakeups
        # All project dirs seen since startup — reported in ping so clients can
        # fire build for any that have orphaned queue files after a crash/restart.
        self._known_project_dirs: set[str] = set()
        self._model_lock  = threading.Lock()

    # ── Singleton election ────────────────────────────────────────────────────

    def _acquire_singleton(self) -> bool:
        """Three-layer race guard. Returns True if this process should proceed.

        Layer 1 — port ping: exit early if a live server already answers.
        Layer 2 — double-write CAS: write own PID, sleep 50ms, read back.
                  Last writer wins; earlier writers see a foreign PID and exit.
        Layer 3 — bind: OS-level guarantee (SO_EXCLUSIVEADDRUSE on Windows).
        Layers 1+2 are here; layer 3 is in run().
        """
        if self.pid_file is None:
            return True

        own_pid = str(os.getpid())

        # Layer 1: ping the port — if a server already answers, exit.
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1.0)
            s.connect(("127.0.0.1", self.port))
            s.sendall(json.dumps({"action": "ping"}).encode() + b"\n")
            s.recv(256)
            s.close()
            print(f"[mmemory] PID {own_pid}: live server on port {self.port} — exiting.",
                  file=sys.stderr, flush=True)
            return False
        except OSError:
            pass  # no server yet — proceed

        # Layer 2: write own PID, sleep, read back — last writer wins.
        try:
            self.pid_file.parent.mkdir(parents=True, exist_ok=True)
            self.pid_file.write_text(own_pid)
            time.sleep(0.05)  # 50ms — enough for concurrent writers to land
            if self.pid_file.read_text().strip() != own_pid:
                print(f"[mmemory] PID {own_pid}: lost singleton election — exiting.",
                      file=sys.stderr, flush=True)
                return False
        except OSError:
            pass  # file I/O failure is non-fatal; layer 3 (bind) is the backstop

        return True

    # ── Singleton election ────────────────────────────────────────────────────

    def _acquire_singleton(self) -> bool:
        """Three-layer race guard. Returns True if this process should proceed.

        Layer 1 — port ping: exit early if a live server already answers.
        Layer 2 — double-write CAS: write own PID, sleep 50ms, read back.
                  Last writer wins; earlier writers see a foreign PID and exit.
        Layer 3 — bind: OS-level guarantee (SO_EXCLUSIVEADDRUSE on Windows).
        Layers 1+2 are here; layer 3 is in run().
        """
        if self.pid_file is None:
            return True

        own_pid = str(os.getpid())

        # Layer 1: ping the port — if a server already answers, exit.
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1.0)
            s.connect(("127.0.0.1", self.port))
            s.sendall(json.dumps({"action": "ping"}).encode() + b"\n")
            s.recv(256)
            s.close()
            print(f"[mmemory] PID {own_pid}: live server on port {self.port} — exiting.",
                  file=sys.stderr, flush=True)
            return False
        except OSError:
            pass  # no server yet — proceed

        # Layer 2: write own PID, sleep, read back — last writer wins.
        try:
            self.pid_file.parent.mkdir(parents=True, exist_ok=True)
            self.pid_file.write_text(own_pid)
            time.sleep(0.05)  # 50ms — enough for concurrent writers to land
            if self.pid_file.read_text().strip() != own_pid:
                print(f"[mmemory] PID {own_pid}: lost singleton election — exiting.",
                      file=sys.stderr, flush=True)
                return False
        except OSError:
            pass  # file I/O failure is non-fatal; layer 3 (bind) is the backstop

        return True

    # ── Model ────────────────────────────────────────────────────────────────

    def _load_model(self) -> None:
        if self.model is not None:
            return  # fast path — no lock needed once loaded
        with self._model_lock:
            if self.model is not None:
                return  # another thread loaded while we waited for the lock
            os.environ["FASTEMBED_CACHE_PATH"] = str(MODEL_CACHE)
            try:
                from fastembed import TextEmbedding  # type: ignore[import]
            except ImportError:
                print(
                    "[mmemory] ERROR: fastembed not installed.\n"
                    "  Run: pip install fastembed safetensors numpy\n"
                    "  Then restart the omp session.",
                    file=sys.stderr, flush=True,
                )
                sys.exit(1)
            t0 = time.time()
            print(f"[mmemory] Loading model {MODEL_NAME}...", file=sys.stderr, flush=True)
            self.model = TextEmbedding(MODEL_NAME, cache_dir=str(MODEL_CACHE))
            print(f"[mmemory] Model ready ({time.time() - t0:.1f}s).", file=sys.stderr, flush=True)

    # ── Paths ────────────────────────────────────────────────────────────────

    @staticmethod
    def _dirs(project_dir: str) -> dict[str, Path]:
        p = Path(project_dir)
        return {
            "queue":        p / "queue",
            "chunks":       p / "chunks.json",
            "vectors":      p / "vectors.safetensors",
            "vectors_meta": p / "vectors.meta.json",
        }

    # ── Cache helpers ────────────────────────────────────────────────────────

    def _migrate_legacy(self, project_dir: str) -> None:
        """One-shot migration: projectDir/index/ → flat projectDir/."""
        import shutil
        p = Path(project_dir)
        legacy_dir = p / "index"
        try:
            old_chunks = json.loads((legacy_dir / "chunks.json").read_text())
            project_label = p.name
            ts_re = re.compile(r"(\d{8})-(\d{6})")
            for c in old_chunks:
                c.setdefault("project", project_label)
                c.setdefault("source", "session")
                c.setdefault("session_id", None)
                c.setdefault("agent_tag", "default")
                if "ts" not in c:
                    m = ts_re.search(c.get("path", ""))
                    if m:
                        dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
                        c["ts"] = int(dt.timestamp())
                    else:
                        c["ts"] = int(time.time())
            tmp = p / "chunks.tmp.json"
            tmp.write_text(json.dumps(old_chunks, indent=2))
            tmp.replace(p / "chunks.json")
            for name in ("vectors.safetensors", "vectors.meta.json"):
                src = legacy_dir / name
                if src.exists():
                    shutil.copy2(str(src), str(p / name))
            shutil.rmtree(str(legacy_dir), ignore_errors=True)
            self._invalidate(project_dir)
            print(f"[mmemory] Migrated {len(old_chunks)} chunks from legacy index/ layout.",
                  file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[mmemory] Migration failed (continuing): {e}", file=sys.stderr, flush=True)

    def _get_chunks(self, chunks_path: str) -> list[dict]:
        if chunks_path in self._chunks_cache:
            return self._chunks_cache[chunks_path]
        p = Path(chunks_path)
        chunks: list[dict] = []
        if p.exists():
            try:
                chunks = json.loads(p.read_text())
            except Exception:
                pass
        self._chunks_cache[chunks_path] = chunks
        return chunks

    def _get_vectors(self, vectors_path: str) -> np.ndarray | None:
        if vectors_path in self._vectors_cache:
            return self._vectors_cache[vectors_path]
        p = Path(vectors_path)
        if not p.exists():
            return None
        try:
            from safetensors.numpy import load_file  # type: ignore[import]
            vecs = load_file(str(p))["vectors"]
            self._vectors_cache[vectors_path] = vecs
            return vecs
        except ImportError:
            print(
                "[mmemory] ERROR: safetensors not installed.\n"
                "  Run: pip install fastembed safetensors numpy",
                file=sys.stderr, flush=True,
            )
            sys.exit(1)
        except Exception as e:
            print(f"EXCEPTION: [mmemory] Failed to load vectors: {e}\n" + traceback.format_exc(), file=sys.stderr, flush=True)
            return None

    def _get_bm25(self, chunks_path: str) -> dict:
        if chunks_path in self._bm25_cache:
            return self._bm25_cache[chunks_path]
        idx = build_bm25_index(self._get_chunks(chunks_path))
        self._bm25_cache[chunks_path] = idx
        return idx

    def _invalidate(self, project_dir: str) -> None:
        dirs = self._dirs(project_dir)
        for key in list(self._chunks_cache):
            if key == str(dirs["chunks"]):
                del self._chunks_cache[key]
        for key in list(self._vectors_cache):
            if key == str(dirs["vectors"]):
                del self._vectors_cache[key]
        for key in list(self._bm25_cache):
            if key == str(dirs["chunks"]):
                del self._bm25_cache[key]

    # ── Handlers ─────────────────────────────────────────────────────────────

    def _handle_ping(self, req: dict) -> dict:
        # Report which known project dirs have unprocessed queue files so the
        # client can trigger build immediately after a respawn.
        pending: list[str] = [
            pd for pd in self._known_project_dirs
            if any(Path(pd).joinpath("queue").glob("*.md"))
        ]
        return {
            "status": "ok",
            "pid": os.getpid(),
            "port": self.port,
            "model_loaded": self.model is not None,
            "cached_projects": len(self._chunks_cache),
            "pending_queue_projects": pending,
        }

    def _handle_shutdown(self, req: dict) -> dict:
        self.running = False
        return {"status": "ok", "message": "shutting down"}

    def _handle_recall(self, req: dict) -> dict:
        query: str = req.get("query", "")
        project_dir: str = req.get("project_dir", "")
        limit: int = req.get("limit", 10)
        recency_weight: float = req.get("recency_weight", 0.3)
        scope: str = req.get("scope", "per-project")
        project: str = req.get("project", "")
        filter_params: dict = req.get("filter", {})
        mode: str = req.get("mode", "query")

        if not project_dir:
            return {"error": "project_dir required"}
        if mode != "session" and not query:
            return {"error": "query required for mode=query"}
        self._known_project_dirs.add(project_dir)
        # One-shot migration: legacy index/ layout → flat layout.
        # Background thread — recall is time-constrained; the file copy can take
        # several seconds for large safetensors files. Return empty this call;
        # next recall will find the migrated data.
        if (Path(project_dir) / "index" / "chunks.json").exists() and \
                not (Path(project_dir) / "chunks.json").exists():
            threading.Thread(target=self._migrate_legacy, args=(project_dir,), daemon=False).start()
            return {"results": [], "count": 0, "note": "migrating legacy layout — retry in a moment"}
        dirs = self._dirs(project_dir)

        # Drain orphaned queue files without blocking.
        queue_dir = dirs["queue"]
        if queue_dir.exists() and not self._build_locks.setdefault(project_dir, threading.Lock()).locked() and any(queue_dir.glob("*.md")):
            self._handle_build({"action": "build", "project_dir": project_dir})
        chunks_path = str(dirs["chunks"])
        vectors_path = str(dirs["vectors"])

        chunks = self._get_chunks(chunks_path)

        def _matches_filter(chunk: dict, f: dict) -> bool:
            if f.get("project") and chunk.get("project") != f["project"]:
                return False
            src = f.get("source")
            if src:
                chunk_src = chunk.get("source", "session")
                sources = src if isinstance(src, list) else [src]
                if chunk_src not in sources:
                    return False
            if f.get("ts_after") and chunk.get("ts", 0) < int(f["ts_after"]):
                return False
            if f.get("ts_before") and chunk.get("ts", 0) > int(f["ts_before"]):
                return False
            if f.get("agent_tag") and chunk.get("agent_tag", "default") != f["agent_tag"]:
                return False
            return True

        def _build_result(chunk: dict, score: float) -> dict:
            """Assemble a result entry with all fields the client needs."""
            r: dict = {
                "text": chunk.get("text", ""),
                "source": chunk.get("source", "session"),
                "ts": chunk.get("ts", 0),
                "score": score,
                "when": chunk.get("when"),
            }
            # File metadata — present only on session chunks written by retainSession
            for field in ("read_files", "modified_files", "written_files"):
                v = chunk.get(field)
                if v is not None:
                    r[field] = v
            # File chunk metadata
            for field in ("path", "action", "end_ts", "date", "entities"):
                v = chunk.get(field)
                if v is not None:
                    r[field] = v
            return r

        # ── Session mode: time-ordered, no BM25/vector ─────────────────────────
        if mode == "session":
            # Filter to session + observation sources; apply project/agent filter
            session_filter = dict(filter_params)
            if "source" not in session_filter:
                session_filter["source"] = ["session", "observation"]
            candidates = [
                c for c in chunks
                if _matches_filter(c, session_filter)
            ]
            # Sort by ts DESC (most recent first), take top limit
            candidates.sort(key=lambda c: c.get("ts", 0), reverse=True)
            results = [_build_result(c, 1.0) for c in candidates[:limit]]
            return {"results": results, "count": len(results), "query": query, "mode": "session"}

        # ── Query mode: BM25 + semantic + recency ──────────────────────────────
        self._load_model()
        query_emb = np.array(list(self.model.embed([query]))[0], dtype=np.float32)

        sem_results: list[tuple[int, float]] = []
        bm25_results: list[tuple[int, float]] = []

        def run_semantic() -> None:
            vecs = self._get_vectors(vectors_path)
            if vecs is None or len(vecs) == 0:
                return
            scores = cosine_similarity(query_emb, vecs)
            top_idx = np.argsort(scores)[::-1][: limit * 3]
            sem_results.extend((int(i), float(scores[i])) for i in top_idx if scores[i] > 0.1)

        def run_bm25() -> None:
            idx = self._get_bm25(chunks_path)
            bm25_results.extend(bm25_search(idx, query, limit * 3))

        t1 = threading.Thread(target=run_semantic)
        t2 = threading.Thread(target=run_bm25)
        t1.start(); t2.start()
        t1.join(); t2.join()

        merged = rrf_merge(sem_results, bm25_results)

        if filter_params:
            merged = [(i, s) for i, s in merged if i < len(chunks) and _matches_filter(chunks[i], filter_params)]

        def _matches_filter(chunk: dict, f: dict) -> bool:
            if f.get("project") and chunk.get("project") != f["project"]:
                return False
            src = f.get("source")
            if src:
                chunk_src = chunk.get("source", "session")
                sources = src if isinstance(src, list) else [src]
                if chunk_src not in sources:
                    return False
            if f.get("ts_after") and chunk.get("ts", 0) < int(f["ts_after"]):
                return False
            if f.get("ts_before") and chunk.get("ts", 0) > int(f["ts_before"]):
                return False
            if f.get("agent_tag") and chunk.get("agent_tag", "default") != f["agent_tag"]:
                return False
            return True

        if filter_params:
            merged = [(i, s) for i, s in merged if i < len(chunks) and _matches_filter(chunks[i], filter_params)]

        today = date.today()
        results = []
        seen: set[str] = set()
        for idx, rrf_score in merged:
            if idx >= len(chunks):
                continue
            chunk = chunks[idx]
            text = chunk.get("text", "")
            key = text[:80]
            if key in seen:
                continue
            seen.add(key)

            chunk_path = chunk.get("path", "")
            file_date = date_from_filename(chunk_path)
            # Recency decay applies to session chunks only; obs/facts rank by relevance
            if chunk.get("source", "session") == "session" and file_date:
                source_type = chunk.get('source', 'session')
                max_age = req.get('vacuum_config', {}).get('max_age_days', {}).get(source_type, 365)
                half_life = max(30, max_age // 4)
                score = rrf_score * math.exp(-max(0, (today - file_date).days) / half_life * recency_weight)
            else:
                score = rrf_score

            if scope in ("per-project", "per-project-tagged"):
                if project and project.lower() not in chunk_path.lower():
                    continue

            results.append(_build_result(chunk, score))
            if len(results) >= limit:
                break

        results.sort(key=lambda r: r["score"], reverse=True)
        return {"results": results[:limit], "query": query, "mode": "query"}

    def _handle_build(self, req: dict) -> dict:
        """Fire-and-forget build with coalescing."""
        project_dir: str = req.get("project_dir", "")
        dedup_threshold: float = float(req.get("dedup_threshold", 0.92))
        force_rebuild: bool = req.get("force_rebuild", False)
        vacuum_config: dict = req.get("vacuum_config", {})

        if not project_dir:
            return {"error": "project_dir required"}

        if vacuum_config:
            self._vacuum_config = vacuum_config

        self._known_project_dirs.add(project_dir)
        with self._pending_build_lock:
            if self._build_locks.setdefault(project_dir, threading.Lock()).locked():
                self._pending_build.add(project_dir)
                return {"status": "accepted", "note": "coalesced"}

        def _do() -> None:
            with self._build_locks.setdefault(project_dir, threading.Lock()):
                self._run_build(project_dir, dedup_threshold, force_rebuild)
                self._invalidate(project_dir)

            # Drain any builds that arrived while this one ran.
            # Loop until set is empty — new items may arrive between iterations.
            while True:
                with self._pending_build_lock:
                    if not self._pending_build:
                        break
                    pending = self._pending_build.copy()
                    self._pending_build.clear()
                for pdir in pending:
                    with self._build_locks.setdefault(pdir, threading.Lock()):
                        self._run_build(pdir, dedup_threshold, False)
                        self._invalidate(pdir)

        threading.Thread(target=_do, daemon=False).start()
        return {"status": "accepted"}

    def _run_build(self, project_dir: str, dedup_threshold: float, force_rebuild: bool = False) -> None:
        """Read queue/*.md → chunk → append to chunks.json → embed → delete .md files."""
        self._load_model()
        try:
            from safetensors.numpy import load_file, save_file  # type: ignore[import]
        except ImportError:
            print(
                "[mmemory] ERROR: safetensors not installed.\n"
                "  Run: pip install fastembed safetensors numpy",
                file=sys.stderr, flush=True,
            )
            sys.exit(1)

        # One-shot migration: legacy index/ layout → flat layout
        legacy_chunks = Path(project_dir) / "index" / "chunks.json"
        flat_chunks = Path(project_dir) / "chunks.json"
        if legacy_chunks.exists() and not flat_chunks.exists():
            self._migrate_legacy(project_dir)

        dirs = self._dirs(project_dir)
        queue_dir = dirs["queue"]
        chunks_path = dirs["chunks"]
        vectors_path = dirs["vectors"]

        # ── 1. Load existing state ────────────────────────────────────────────
        existing_chunks: list[dict] = []
        if chunks_path.exists() and not force_rebuild:
            try:
                existing_chunks = json.loads(chunks_path.read_text())
                now_ts = int(time.time())
                for c in existing_chunks:
                    if not c.get('ts'):
                        c['ts'] = now_ts  # heal legacy chunks missing ts
                    if 'end_ts' not in c:
                        c['end_ts'] = c['ts']  # heal legacy chunks missing end_ts
            except Exception:
                pass

        existing_hashes: set[str] = {c["hash"] for c in existing_chunks}
        def _parse_list(val: object) -> list[str] | None:
            """Parse a frontmatter value that may be a JSON array string or already a list."""
            if val is None:
                return None
            if isinstance(val, list):
                return val
            try:
                parsed = json.loads(str(val))
                return parsed if isinstance(parsed, list) else None
            except Exception:
                return None

        # ── 2. Collect new chunks from queue ──────────────────────────────────
        queue_files = sorted(queue_dir.glob("*.md")) if queue_dir.exists() else []
        new_raw_chunks: list[dict] = []
        for md_file in queue_files:
            try:
                raw = md_file.read_text(encoding="utf-8", errors="replace")
                fm, text = _parse_frontmatter(raw)
                source = fm.get("source", "session")
                if source == "session":
                    chunks = chunk_by_turns(text, str(md_file))
                else:
                    # Observations, facts, and other non-session sources are stored as a
                    # single chunk — they have no turn-boundary markers.
                    body = text.strip()
                    if body:
                        chunk_hash = hashlib.sha256(body.encode()).hexdigest()[:16]
                        chunks = [{"text": body, "path": str(md_file), "hash": chunk_hash}]
                    else:
                        chunks = []
                for c in chunks:
                    c["project"]    = fm.get("project",    Path(project_dir).name)
                    c["source"]     = source
                    c["session_id"] = fm.get("session_id", None)
                    c["ts"]         = int(fm.get("ts", time.time()))
                    c["agent_tag"]  = fm.get("agent_tag",  "default")
                    c["end_ts"]     = int(fm.get("end_ts",   c["ts"]))
                    rf = _parse_list(fm.get("read_files"))
                    mf = _parse_list(fm.get("modified_files"))
                    wf = _parse_list(fm.get("written_files"))
                    if rf is not None:
                        c["read_files"] = rf
                    if mf is not None:
                        c["modified_files"] = mf
                    if wf is not None:
                        c["written_files"] = wf
                new_raw_chunks.extend(chunks)
            except Exception as e:
                print(f"EXCEPTION: [mmemory] Failed to read {md_file.name}: {e}\n" + traceback.format_exc(), file=sys.stderr, flush=True)


        # ── 2b. Upsert source:"file" chunks from session file arrays ──────────────
        # One chunk per unique path; update ts if path already exists in index.
        file_chunks_by_path: dict[str, dict] = {
            c['path']: c for c in existing_chunks if c.get('source') == 'file'
        }
        for c in existing_chunks + new_raw_chunks:
            if c.get('source', 'session') != 'session':
                continue
            ts = c.get('ts', int(time.time()))
            # Collect all three sets for this session chunk
            m_files = set(c.get('modified_files') or [])
            w_files = set(c.get('written_files')  or [])
            r_files = set(c.get('read_files')     or [])
            # Combine: W + R = M;  M + <any> = M
            all_paths = m_files | w_files | r_files
            for fpath in all_paths:
                in_m = fpath in m_files
                in_w = fpath in w_files
                in_r = fpath in r_files
                if in_m or (in_w and in_r):
                    action = 'modified'
                elif in_w:
                    action = 'written'
                else:
                    action = 'read'
                basename = Path(fpath).name
                h        = hashlib.md5(f'file:{fpath}'.encode()).hexdigest()
                existing = file_chunks_by_path.get(fpath)
                if existing is None or ts > existing.get('ts', 0):
                    file_chunks_by_path[fpath] = {
                        'hash':      h,
                        'text':      f'{basename} \u2014 {action}',
                        'action':    action,
                        'source':    'file',
                        'path':      fpath,
                        'project':   c.get('project', Path(project_dir).name),
                        'ts':        ts,
                        'end_ts':    ts,
                    }
        # Remove stale file chunks from existing; will be replaced by file_chunks_by_path values
        existing_chunks = [c for c in existing_chunks if c.get('source') != 'file']
        existing_hashes = {c['hash'] for c in existing_chunks}
        new_raw_chunks.extend(file_chunks_by_path.values())
        # ── 3. Filter to truly new chunks ─────────────────────────────────────
        new_chunks_by_hash = [c for c in new_raw_chunks if c["hash"] not in existing_hashes]
        # Observation and fact chunks are intentionally short — bypass the word-count floor.
        chunks_to_add = [
            c for c in new_chunks_by_hash
            if c.get("source", "session") not in ("session",) or len(c["text"].split()) >= MIN_CHUNK_WORDS
        ]
        low_content_dropped = len(new_chunks_by_hash) - len(chunks_to_add)
        if low_content_dropped:
            print(f"[mmemory] Dropped {low_content_dropped} low-content session chunk(s) (< {MIN_CHUNK_WORDS} words).",
                  file=sys.stderr, flush=True)

        if not chunks_to_add:
            # Nothing new to embed; still delete processed files and persist any healed ts values
            try:
                stored = json.loads(chunks_path.read_text()) if chunks_path.exists() else []
                needs_write = any(not c.get("ts") for c in stored)
                if needs_write:
                    tmp = chunks_path.with_suffix(".tmp.json")
                    tmp.write_text(json.dumps(existing_chunks, indent=2))
                    tmp.replace(chunks_path)
                    self._invalidate(project_dir)
            except Exception:
                pass
            for md_file in queue_files:
                try:
                    md_file.unlink()
                except Exception:
                    pass
            if queue_files:
                print(f"[mmemory] No new chunks (all hashes known). Deleted {len(queue_files)} queue file(s).",
                      file=sys.stderr, flush=True)
            return

        # ── 4. Embed new chunks ────────────────────────────────────────────────
        BATCH = 1000
        new_parts: list[np.ndarray] = []
        texts = [c["text"] for c in chunks_to_add]
        for b in range(0, len(texts), BATCH):
            batch = texts[b:b + BATCH]
            print(f"[mmemory] Embedding {b+1}-{b+len(batch)}/{len(texts)} new chunks", file=sys.stderr, flush=True)
            new_parts.append(np.array(list(self.model.embed(batch)), dtype=np.float32))
            self.last_activity = time.time()  # keep watchdog from firing mid-build
        new_vecs = np.vstack(new_parts) if len(new_parts) > 1 else new_parts[0]

        # ── 5. Load existing vectors and extend ───────────────────────────────
        if existing_chunks and vectors_path.exists() and not force_rebuild:
            try:
                old_vecs = load_file(str(vectors_path))["vectors"]
                all_vecs = np.vstack([old_vecs, new_vecs])
                all_chunks = existing_chunks + chunks_to_add
            except Exception:
                # Vectors file corrupt — re-embed everything including existing
                print("[mmemory] Vectors file unreadable; re-embedding all chunks.", file=sys.stderr, flush=True)
                all_chunks = existing_chunks + chunks_to_add
                all_texts = [c["text"] for c in all_chunks]
                re_parts: list[np.ndarray] = []
                for b in range(0, len(all_texts), BATCH):
                    re_parts.append(np.array(list(self.model.embed(all_texts[b:b + BATCH])), dtype=np.float32))
                    self.last_activity = time.time()
                all_vecs = np.vstack(re_parts) if len(re_parts) > 1 else re_parts[0]
        else:
            # Cases: force_rebuild or vectors file missing/absent.
            # In every case we must re-embed existing chunks — zero vectors produce
            # garbage cosine scores and must never be written to the index.
            all_chunks = existing_chunks + chunks_to_add
            all_texts = [c["text"] for c in all_chunks]
            re_parts: list[np.ndarray] = []
            for b in range(0, len(all_texts), BATCH):
                re_parts.append(np.array(list(self.model.embed(all_texts[b:b + BATCH])), dtype=np.float32))
                self.last_activity = time.time()
            all_vecs = np.vstack(re_parts) if len(re_parts) > 1 else (re_parts[0] if re_parts else np.zeros((0, 384), dtype=np.float32))

        # ── 6. Write atomically (temp → rename) ───────────────────────────────
        Path(project_dir).mkdir(parents=True, exist_ok=True)

        # chunks.json: write via temp file to avoid partial reads
        tmp_chunks = chunks_path.with_suffix(".tmp.json")
        tmp_chunks.write_text(json.dumps(all_chunks, indent=2))
        tmp_chunks.replace(chunks_path)

        # vectors.safetensors: write via temp file to match chunks.json atomicity
        tmp_vectors = vectors_path.with_suffix(".tmp.safetensors")
        save_file({"vectors": all_vecs}, str(tmp_vectors))
        tmp_vectors.replace(vectors_path)

        self.last_activity = time.time()  # build complete; reset idle window
        self.last_activity = time.time()  # build complete; reset idle window

        # ── 7. Delete processed queue files ───────────────────────────────────
        for md_file in queue_files:
            try:
                md_file.unlink()
            except Exception as e:
                print(f"[mmemory] Failed to delete queue file {md_file.name}: {e}", file=sys.stderr, flush=True)

        print(
            f"[mmemory] Build done: {len(all_chunks)} total chunks "
            f"({len(chunks_to_add)} new, {len(queue_files)} queue file(s) deleted).",
            file=sys.stderr, flush=True,
        )

        # ── Trigger vacuum if interval elapsed ───────────────────────────────────
        vcfg = getattr(self, '_vacuum_config', {})
        if vcfg.get('enabled', False):
            interval_hours = vcfg.get('interval_hours', 24)
            vacuum_state_path = Path(project_dir) / 'vacuum-state.json'
            last_vacuum = 0
            if vacuum_state_path.exists():
                try:
                    last_vacuum = json.loads(vacuum_state_path.read_text()).get('last_vacuum_ts', 0)
                except Exception:
                    pass
            if (time.time() - last_vacuum) > interval_hours * 3600:
                self._handle_vacuum({'project_dir': project_dir})

        return {
            "status": "ok",
            "new_chunks": len(chunks_to_add),
            "total_chunks": len(all_chunks),
            "deduped": len(new_raw_chunks) - len(chunks_to_add),
            "queue_deleted": len(queue_files),
        }
    def _handle_vacuum(self, req: dict) -> dict:
        project_dir = req.get('project_dir', '')
        if not project_dir:
            return {'error': 'project_dir required'}
        # Only one vacuum thread per project at a time
        attr = f'_vacuum_thread_{hashlib.md5(project_dir.encode()).hexdigest()[:8]}'
        existing_thread = getattr(self, attr, None)
        if existing_thread and existing_thread.is_alive():
            return {'status': 'already_running'}
        t = threading.Thread(target=self._run_vacuum, args=(project_dir, attr), daemon=True)
        setattr(self, attr, t)
        t.start()
        return {'status': 'accepted'}

    def _run_vacuum(self, project_dir: str, thread_attr: str) -> None:
        try:
            from mmemory_vacuum import VacuumWorker  # type: ignore
        except ImportError:
            print('[mmemory] VacuumWorker not available — vacuum skipped', file=sys.stderr, flush=True)
            return
        dirs = self._dirs(project_dir)
        tmp_dir = Path(project_dir) / 'tmp'
        tmp_dir.mkdir(exist_ok=True)
        # Clean stale tmp files older than 1 hour
        for f in tmp_dir.glob('*'):
            try:
                if time.time() - f.stat().st_mtime > 3600: f.unlink()
            except Exception: pass
        vcfg = getattr(self, '_vacuum_config', {})
        # Snapshot the hashes present BEFORE the worker runs. This is the baseline used
        # to detect genuinely new chunks added by concurrent builds during worker.run().
        # (Using the vacuum output to detect new arrivals is wrong: dropped chunks would
        # also appear "absent" from the output and get merged back in, defeating the purge.)
        pre_vacuum_hashes: set[str] = set()
        if dirs['chunks'].exists():
            try:
                pre_vacuum_hashes = {c['hash'] for c in json.loads(dirs['chunks'].read_text())}
            except Exception:
                pass
        # Run the worker outside the lock — it reads from live files but never writes to them.
        worker = VacuumWorker(dirs['chunks'], dirs['vectors'], tmp_dir, vcfg)
        try:
            new_chunks_path, new_vecs_path = worker.run()
        except Exception as e:
            print('EXCEPTION: [mmemory] Vacuum failed: ' + str(e) + '\n' + traceback.format_exc(), file=sys.stderr, flush=True)
            return
        # Under lock: merge any chunks added by concurrent builds (hash NOT in pre-vacuum set),
        # then atomically swap. Builds are blocked for the duration of this merge+swap.
        lock = self._build_locks.setdefault(project_dir, threading.Lock())
        with lock:
            # Re-read current DB to capture chunks written while worker.run() was executing
            current_main: list[dict] = []
            if dirs['chunks'].exists():
                try:
                    current_main = json.loads(dirs['chunks'].read_text())
                except Exception:
                    pass
            # New arrivals: chunks in current DB that were not present when vacuum started.
            # This excludes chunks vacuum intentionally dropped (they were in pre_vacuum_hashes).
            new_arrivals = [c for c in current_main if c.get('hash') not in pre_vacuum_hashes]
            if new_arrivals:
                new_hashes = {c['hash'] for c in new_arrivals}
                new_indices = [i for i, c in enumerate(current_main) if c.get('hash') in new_hashes]
                # Merge vectors for new_arrivals from current main DB vectors.
                # Guard: only include indices within the vector array bounds (chunks manually
                # appended to chunks.json without a corresponding embed have no vector row).
                if new_indices and dirs['vectors'].exists():
                    try:
                        from safetensors.numpy import load_file, save_file  # type: ignore
                        import numpy as np
                        main_vecs = load_file(str(dirs['vectors']))
                        main_arr = next(iter(main_vecs.values()))
                        n_vecs = len(main_arr)
                        valid_indices = [i for i in new_indices if i < n_vecs]
                        surviving_vecs = load_file(str(new_vecs_path))
                        surv_arr = next(iter(surviving_vecs.values()))
                        if valid_indices:
                            new_rows = main_arr[np.array(valid_indices)]
                            combined = np.concatenate([surv_arr, new_rows], axis=0)
                            save_file({'embeddings': combined}, str(new_vecs_path))
                        # Chunks without vectors (valid_indices empty / partial) will be
                        # re-embedded on the next build triggered by _invalidate.
                    except Exception as ve:
                        print('EXCEPTION: [mmemory] Vacuum vector merge failed: ' + str(ve) + '\n' + traceback.format_exc(), file=sys.stderr, flush=True)
                try:
                    surviving = json.loads(new_chunks_path.read_text())
                    new_chunks_path.write_text(json.dumps(surviving + new_arrivals))
                except Exception as ce:
                    print('EXCEPTION: [mmemory] Vacuum chunk merge failed: ' + str(ce) + '\n' + traceback.format_exc(), file=sys.stderr, flush=True)
            os.replace(new_chunks_path, dirs['chunks'])
            os.replace(new_vecs_path, dirs['vectors'])
            # Tiny window between the two os.replace calls where a cache-miss recall
            # could see new chunks + stale vectors. Acceptable at this scale.
            self._invalidate(project_dir)
        # Write vacuum-state.json after lock release (pure metadata, not a live DB file)
        vacuum_state_path = Path(project_dir) / 'vacuum-state.json'
        try:
            vacuum_state_path.write_text(json.dumps({'last_vacuum_ts': int(time.time())}))
        except Exception: pass
        print(f'[mmemory] Vacuum complete for {Path(project_dir).name}', file=sys.stderr, flush=True)
        setattr(self, thread_attr, None)

    def _handle_bm25(self, req: dict) -> dict:
        project_dir = req.get('project_dir', '')
        query = req.get('query', '')
        limit = req.get('limit', 10)
        if not project_dir or not query:
            return {'error': 'project_dir and query required'}
        dirs = self._dirs(project_dir)
        chunks = self._get_chunks(str(dirs['chunks']))
        idx = self._get_bm25(str(dirs['chunks']))
        raw = bm25_search(idx, query, limit * 2)
        results = [{'text': chunks[i].get('text', ''), 'source': chunks[i].get('source', 'session'),
                    'ts': chunks[i].get('ts', 0), 'score': s} for i, s in raw if i < len(chunks)]
        return {'results': results[:limit], 'query': query}

    def _handle_dedup_check(self, req: dict) -> dict:
        self._load_model()
        text: str = req.get("text", "")
        project_dir: str = req.get("project_dir", "")
        threshold: float = float(req.get("threshold", 0.92))

        if not text or not project_dir:
            return {"error": "text and project_dir required"}

        dirs = self._dirs(project_dir)
        emb = np.array(list(self.model.embed([text]))[0], dtype=np.float32)
        vecs = self._get_vectors(str(dirs["vectors"]))
        if vecs is None or len(vecs) == 0:
            return {"is_duplicate": False, "max_score": 0.0}
        scores = cosine_similarity(emb, vecs)
        max_score = float(np.max(scores))
        return {"is_duplicate": max_score >= threshold, "max_score": max_score}

    def _handle_embed(self, req: dict) -> dict:
        """Embed a list of texts. Returns vectors as nested lists (float32).

        Compatible with the semantic_server embed action so KB semantic-server
        can delegate to this server instead of loading its own model copy.
        """
        self._load_model()
        texts: list[str] = req.get("texts", [])
        if not texts:
            return {"error": "texts required"}
        vectors = [v.tolist() for v in self.model.embed(texts)]
        return {"vectors": vectors, "count": len(vectors)}

    def _handle_clear(self, req: dict) -> dict:
        """Remove chunks matching a date range or session ID from chunks.json.

        Runs under the per-project build lock so it cannot race with an in-flight build.
        Deletes vectors.safetensors after pruning so the index re-syncs with the
        trimmed chunks.json on the next build.
        Request fields:
          project_dir   required
          from_date     optional  YYYY-MM-DD  remove chunks on or after this date
          to_date       optional  YYYY-MM-DD  remove chunks on or before this date
          session_id    optional  str         remove chunks whose path contains this id
        """
        project_dir: str = req.get("project_dir", "")
        from_date: str | None = req.get("from_date")
        to_date: str | None = req.get("to_date")
        session_id: str | None = req.get("session_id")

        if not project_dir:
            return {"error": "project_dir required"}
        if not from_date and not to_date and not session_id:
            return {"error": "from_date, to_date, or session_id required"}

        with self._build_locks.setdefault(project_dir, threading.Lock()):
            dirs = self._dirs(project_dir)
            chunks_path = dirs["chunks"]
            vectors_path = dirs["vectors"]

            if not chunks_path.exists():
                return {"status": "ok", "deleted": 0, "remaining": 0}

            try:
                chunks = json.loads(chunks_path.read_text())
            except Exception as e:
                return {"error": f"failed to read chunks.json: {e}"}

            def should_keep(chunk: dict) -> bool:
                name = Path(chunk.get("path", "")).name
                if session_id and session_id in name:
                    return False
                if from_date or to_date:
                    file_date = date_from_filename(chunk.get("path", ""))
                    if file_date:
                        d = file_date.isoformat()
                        if from_date and d < from_date:
                            return True   # before range — keep
                        if to_date and d > to_date:
                            return True   # after range — keep
                        return False      # in range — remove
                return True

            keep = [c for c in chunks if should_keep(c)]
            deleted = len(chunks) - len(keep)

            if deleted > 0:
                tmp = chunks_path.with_suffix(".tmp.json")
                tmp.write_text(json.dumps(keep, indent=2))
                tmp.replace(chunks_path)
                # Vectors are now out of sync — remove so they rebuild on next recall
                vectors_path.unlink(missing_ok=True)
                self._invalidate(project_dir)
                print(
                    f"[mmemory] Clear: removed {deleted} chunk(s), {len(keep)} remain.",
                    file=sys.stderr, flush=True,
                )

            return {"status": "ok", "deleted": deleted, "remaining": len(keep)}


    def _handle_get_consolidation_chunks(self, req: dict) -> dict:
        """Return unprocessed session chunks for consolidation.

        Returns session chunks with ts > max(observation.end_ts).
        If count >= threshold, returns chunk texts+timestamps for LLM consolidation.
        If count < threshold, returns empty list with count.

        Request fields:
          project_dir  required
          threshold    required  int  min unprocessed turns to trigger
          max_turns    optional  int  cap on returned chunks (default 50)
        """
        project_dir: str = req.get('project_dir', '')
        threshold: int = int(req.get('threshold', 10))
        max_turns: int = int(req.get('max_turns', 50))

        if not project_dir:
            return {'error': 'project_dir required'}

        dirs = self._dirs(project_dir)
        chunks = self._get_chunks(str(dirs['chunks']))

        # Compute watermark: max end_ts across observation chunks
        obs_chunks = [c for c in chunks if c.get('source') == 'observation']
        last_obs_end_ts = max((c.get('end_ts', c.get('ts', 0)) for c in obs_chunks), default=0)

        # Get unprocessed session chunks (ts > watermark)
        unprocessed = [
            c for c in chunks
            if c.get('source') == 'session' and c.get('ts', 0) > last_obs_end_ts
        ]
        count = len(unprocessed)

        if count < threshold:
            return {'chunks': [], 'count': count, 'watermark': last_obs_end_ts}

        # Cap and sort by ts ascending (oldest first for LLM context)
        unprocessed.sort(key=lambda c: c.get('ts', 0))
        capped = unprocessed[:max_turns]

        return {
            'chunks': [
                {
                    'text': c.get('text', ''),
                    'ts': c.get('ts', 0),
                    'end_ts': c.get('end_ts', c.get('ts', 0)),
                    'path': c.get('path', ''),
                }
                for c in capped
            ],
            'count': count,
            'start_ts': capped[0].get('ts', 0),
            'end_ts': capped[-1].get('ts', 0),
            'watermark': last_obs_end_ts,
        }
    # ── Request dispatcher ────────────────────────────────────────────────────

    def _handle_injection_snapshot(self, req: dict) -> dict:
        """Return a structured snapshot for system prompt injection.

        Algorithm:
          1. sessions      = project chunks, source=session, ORDER ts DESC LIMIT session_limit → reversed
          2. anchor_ts     = min(ts) across sessions, or 0 if none
          3. observations  = source=observation, end_ts < anchor_ts (STRICT), ORDER end_ts DESC LIMIT obs_limit → reversed
          4. files         = source=file, ORDER ts DESC LIMIT file_limit → reversed
          5. Safety net: if total chars > max_chars, drop newest sessions only
             (observations and files are NEVER dropped)
        """
        project_dir     = req.get("project_dir", "")
        project         = req.get("project", "")
        session_limit   = int(req.get("session_limit",   5))
        obs_limit       = int(req.get("observation_limit", 3))
        file_limit      = int(req.get("file_limit",  5))
        max_chars       = int(req.get("max_chars",  8000))

        dirs   = self._dirs(project_dir)
        all_chunks = self._get_chunks(str(dirs["chunks"]))

        # Filter to project if specified
        if project:
            all_chunks = [c for c in all_chunks if c.get("project") == project]

        def _fmt(c: dict) -> dict:
            """Return the fields relevant for injection."""
            out: dict = {"text": c.get("text", ""), "ts": c.get("ts", 0)}
            if c.get("end_ts") is not None: out["end_ts"] = c["end_ts"]
            if c.get("path"):               out["path"]   = c["path"]
            if c.get("date"):               out["date"]   = c["date"]
            if c.get("action"):             out["action"]  = c["action"]
            return out

        # Step 1 — sessions
        sess_chunks = sorted(
            [c for c in all_chunks if c.get("source") == "session"],
            key=lambda c: c.get("ts", 0), reverse=True
        )[:session_limit]
        sess_chunks = list(reversed(sess_chunks))  # oldest→newest

        # Step 2 — anchor
        anchor_ts = min((c.get("ts", 0) for c in sess_chunks), default=0)

        # Step 3 — observations (strict boundary)
        # Include obs whose end_ts predates the session window (dedup: obs already
        # summarised those sessions so showing them again wastes tokens).
        # Fallback: if the strict filter returns nothing, the DB may be small (all sessions
        # in window). Only fall back when obs actually overlap with the session ts range
        # — i.e. obs.end_ts <= max(session.ts). This avoids including future observations
        # that simply haven't been reached yet.
        all_obs = [c for c in all_chunks if c.get("source") == "observation"]
        obs_chunks = sorted(
            [c for c in all_obs if c.get("end_ts", 0) < anchor_ts],
            key=lambda c: c.get("end_ts", 0), reverse=True
        )[:obs_limit]
        if not obs_chunks and all_obs and sess_chunks:
            max_sess_ts = max(c.get("ts", 0) for c in sess_chunks)
            # Obs that overlap with the session ts range (end_ts within [anchor_ts, max_sess_ts])
            overlapping = [c for c in all_obs if anchor_ts <= c.get("end_ts", 0) <= max_sess_ts]
            if overlapping:
                # Window covers all sessions — include K most recent overlapping obs
                obs_chunks = sorted(overlapping, key=lambda c: c.get("end_ts", 0), reverse=True)[:obs_limit]
        obs_chunks = list(reversed(obs_chunks))  # oldest→newest

        # Step 4 — files
        file_chunks = sorted(
            [c for c in all_chunks if c.get("source") == "file"],
            key=lambda c: c.get("ts", 0), reverse=True
        )[:file_limit]
        file_chunks = list(reversed(file_chunks))  # oldest→newest

        # Step 5 — safety net: drop newest sessions only
        total = sum(len(c.get("text", "")) for c in sess_chunks + obs_chunks + file_chunks)
        while total > max_chars and sess_chunks:
            dropped = sess_chunks.pop()  # drop newest (last after reversal)
            total  -= len(dropped.get("text", ""))

        return {
            "status":       "ok",
            "sessions":     [_fmt(c) for c in sess_chunks],
            "observations": [_fmt(c) for c in obs_chunks],
            "files":        [_fmt(c) for c in file_chunks],
            "anchor_ts":    anchor_ts,
        }


    def _handle_request(self, data: str) -> dict:
        try:
            req = json.loads(data)
        except json.JSONDecodeError:
            return {"error": "invalid JSON"}

        action = req.get("action", "")
        handler = {
            "ping":         self._handle_ping,
            "shutdown":     self._handle_shutdown,
            "recall":       self._handle_recall,
            "build":        self._handle_build,
            "rebuild":      lambda r: self._handle_build({**r, "force_rebuild": True}),
            "clear":        self._handle_clear,
            "dedup_check":  self._handle_dedup_check,
            "embed":        self._handle_embed,
            "bm25":         self._handle_bm25,
            "vacuum":                    self._handle_vacuum,
            "get_consolidation_chunks":  self._handle_get_consolidation_chunks,
            "get_injection_snapshot":    self._handle_injection_snapshot,
        }.get(action)
        if not handler:
            return {"error": f"unknown action: {action}"}

        self.last_activity = time.time()
        try:
            return handler(req)
        except Exception as e:
            tb = traceback.format_exc()
            print(f"EXCEPTION: [mmemory] request handler: {e}\n{tb}", file=sys.stderr, flush=True)
            return {"error": str(e), "traceback": tb}

    # ── Client connection ─────────────────────────────────────────────────────

    def _handle_client(self, conn: socket.socket, _addr: tuple) -> None:
        try:
            buf = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    resp = self._handle_request(line.decode("utf-8"))
                    conn.sendall(json.dumps(resp).encode("utf-8") + b"\n")
                    if resp.get("message") == "shutting down":
                        return
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            conn.close()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def _idle_watchdog(self) -> None:
        while self.running:
            time.sleep(5)
            # Don't terminate while any vacuum thread is running
            for attr in dir(self):
                if attr.startswith('_vacuum_thread_'):
                    t = getattr(self, attr, None)
                    if t and t.is_alive():
                        self.last_activity = time.time()  # reset idle timer
                        break
            if time.time() - self.last_activity > self.timeout:
                print(f"[mmemory] Idle timeout ({self.timeout}s). Shutting down.", file=sys.stderr, flush=True)
                self.running = False
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.connect(("127.0.0.1", self.port))
                    s.close()
                except OSError:
                    pass
                break

    def run(self) -> None:
        if not self._acquire_singleton():
            return

        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # Windows SO_REUSEADDR allows multiple sockets to bind the same port —
        # the wrong behaviour for a singleton server. Use SO_EXCLUSIVEADDRUSE on
        # Windows so only one socket can own the port at a time.
        if sys.platform == "win32":
            SO_EXCLUSIVEADDRUSE = ~socket.SO_REUSEADDR  # (int)(~SO_REUSEADDR) per winsock2.h
            srv.setsockopt(socket.SOL_SOCKET, SO_EXCLUSIVEADDRUSE, 1)
        else:
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind(("127.0.0.1", self.port))
        except OSError:
            print(f"[mmemory] Port {self.port} already bound — exiting (lost bind race).",
                  file=sys.stderr, flush=True)
            srv.close()
            return
        srv.listen(8)
        srv.settimeout(1.0)
        self.port = srv.getsockname()[1]

        print(f"[mmemory] PID {os.getpid()} listening on 127.0.0.1:{self.port}", file=sys.stderr, flush=True)

        watchdog = threading.Thread(target=self._idle_watchdog, daemon=True)
        watchdog.start()

        while self.running:
            try:
                conn, addr = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if not self.running:
                conn.close()
                break
            threading.Thread(target=self._handle_client, args=(conn, addr), daemon=True).start()

        srv.close()
        if self.pid_file and self.pid_file.exists():
            try:
                self.pid_file.unlink()
            except OSError:
                pass
        print("[mmemory] Stopped.", file=sys.stderr, flush=True)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    # Lower process priority — the server is background infrastructure.
    # Embedding runs in a background thread with os.nice(10); set the whole
    # process to BELOW_NORMAL so even the TCP loop doesn't compete with omp.
    try:
        if sys.platform == "win32":
            import ctypes
            BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            ctypes.windll.kernel32.SetPriorityClass(  # type: ignore[attr-defined]
                ctypes.windll.kernel32.GetCurrentProcess(),  # type: ignore[attr-defined]
                BELOW_NORMAL_PRIORITY_CLASS,
            )
        else:
            os.nice(5)
    except Exception:
        pass  # non-fatal; priority is a best-effort hint

    port = 49200
    timeout = DEFAULT_TIMEOUT
    log_file: str | None = None
    pid_file: str | None = None
    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1]); i += 2
        elif sys.argv[i] == "--timeout" and i + 1 < len(sys.argv):
            timeout = int(sys.argv[i + 1]); i += 2
        elif sys.argv[i] == "--log-file" and i + 1 < len(sys.argv):
            log_file = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--pid-file" and i + 1 < len(sys.argv):
            pid_file = sys.argv[i + 1]; i += 2
        else:
            i += 1

    if log_file:
        import pathlib
        pathlib.Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        log_fh = open(log_file, "a", buffering=1, encoding="utf-8")  # noqa: SIM115
        sys.stderr = log_fh  # type: ignore[assignment]

    MmemoryServer(port, timeout, Path(pid_file) if pid_file else None).run()


if __name__ == "__main__":
    main()
