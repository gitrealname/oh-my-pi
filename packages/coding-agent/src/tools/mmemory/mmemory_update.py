#!/usr/bin/env python3
"""mmemory update CLI — chunk + index memory .md files.

Called after the extension writes a new memory .md file.
Low-priority subprocess (spawned with setPriority(pid, 19)).
Self-contained — no kb tools dependency.

If a running server port is supplied, delegates embedding to it (reuses warm model).
Otherwise embeds locally.

Usage:
    python mmemory_update.py \\
        --memory-path ~/.omp/mmemory/myproject \\
        --index-path  ~/.omp/mmemory/myproject \\
        [--server-port 12345]
"""

import hashlib
import json
import os
import re
import socket
import sys
from datetime import datetime
from pathlib import Path


# ── Inline chunker (same logic as server) ──────────────────────────────────────

def tokenize_for_bm25(text: str) -> list[str]:
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    return [t.lower() for t in re.sub(r"[^a-zA-Z0-9]", " ", text).split() if len(t) > 1]


def chunk_markdown(text: str, path: str, chunk_size: int = 512, overlap: int = 64) -> list[dict]:
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


# ── Server delegation ───────────────────────────────────────────────────────────

def notify_server(port: int, memory_dir: str, chunks_path: str, vectors_path: str,
                  vectors_meta_path: str, facts_path: str, dedup_threshold: float) -> bool:
    """Send a build request to a running mmemory server. Returns True on success."""
    req = json.dumps({
        "action": "build",
        "memory_dir": memory_dir,
        "chunks_path": chunks_path,
        "vectors_path": vectors_path,
        "vectors_meta_path": vectors_meta_path,
        "facts_path": facts_path,
        "dedup_threshold": dedup_threshold,
    }) + "\n"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(("127.0.0.1", port))
        s.sendall(req.encode())
        buf = b""
        while True:
            data = s.recv(4096)
            if not data:
                break
            buf += data
            if b"\n" in buf:
                break
        s.close()
        resp = json.loads(buf.split(b"\n")[0].decode())
        return resp.get("status") == "accepted"
    except Exception as e:
        print(f"[mmemory_update] Server notify failed: {e}", file=sys.stderr)
        return False


# ── Standalone embedding ────────────────────────────────────────────────────────

def run_standalone_build(
    memory_dir: str,
    chunks_path: str,
    vectors_path: str,
    vectors_meta_path: str,
    dedup_threshold: float,
) -> None:
    """Embed chunks locally using fastembed. Used when server is not running."""
    MODEL_NAME = "BAAI/bge-small-en-v1.5"
    MODEL_CACHE = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".cache"))) / "fastembed"

    import numpy as np
    os.environ["FASTEMBED_CACHE_PATH"] = str(MODEL_CACHE)
    from fastembed import TextEmbedding  # type: ignore[import]
    from safetensors.numpy import load_file, save_file  # type: ignore[import]

    md_dir = Path(memory_dir)
    all_chunks: list[dict] = []
    for md_file in sorted(md_dir.glob("*.md")):
        text = md_file.read_text(encoding="utf-8", errors="replace")
        all_chunks.extend(chunk_markdown(text, str(md_file)))

    if not all_chunks:
        print("[mmemory_update] No chunks found — nothing to embed.", file=sys.stderr)
        return

    # Load existing meta for incremental
    vp = Path(vectors_path)
    vmp = Path(vectors_meta_path)
    old_lookup: dict[tuple[str, str], int] = {}
    if vp.exists() and vmp.exists():
        try:
            old_meta = json.loads(vmp.read_text())
            if old_meta.get("model") == MODEL_NAME:
                for i, c in enumerate(old_meta.get("chunks", [])):
                    old_lookup[(c["path"], c["hash"])] = i
        except Exception:
            pass

    reuse_map: dict[int, int] = {}
    need_embed: list[tuple[int, str]] = []
    for i, c in enumerate(all_chunks):
        key = (c["path"], c["hash"])
        if key in old_lookup:
            reuse_map[i] = old_lookup[key]
        else:
            need_embed.append((i, c["text"]))

    if not need_embed and len(reuse_map) == len(all_chunks):
        print("[mmemory_update] All chunks up to date, nothing to embed.", file=sys.stderr)
        return

    old_vectors: np.ndarray | None = None
    if reuse_map and vp.exists():
        try:
            old_vectors = load_file(str(vp))["vectors"]
        except Exception:
            old_vectors = None
            reuse_map = {}

    model = TextEmbedding(MODEL_NAME, cache_dir=str(MODEL_CACHE))
    if need_embed:
        texts = [t for _, t in need_embed]
        new_vecs = np.array(list(model.embed(texts)), dtype=np.float32)
    else:
        new_vecs = np.empty((0, 384), dtype=np.float32)

    total = len(all_chunks)
    final = np.zeros((total, 384), dtype=np.float32)
    embed_idx = 0
    for i in range(total):
        if i in reuse_map and old_vectors is not None and reuse_map[i] < len(old_vectors):
            final[i] = old_vectors[reuse_map[i]]
        elif embed_idx < len(new_vecs):
            final[i] = new_vecs[embed_idx]
            embed_idx += 1

    vp.parent.mkdir(parents=True, exist_ok=True)
    save_file({"vectors": final}, str(vp))

    cp = Path(chunks_path)
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_text(json.dumps(all_chunks, indent=2))

    meta = {
        "model": MODEL_NAME,
        "count": total,
        "dims": 384,
        "built": datetime.now().isoformat(),
        "chunks": [{"path": c["path"], "hash": c["hash"]} for c in all_chunks],
    }
    vmp.parent.mkdir(parents=True, exist_ok=True)
    vmp.write_text(json.dumps(meta, indent=2))

    print(f"[mmemory_update] Done: {total} chunks ({len(need_embed)} new).", file=sys.stderr)


# ── Entry point ─────────────────────────────────────────────────────────────────

def main() -> None:
    memory_path = ""
    index_path = ""
    server_port = 0
    dedup_threshold = 0.92

    i = 1
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == "--memory-path" and i + 1 < len(sys.argv):
            memory_path = sys.argv[i + 1]; i += 2
        elif a == "--index-path" and i + 1 < len(sys.argv):
            index_path = sys.argv[i + 1]; i += 2
        elif a == "--server-port" and i + 1 < len(sys.argv):
            server_port = int(sys.argv[i + 1]); i += 2
        elif a == "--dedup-threshold" and i + 1 < len(sys.argv):
            dedup_threshold = float(sys.argv[i + 1]); i += 2
        else:
            i += 1

    if not memory_path:
        print("ERROR: --memory-path required", file=sys.stderr)
        sys.exit(1)

    index_path = index_path or memory_path
    chunks_path = str(Path(index_path) / "chunks.json")
    vectors_path = str(Path(index_path) / "vectors.safetensors")
    vectors_meta_path = str(Path(index_path) / "vectors.meta.json")
    facts_path = str(Path(index_path) / "facts.json")

    if server_port > 0:
        ok = notify_server(
            server_port, memory_path, chunks_path, vectors_path,
            vectors_meta_path, facts_path, dedup_threshold,
        )
        if ok:
            print(f"[mmemory_update] Delegated build to server on port {server_port}.", file=sys.stderr)
            return
        print("[mmemory_update] Server unavailable, falling back to standalone embed.", file=sys.stderr)

    run_standalone_build(memory_path, chunks_path, vectors_path, vectors_meta_path, dedup_threshold)


if __name__ == "__main__":
    main()
