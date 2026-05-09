#!/usr/bin/env python3
"""VacuumWorker — age-based purge of stale mmemory chunks and vectors.

Pure logic: reads originals into memory, writes filtered copies to tmp/,
returns paths. Never modifies live files. Caller does the atomic swap.
"""
import hashlib, json, time
from pathlib import Path
from typing import Any

import numpy as np
from mmemory_bm25 import build_bm25_index  # noqa: F401 — imported for type clarity


class VacuumWorker:
    def __init__(
        self,
        chunks_path: Path | str,
        vectors_path: Path | str,
        out_dir: Path | str,
        vacuum_config: dict,
    ) -> None:
        self.chunks_path = Path(chunks_path)
        self.vectors_path = Path(vectors_path)
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(exist_ok=True)
        self.max_age_days: dict[str, int] = vacuum_config.get('max_age_days', {
            'session': 365, 'observation': 90, 'file': 180,
        })

    def run(self) -> tuple[Path, Path]:
        """Filter chunks by age, slice vectors by surviving indices.

        Originals are read once into memory and are never modified.
        Returns (new_chunks_path, new_vectors_path) — both in out_dir.
        """
        # Load originals into memory
        chunks: list[dict[str, Any]] = []
        if self.chunks_path.exists():
            chunks = json.loads(self.chunks_path.read_text(encoding='utf-8'))

        now = time.time()
        surviving_indices: list[int] = []
        surviving_chunks: list[dict] = []

        for i, chunk in enumerate(chunks):
            source = chunk.get('source', 'session')
            max_age = self.max_age_days.get(source, 365)
            ts = chunk.get('ts')
            age_days = (now - ts) / 86400 if ts else 0  # missing ts → treat as fresh (keep)
            if age_days <= max_age:
                surviving_indices.append(i)
                surviving_chunks.append(chunk)

        dropped = len(chunks) - len(surviving_chunks)
        if dropped:
            print(f'[mmemory-vacuum] Dropping {dropped} expired chunk(s).', flush=True)

        # Slice vectors by surviving indices (no re-embedding)
        ts_suffix = str(int(now))
        new_chunks_path = self.out_dir / f'chunks-vacuum-{ts_suffix}.json'
        new_vecs_path   = self.out_dir / f'vectors-vacuum-{ts_suffix}.safetensors'

        new_chunks_path.write_text(
            json.dumps(surviving_chunks, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )

        if self.vectors_path.exists() and surviving_indices:
            try:
                from safetensors.numpy import load_file, save_file  # type: ignore
                vecs = load_file(str(self.vectors_path))
                key = next(iter(vecs))
                arr = vecs[key]
                if len(surviving_indices) == len(chunks):
                    # Nothing dropped — copy as-is
                    filtered = arr
                else:
                    filtered = arr[np.array(surviving_indices)]
                save_file({'embeddings': filtered}, str(new_vecs_path))
            except Exception as e:
                print(f'[mmemory-vacuum] Vector slice failed: {e} — rebuilding empty', flush=True)
                try:
                    from safetensors.numpy import save_file
                    save_file({"embeddings": np.zeros((0, 384), dtype=np.float32)}, str(new_vecs_path))
                except Exception:
                    new_vecs_path.write_bytes(b'')  # last resort; server will rebuild
        else:
            try:
                from safetensors.numpy import save_file
                save_file({"embeddings": np.zeros((0, 384), dtype=np.float32)}, str(new_vecs_path))
            except Exception:
                new_vecs_path.write_bytes(b'')  # last resort; server will rebuild

        return new_chunks_path, new_vecs_path
