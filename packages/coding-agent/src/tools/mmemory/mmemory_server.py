#!/usr/bin/env python3
"""mmemory recall server.

Inspired by Hindsight (https://github.com/vectorize-io/hindsight) by Vectorize — Apache 2.0.
The 5-dimension fact extraction schema (what/when/where/who/why), scoping model, and
retain_mission concept are derived from Hindsight's design.

TCP socket server, line-delimited JSON protocol (localhost only).
Holds the fastembed model in memory for fast repeated recall.
Auto-stops after idle timeout. Prints READY:<port> to stdout.

Storage layout (managed by this server):
    project_dir/
      queue/                 transient .md files; deleted after build
      index/
        chunks.json          DURABLE STORE — full chunk texts, append-only
        vectors.safetensors  rebuildable from chunks.json
        vectors.meta.json    {model, count} for rebuild validation

Build contract:
    1. Read all queue/*.md, parse into turn-boundary chunks
    2. Filter chunks whose hash already exists in chunks.json (skip)
    3. Embed new chunks, append to chunks.json, extend vectors
    4. Delete processed .md files
    5. Invalidate in-memory cache

Protocol:
    Request:  {"action": "ping|recall|build|rebuild|dedup_check|shutdown", ...}\\n
    Response: {"status": "ok", ...}\\n

Actions:
    ping          Health check.
    recall        Parallel BM25+semantic retrieval with RRF merge + recency boost.
    build         Background build: queue → chunks.json + vectors, delete .md files.
    rebuild       Force full re-embed of all chunks in chunks.json (model change etc.).
    dedup_check   Check cosine similarity for a text against existing vectors.
    shutdown      Graceful stop.

Usage:
    python mmemory_server.py                     # random port (prints READY:<port>)
    python mmemory_server.py --port 19385        # fixed port
    python mmemory_server.py --timeout 10        # idle timeout in minutes
"""

import collections
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

DEFAULT_TIMEOUT = 10  # minutes
MODEL_NAME = "BAAI/bge-small-en-v1.5"
MODEL_CACHE = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".cache"))) / "fastembed"

if sys.platform == "win32":
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
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


# ── BM25 ─────────────────────────────────────────────────────────────────────

def tokenize(text: str) -> list[str]:
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    return [t.lower() for t in re.sub(r"[^a-zA-Z0-9]", " ", text).split() if len(t) > 1]


def build_bm25_index(chunks: list[dict]) -> dict:
    k1, b = 1.5, 0.75
    N = len(chunks)
    if N == 0:
        return {"N": 0, "df": {}, "doc_tfs": [], "doc_lengths": [], "avg_dl": 1, "k1": k1, "b": b}
    doc_tfs, doc_lengths = [], []
    df: dict[str, int] = collections.Counter()  # type: ignore[assignment]
    for c in chunks:
        tf: dict[str, int] = collections.Counter(tokenize(c.get("text", "")))  # type: ignore[assignment]
        doc_tfs.append(tf)
        doc_lengths.append(sum(tf.values()))
        for t in tf:
            df[t] = df.get(t, 0) + 1
    avg_dl = sum(doc_lengths) / N
    # H5 fix: require at least 2 docs to share a term before pruning
    threshold = max(2, N * 0.5)
    df = {t: c for t, c in df.items() if c < threshold}  # type: ignore[assignment]
    return {"N": N, "df": df, "doc_tfs": doc_tfs, "doc_lengths": doc_lengths,
            "avg_dl": avg_dl, "k1": k1, "b": b}


def bm25_search(index: dict, query: str, top_k: int = 20) -> list[tuple[int, float]]:
    k1, b, N, avg_dl = index["k1"], index["b"], index["N"], index["avg_dl"]
    if N == 0:
        return []
    qterms = [t for t in tokenize(query) if t in index["df"]]
    if not qterms:
        return []
    scores = []
    for i, (tf, dl) in enumerate(zip(index["doc_tfs"], index["doc_lengths"])):
        score = 0.0
        for t in qterms:
            if tf.get(t, 0) == 0:
                continue
            idf = math.log((N - index["df"][t] + 0.5) / (index["df"][t] + 0.5) + 1)
            tf_norm = tf[t] * (k1 + 1) / (tf[t] + k1 * (1 - b + b * dl / avg_dl))
            score += idf * tf_norm
        if score > 0:
            scores.append((i, score))
    return sorted(scores, key=lambda x: x[1], reverse=True)[:top_k]


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


# ── Server ───────────────────────────────────────────────────────────────────

class MmemoryServer:
    def __init__(self, port: int, timeout_minutes: int) -> None:
        self.port = port
        self.timeout = timeout_minutes * 60
        self.last_activity = time.time()
        self.running = True
        self.model = None

        # In-memory caches keyed by index file path
        self._chunks_cache: dict[str, list[dict]] = {}
        self._vectors_cache: dict[str, np.ndarray] = {}
        self._bm25_cache: dict[str, dict] = {}

        self._build_lock = threading.Lock()
        # Coalescing: project dirs that arrived while a build was in flight
        self._pending_build: set[str] = set()

    # ── Model ────────────────────────────────────────────────────────────────

    def _load_model(self) -> None:
        if self.model is not None:
            return
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
            "index":        p / "index",
            "chunks":       p / "index" / "chunks.json",
            "vectors":      p / "index" / "vectors.safetensors",
            "vectors_meta": p / "index" / "vectors.meta.json",
        }

    # ── Cache helpers ────────────────────────────────────────────────────────

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
            print(f"[mmemory] Failed to load vectors: {e}", file=sys.stderr, flush=True)
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
        return {
            "status": "ok",
            "pid": os.getpid(),
            "port": self.port,
            "model_loaded": self.model is not None,
            "cached_projects": len(self._chunks_cache),
        }

    def _handle_shutdown(self, req: dict) -> dict:
        self.running = False
        return {"status": "ok", "message": "shutting down"}

    def _handle_recall(self, req: dict) -> dict:
        self._load_model()
        query: str = req.get("query", "")
        project_dir: str = req.get("project_dir", "")
        limit: int = req.get("limit", 10)
        recency_weight: float = req.get("recency_weight", 0.3)
        scope: str = req.get("scope", "per-project")
        project: str = req.get("project", "")

        if not query or not project_dir:
            return {"error": "query and project_dir required"}

        dirs = self._dirs(project_dir)
        chunks_path = str(dirs["chunks"])
        vectors_path = str(dirs["vectors"])

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
        chunks = self._get_chunks(chunks_path)

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
            score = (rrf_score * math.exp(-max(0, (today - file_date).days) / 30 * recency_weight)
                     if file_date else rrf_score)

            if scope in ("per-project", "per-project-tagged"):
                if project and project.lower() not in chunk_path.lower():
                    continue

            results.append({"text": text, "path": chunk_path, "score": score, "when": chunk.get("when")})
            if len(results) >= limit:
                break

        results.sort(key=lambda r: r["score"], reverse=True)
        return {"results": results[:limit], "query": query}

    def _handle_build(self, req: dict) -> dict:
        """Fire-and-forget build with coalescing."""
        project_dir: str = req.get("project_dir", "")
        dedup_threshold: float = float(req.get("dedup_threshold", 0.92))
        force_rebuild: bool = req.get("force_rebuild", False)

        if not project_dir:
            return {"error": "project_dir required"}

        if self._build_lock.locked():
            self._pending_build.add(project_dir)
            return {"status": "accepted", "note": "coalesced"}

        def _do() -> None:
            with self._build_lock:
                try:
                    os.nice(10)
                except AttributeError:
                    pass
                self._run_build(project_dir, dedup_threshold, force_rebuild)
                self._invalidate(project_dir)

            # Drain any builds that arrived while this one ran
            while self._pending_build:
                pending = self._pending_build.copy()
                self._pending_build.clear()
                for pdir in pending:
                    with self._build_lock:
                        try:
                            os.nice(10)
                        except AttributeError:
                            pass
                        self._run_build(pdir, dedup_threshold, False)
                        self._invalidate(pdir)

        threading.Thread(target=_do, daemon=True).start()
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

        dirs = self._dirs(project_dir)
        queue_dir = dirs["queue"]
        index_dir = dirs["index"]
        chunks_path = dirs["chunks"]
        vectors_path = dirs["vectors"]
        vectors_meta_path = dirs["vectors_meta"]

        # ── 1. Load existing state ────────────────────────────────────────────
        existing_chunks: list[dict] = []
        if chunks_path.exists() and not force_rebuild:
            try:
                existing_chunks = json.loads(chunks_path.read_text())
            except Exception:
                pass

        existing_hashes: set[str] = {c["hash"] for c in existing_chunks}

        # Check model consistency — if model changed, re-embed everything
        old_model = ""
        if vectors_meta_path.exists():
            try:
                old_model = json.loads(vectors_meta_path.read_text()).get("model", "")
            except Exception:
                pass
        if old_model and old_model != MODEL_NAME:
            print(f"[mmemory] Model changed ({old_model} → {MODEL_NAME}), full re-embed.", file=sys.stderr, flush=True)
            existing_hashes = set()  # force re-embed of all existing chunks

        # ── 2. Collect new chunks from queue ──────────────────────────────────
        queue_files = sorted(queue_dir.glob("*.md")) if queue_dir.exists() else []
        new_raw_chunks: list[dict] = []
        for md_file in queue_files:
            try:
                text = md_file.read_text(encoding="utf-8", errors="replace")
                new_raw_chunks.extend(chunk_by_turns(text, str(md_file)))
            except Exception as e:
                print(f"[mmemory] Failed to read {md_file.name}: {e}", file=sys.stderr, flush=True)

        # ── 3. Filter to truly new chunks ─────────────────────────────────────
        chunks_to_add = [c for c in new_raw_chunks if c["hash"] not in existing_hashes]

        if not chunks_to_add:
            # Nothing new to embed; still delete processed files
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
        new_vecs = np.vstack(new_parts) if len(new_parts) > 1 else new_parts[0]

        # ── 5. Load existing vectors and extend ───────────────────────────────
        if existing_chunks and vectors_path.exists() and not force_rebuild and not (old_model and old_model != MODEL_NAME):
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
                all_vecs = np.vstack(re_parts) if len(re_parts) > 1 else re_parts[0]
        else:
            # Cases: force_rebuild, model changed, or vectors file missing.
            # In every case we must re-embed existing chunks — zero vectors produce
            # garbage cosine scores and must never be written to the index.
            all_chunks = existing_chunks + chunks_to_add
            all_texts = [c["text"] for c in all_chunks]
            re_parts: list[np.ndarray] = []
            for b in range(0, len(all_texts), BATCH):
                re_parts.append(np.array(list(self.model.embed(all_texts[b:b + BATCH])), dtype=np.float32))
            all_vecs = np.vstack(re_parts) if len(re_parts) > 1 else (re_parts[0] if re_parts else np.zeros((0, 384), dtype=np.float32))

        # ── 6. Write atomically (temp → rename) ───────────────────────────────
        index_dir.mkdir(parents=True, exist_ok=True)

        # chunks.json: write via temp file to avoid partial reads
        tmp_chunks = chunks_path.with_suffix(".tmp.json")
        tmp_chunks.write_text(json.dumps(all_chunks, indent=2))
        tmp_chunks.replace(chunks_path)

        # vectors.safetensors
        save_file({"vectors": all_vecs}, str(vectors_path))

        # meta: model name + count for rebuild validation
        vectors_meta_path.write_text(json.dumps({
            "model": MODEL_NAME,
            "count": len(all_chunks),
            "built": datetime.now().isoformat(),
        }, indent=2))

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


    def _handle_clear(self, req: dict) -> dict:
        """Remove chunks matching a date range or session ID from chunks.json.

        Runs under _build_lock so it cannot race with an in-flight build.
        Deletes vectors.safetensors and vectors.meta.json after pruning so the
        index re-syncs with the trimmed chunks.json on the next build.

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

        with self._build_lock:
            dirs = self._dirs(project_dir)
            chunks_path = dirs["chunks"]
            vectors_path = dirs["vectors"]
            vectors_meta_path = dirs["vectors_meta"]

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
                vectors_meta_path.unlink(missing_ok=True)
                self._invalidate(project_dir)
                print(
                    f"[mmemory] Clear: removed {deleted} chunk(s), {len(keep)} remain.",
                    file=sys.stderr, flush=True,
                )

            return {"status": "ok", "deleted": deleted, "remaining": len(keep)}

    # ── Request dispatcher ────────────────────────────────────────────────────

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
        }.get(action)
        if not handler:
            return {"error": f"unknown action: {action}"}

        self.last_activity = time.time()
        try:
            return handler(req)
        except Exception as e:
            return {"error": str(e)}

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
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", self.port))
        srv.listen(8)
        srv.settimeout(1.0)
        self.port = srv.getsockname()[1]

        print(f"READY:{self.port}", flush=True)
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

    port = 0
    timeout = DEFAULT_TIMEOUT
    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1]); i += 2
        elif sys.argv[i] == "--timeout" and i + 1 < len(sys.argv):
            timeout = int(sys.argv[i + 1]); i += 2
        else:
            i += 1
    MmemoryServer(port, timeout).run()


if __name__ == "__main__":
    main()
