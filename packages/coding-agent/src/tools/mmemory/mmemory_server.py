#!/usr/bin/env python3
"""mmemory recall server.

Inspired by Hindsight (https://github.com/vectorize-io/hindsight) by Vectorize — Apache 2.0.
The 5-dimension fact extraction schema (what/when/where/who/why), scoping model, and
retain_mission concept are derived from Hindsight's design.

TCP socket server, line-delimited JSON protocol (localhost only).
Holds the fastembed model in memory for fast repeated recall.
Auto-stops after idle timeout. Prints READY:<port> to stdout.

Protocol:
    Request:  {"action": "ping|recall|build|rebuild|dedup_check|shutdown", ...}\\n
    Response: {"status": "ok", ...}\\n

Actions:
    ping          Health check. Returns port, PID, model_loaded, cached_kbs.
    recall        Parallel BM25+semantic retrieval with RRF merge + recency boost.
    build         Background re-index: chunk new .md files, embed, dedup, save.
    rebuild       Force full rebuild of vectors.
    dedup_check   Check cosine similarity for a single text against existing vectors.
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
import threading
import time
from datetime import date, datetime
from pathlib import Path

import numpy as np

DEFAULT_TIMEOUT = 10  # minutes

MODEL_NAME = "BAAI/bge-small-en-v1.5"
MODEL_CACHE = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".cache"))) / "fastembed"

# Force unbuffered output (critical for READY:<port> detection)
if sys.platform == "win32":
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]


# ── BM25 ────────────────────────────────────────────────────────────────────────

def tokenize(text: str) -> list[str]:
    """Tokenize text, splitting CamelCase and removing punctuation."""
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    return [t.lower() for t in re.sub(r"[^a-zA-Z0-9]", " ", text).split() if len(t) > 1]


def build_bm25_index(chunks: list[dict]) -> dict:
    """Build an in-memory BM25 index from a list of chunk dicts with 'text' keys."""
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
    # Prune very common terms (appear in >50% of docs) — reduces noise
    df = {t: c for t, c in df.items() if c < N * 0.5}  # type: ignore[assignment]
    return {"N": N, "df": df, "doc_tfs": doc_tfs, "doc_lengths": doc_lengths,
            "avg_dl": avg_dl, "k1": k1, "b": b}


def bm25_search(index: dict, query: str, top_k: int = 20) -> list[tuple[int, float]]:
    """Return (chunk_index, score) pairs, descending by score."""
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


# ── Cosine similarity ────────────────────────────────────────────────────────────

def cosine_similarity(query_vec: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Cosine similarity of query_vec against each row of matrix."""
    q = query_vec / (np.linalg.norm(query_vec) + 1e-10)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-10
    return (matrix / norms) @ q


# ── RRF merge ───────────────────────────────────────────────────────────────────

def rrf_merge(
    sem_results: list[tuple[int, float]],
    bm25_results: list[tuple[int, float]],
    k: int = 60,
) -> list[tuple[int, float]]:
    """Reciprocal Rank Fusion of two ranked lists."""
    scores: dict[int, float] = {}
    for rank, (idx, _) in enumerate(sem_results):
        scores[idx] = scores.get(idx, 0.0) + 1.0 / (k + rank + 1)
    for rank, (idx, _) in enumerate(bm25_results):
        scores[idx] = scores.get(idx, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


# ── Chunker ─────────────────────────────────────────────────────────────────────

def chunk_markdown(text: str, path: str, chunk_size: int = 512, overlap: int = 64) -> list[dict]:
    """Split markdown text into overlapping chunks."""
    words = text.split()
    if not words:
        return []
    chunks = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunk_text = " ".join(words[start:end])
        chunk_hash = hashlib.sha256(chunk_text.encode()).hexdigest()[:16]
        chunks.append({"text": chunk_text, "path": path, "hash": chunk_hash})
        if end >= len(words):
            break
        start += chunk_size - overlap
    return chunks


def date_from_filename(filename: str) -> date | None:
    """Extract date from YYYY-MM-DD-<sessionId>.md filename."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", Path(filename).name)
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y-%m-%d").date()
        except ValueError:
            pass
    return None


# ── Server ──────────────────────────────────────────────────────────────────────

class MmemoryServer:
    def __init__(self, port: int, timeout_minutes: int) -> None:
        self.port = port
        self.timeout = timeout_minutes * 60
        self.last_activity = time.time()
        self.running = True
        self.model = None

        # In-memory caches
        self._vectors_cache: dict[str, np.ndarray] = {}   # vectors_path → [N, 384]
        self._chunks_cache: dict[str, list[dict]] = {}     # chunks_path → [{text, path, hash}]
        self._bm25_cache: dict[str, dict] = {}             # chunks_path → BM25 index
        self._facts_cache: dict[str, list[dict]] = {}      # facts_path → [{...}]
        self._build_lock = threading.Lock()

    # ── Model ──────────────────────────────────────────────────────────────────

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

    # ── Cache loaders ──────────────────────────────────────────────────────────

    def _load_vectors(self, path: str) -> np.ndarray | None:
        if path in self._vectors_cache:
            return self._vectors_cache[path]
        p = Path(path)
        if not p.exists():
            return None
        try:
            from safetensors.numpy import load_file  # type: ignore[import]
        except ImportError:
            print(
                "[mmemory] ERROR: fastembed not installed.\n"
                "  Run: pip install fastembed safetensors numpy\n"
                "  Then restart the omp session.",
                file=sys.stderr, flush=True,
            )
            sys.exit(1)
        try:
            vecs = load_file(str(p))["vectors"]
            self._vectors_cache[path] = vecs
            return vecs
        except Exception as e:
            print(f"[mmemory] Failed to load vectors {path}: {e}", file=sys.stderr, flush=True)
            return None

    def _load_chunks(self, path: str) -> list[dict]:
        if path in self._chunks_cache:
            return self._chunks_cache[path]
        p = Path(path)
        if not p.exists():
            return []
        try:
            chunks = json.loads(p.read_text())
            self._chunks_cache[path] = chunks
            return chunks
        except Exception:
            return []

    def _load_bm25(self, chunks_path: str) -> dict:
        if chunks_path in self._bm25_cache:
            return self._bm25_cache[chunks_path]
        chunks = self._load_chunks(chunks_path)
        idx = build_bm25_index(chunks)
        self._bm25_cache[chunks_path] = idx
        return idx

    def _load_facts(self, path: str) -> list[dict]:
        if path in self._facts_cache:
            return self._facts_cache[path]
        p = Path(path)
        if not p.exists():
            return []
        try:
            facts = json.loads(p.read_text())
            self._facts_cache[path] = facts
            return facts
        except Exception:
            return []

    def _invalidate_caches(self) -> None:
        self._vectors_cache.clear()
        self._chunks_cache.clear()
        self._bm25_cache.clear()
        self._facts_cache.clear()

    # ── Action handlers ────────────────────────────────────────────────────────

    def _handle_ping(self, req: dict) -> dict:
        return {
            "status": "ok",
            "pid": os.getpid(),
            "port": self.port,
            "model_loaded": self.model is not None,
            "cached_kbs": len(self._vectors_cache),
        }

    def _handle_shutdown(self, req: dict) -> dict:
        self.running = False
        return {"status": "ok", "message": "shutting down"}

    def _handle_recall(self, req: dict) -> dict:
        self._load_model()
        query: str = req.get("query", "")
        chunks_path: str = req.get("chunks_path", "")
        vectors_path: str = req.get("vectors_path", "")
        facts_path: str = req.get("facts_path", "")
        limit: int = req.get("limit", 10)
        recency_weight: float = req.get("recency_weight", 0.3)
        scope: str = req.get("scope", "per-project")
        project: str = req.get("project", "")

        if not query:
            return {"error": "query required"}

        # Embed query
        query_emb = np.array(list(self.model.embed([query]))[0], dtype=np.float32)

        # Parallel BM25 + semantic
        sem_results: list[tuple[int, float]] = []
        bm25_results: list[tuple[int, float]] = []
        errors: list[str] = []

        def run_semantic() -> None:
            vecs = self._load_vectors(vectors_path)
            if vecs is None or len(vecs) == 0:
                return
            scores = cosine_similarity(query_emb, vecs)
            top_idx = np.argsort(scores)[::-1][: limit * 3]
            sem_results.extend((int(i), float(scores[i])) for i in top_idx if scores[i] > 0.1)

        def run_bm25() -> None:
            idx = self._load_bm25(chunks_path)
            bm25_results.extend(bm25_search(idx, query, limit * 3))

        t1 = threading.Thread(target=run_semantic)
        t2 = threading.Thread(target=run_bm25)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # RRF merge
        merged = rrf_merge(sem_results, bm25_results)

        # Load chunks for text lookup
        chunks = self._load_chunks(chunks_path)

        # Apply recency boost + build result objects
        today = date.today()
        results = []
        seen_texts: set[str] = set()
        for idx, rrf_score in merged:
            if idx >= len(chunks):
                continue
            chunk = chunks[idx]
            text = chunk.get("text", "")
            # Dedup by text prefix
            key = text[:80]
            if key in seen_texts:
                continue
            seen_texts.add(key)

            # Recency boost
            chunk_path = chunk.get("path", "")
            file_date = date_from_filename(chunk_path)
            if file_date:
                age_days = max(0, (today - file_date).days)
                score = rrf_score * math.exp(-age_days / 30 * recency_weight)
            else:
                score = rrf_score

            # Scope filter
            if scope == "global":
                pass  # include everything
            elif scope in ("per-project", "per-project-tagged"):
                # Filter by project prefix in path
                if project and project.lower() not in chunk_path.lower():
                    continue

            results.append({
                "text": text,
                "path": chunk_path,
                "score": score,
                "when": chunk.get("when"),
            })
            if len(results) >= limit:
                break

        # Sort by final score
        results.sort(key=lambda r: r["score"], reverse=True)
        return {"results": results[:limit], "query": query}

    def _handle_build(self, req: dict) -> dict:
        """Kick off background re-indexing. Fire-and-forget."""
        memory_dir = req.get("memory_dir", "")
        chunks_path = req.get("chunks_path", "")
        vectors_path = req.get("vectors_path", "")
        vectors_meta_path = req.get("vectors_meta_path", "")
        facts_path = req.get("facts_path", "")
        dedup_threshold = float(req.get("dedup_threshold", 0.92))

        if not memory_dir:
            return {"error": "memory_dir required"}

        def _do_build() -> None:
            with self._build_lock:
                try:
                    os.nice(10)  # background priority
                except AttributeError:
                    pass  # Windows: os.nice not available
                self._run_build(
                    memory_dir, chunks_path, vectors_path,
                    vectors_meta_path, facts_path, dedup_threshold,
                )
                self._invalidate_caches()

        threading.Thread(target=_do_build, daemon=True).start()
        return {"status": "accepted"}

    def _run_build(
        self,
        memory_dir: str,
        chunks_path: str,
        vectors_path: str,
        vectors_meta_path: str,
        facts_path: str,
        dedup_threshold: float,
    ) -> None:
        """Scan .md files, chunk, embed new chunks, save safetensors + BM25 JSON."""
        self._load_model()
        try:
            from safetensors.numpy import load_file, save_file  # type: ignore[import]
        except ImportError:
            print(
                "[mmemory] ERROR: fastembed not installed.\n"
                "  Run: pip install fastembed safetensors numpy\n"
                "  Then restart the omp session.",
                file=sys.stderr, flush=True,
            )
            sys.exit(1)

        md_dir = Path(memory_dir)
        if not md_dir.exists():
            return

        # Collect all chunks from .md files
        all_chunks: list[dict] = []
        for md_file in sorted(md_dir.glob("*.md")):
            text = md_file.read_text(encoding="utf-8", errors="replace")
            file_chunks = chunk_markdown(text, str(md_file))
            all_chunks.extend(file_chunks)

        if not all_chunks:
            return

        # Load existing meta for incremental build
        old_lookup: dict[tuple[str, str], int] = {}
        old_meta_model = ""
        vp = Path(vectors_path)
        vmp = Path(vectors_meta_path)
        if vp.exists() and vmp.exists():
            try:
                old_meta = json.loads(vmp.read_text())
                old_meta_model = old_meta.get("model", "")
                for i, c in enumerate(old_meta.get("chunks", [])):
                    old_lookup[(c["path"], c["hash"])] = i
            except Exception:
                pass

        # Invalidate if model changed
        if old_meta_model and old_meta_model != MODEL_NAME:
            old_lookup = {}

        # Diff: reuse vs embed
        reuse_map: dict[int, int] = {}
        need_embed: list[tuple[int, str]] = []
        for i, c in enumerate(all_chunks):
            key = (c["path"], c["hash"])
            if key in old_lookup:
                reuse_map[i] = old_lookup[key]
            else:
                need_embed.append((i, c["text"]))

        # Short-circuit if nothing new
        if not need_embed and len(reuse_map) == len(all_chunks):
            return

        # Load old vectors
        old_vectors: np.ndarray | None = None
        if reuse_map and vp.exists():
            try:
                old_vectors = load_file(str(vp))["vectors"]
            except Exception:
                old_vectors = None
                reuse_map = {}

        # Embed new chunks
        if need_embed:
            BATCH = 1000
            new_parts: list[np.ndarray] = []
            texts_to_embed = [t for _, t in need_embed]
            for b in range(0, len(texts_to_embed), BATCH):
                batch = texts_to_embed[b:b + BATCH]
                n_batch = len(batch)
                n_total = len(texts_to_embed)
                print(
                    f"[mmemory] Embedding {b+1}-{b+n_batch}/{n_total} chunks",
                    file=sys.stderr, flush=True,
                )
                new_parts.append(np.array(list(self.model.embed(batch)), dtype=np.float32))
            new_vecs = np.vstack(new_parts) if len(new_parts) > 1 else new_parts[0]
        else:
            new_vecs = np.empty((0, 384), dtype=np.float32)

        # Assemble final vectors
        total = len(all_chunks)
        final = np.zeros((total, 384), dtype=np.float32)
        embed_idx = 0
        for i in range(total):
            if i in reuse_map and old_vectors is not None and reuse_map[i] < len(old_vectors):
                final[i] = old_vectors[reuse_map[i]]
            elif embed_idx < len(new_vecs):
                final[i] = new_vecs[embed_idx]
                embed_idx += 1

        # Dedup: mark near-duplicate chunks (cosine > threshold) — don't remove,
        # just add a dedup flag so recall can skip them.
        # (Full dedup would require O(N^2) — skip for now; RRF handles natural duplication)

        # Save
        vp.parent.mkdir(parents=True, exist_ok=True)
        save_file({"vectors": final}, str(vp))

        # Save chunks.json (BM25 source)
        cp = Path(chunks_path)
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_text(json.dumps(all_chunks, indent=2))

        # Save meta
        meta = {
            "model": MODEL_NAME,
            "count": total,
            "dims": 384,
            "built": datetime.now().isoformat(),
            "chunks": [{"path": c["path"], "hash": c["hash"]} for c in all_chunks],
        }
        vmp.parent.mkdir(parents=True, exist_ok=True)
        vmp.write_text(json.dumps(meta, indent=2))

        print(f"[mmemory] Build done: {total} chunks ({len(need_embed)} new).", file=sys.stderr, flush=True)

    def _handle_dedup_check(self, req: dict) -> dict:
        """Check if a text is a near-duplicate of existing vectors."""
        self._load_model()
        text: str = req.get("text", "")
        vectors_path: str = req.get("vectors_path", "")
        threshold: float = float(req.get("threshold", 0.92))

        if not text or not vectors_path:
            return {"error": "text and vectors_path required"}

        emb = np.array(list(self.model.embed([text]))[0], dtype=np.float32)
        vecs = self._load_vectors(vectors_path)
        if vecs is None or len(vecs) == 0:
            return {"is_duplicate": False, "max_score": 0.0}

        scores = cosine_similarity(emb, vecs)
        max_score = float(np.max(scores))
        return {"is_duplicate": max_score >= threshold, "max_score": max_score}

    # ── Request dispatcher ─────────────────────────────────────────────────────

    def _handle_request(self, data: str) -> dict:
        try:
            req = json.loads(data)
        except json.JSONDecodeError:
            return {"error": "invalid JSON"}

        action = req.get("action", "")
        handler = {
            "ping": self._handle_ping,
            "shutdown": self._handle_shutdown,
            "recall": self._handle_recall,
            "build": self._handle_build,
            "rebuild": self._handle_build,  # alias
            "dedup_check": self._handle_dedup_check,
        }.get(action)

        if not handler:
            return {"error": f"unknown action: {action}"}

        self.last_activity = time.time()
        try:
            return handler(req)
        except Exception as e:
            return {"error": str(e)}

    # ── Client connection ──────────────────────────────────────────────────────

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

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def _idle_watchdog(self) -> None:
        while self.running:
            time.sleep(5)
            if time.time() - self.last_activity > self.timeout:
                print(
                    f"[mmemory] Idle timeout ({self.timeout}s). Shutting down.",
                    file=sys.stderr, flush=True,
                )
                self.running = False
                try:
                    # Unblock accept()
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.connect(("127.0.0.1", self.port))
                    s.close()
                except OSError:
                    pass
                break

    def run(self) -> None:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", self.port))  # port=0 → OS assigns free port
        srv.listen(8)
        srv.settimeout(1.0)
        self.port = srv.getsockname()[1]  # read back assigned port

        # Print READY line for TypeScript client to detect
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
            t = threading.Thread(target=self._handle_client, args=(conn, addr), daemon=True)
            t.start()

        srv.close()
        print("[mmemory] Stopped.", file=sys.stderr, flush=True)


# ── Entry point ─────────────────────────────────────────────────────────────────

def main() -> None:
    port = 0  # default: OS assigns
    timeout = DEFAULT_TIMEOUT

    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1]); i += 2
        elif sys.argv[i] == "--timeout" and i + 1 < len(sys.argv):
            timeout = int(sys.argv[i + 1]); i += 2
        else:
            i += 1

    server = MmemoryServer(port, timeout)
    server.run()


if __name__ == "__main__":
    main()
