#!/usr/bin/env python3
import json, time
from datetime import datetime
from pathlib import Path

def fmt(t): return datetime.fromtimestamp(t).strftime('%Y-%m-%d') if t and t > 0 else '?'

db = Path("D:/.ai/knowledge/projects/omp_memory")
chunks = json.loads((db / "chunks.json").read_text())
now = time.time()

by_src = {}
for x in chunks:
    s = x.get("source", "?")
    by_src[s] = by_src.get(s, 0) + 1

print("=== Chunks by source ===")
for s, n in sorted(by_src.items()):
    print(f"  {s}: {n}")
print(f"  TOTAL: {len(chunks)}")

ages = [(now - x["ts"]) / 86400 for x in chunks if x.get("ts", 0) > 0]
missing_ts = [x for x in chunks if not x.get("ts")]
print(f"\n=== Timestamps ===")
print(f"  missing ts : {len(missing_ts)}")
if ages:
    print(f"  oldest     : {max(ages):.1f}d")
    print(f"  newest     : {min(ages):.4f}d ({min(ages)*24:.1f}h ago)")
    print(f"  avg age    : {sum(ages)/len(ages):.1f}d")

file_chunks = [x for x in chunks if x.get("source") == "file"]
print(f"\n=== File chunks ({len(file_chunks)}) ===")
for f in file_chunks[:10]:
    age = (now - f.get("ts", now)) / 86400
    end_ts = fmt(f.get("end_ts", 0) or f.get("ts", 0))
    print(f"  [{age:.1f}d] end={end_ts} {f.get('text','')[:60]}")

sess = [x for x in chunks if x.get("source") == "session"]
with_files = [x for x in sess if x.get("read_files") or x.get("modified_files")]
print(f"\n=== Session chunks ({len(sess)}) ===")
print(f"  with file arrays : {len(with_files)}")
if with_files:
    latest = max(with_files, key=lambda x: x.get("ts", 0))
    end_ts = fmt(latest.get("end_ts", 0) or latest.get("ts", 0))
    print(f"  latest end_ts        : {end_ts}")
    print(f"  latest read_files    : {latest.get('read_files', [])[:4]}")
    print(f"  latest modified_files: {latest.get('modified_files', [])[:4]}")

obs = [x for x in chunks if x.get("source") == "observation"]
print(f"\n=== Observation chunks ({len(obs)}) ===")
for o in obs[:5]:
    age = (now - o.get("ts", now)) / 86400
    start_d = fmt(o.get("ts", 0))
    end_d   = fmt(o.get("end_ts", 0))
    print(f"  [{age:.1f}d] [{start_d} → {end_d}] {o.get('text','')[:60]}")

vec = db / "vectors.safetensors"
print(f"\n=== Vectors ===")
if vec.exists():
    print(f"  size : {vec.stat().st_size // 1024}KB")
    print(f"  mtime: {(now - vec.stat().st_mtime)/60:.0f} min ago")
else:
    print("  MISSING")

vs = db / "vacuum-state.json"
print(f"\n=== Vacuum state ===")
if vs.exists():
    state = json.loads(vs.read_text())
    last = (now - state.get("last_vacuum_ts", 0)) / 3600
    print(f"  last_vacuum : {last:.1f}h ago")
    print(f"  full state  : {state}")
else:
    print("  Never vacuumed")

queue = list((db / "queue").glob("*.md")) if (db / "queue").exists() else []
print(f"\n=== Queue ({len(queue)} files) ===")
for q in queue:
    print(f"  {q.name}")
