#!/usr/bin/env python3
"""Shared BM25 implementation for mmemory_server.py and mmemory_vacuum.py."""
import collections, math, re


def tokenize(text: str) -> list[str]:
    text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)  # split CamelCase
    return [t.lower() for t in re.sub(r'[^a-zA-Z0-9]', ' ', text).split() if len(t) > 1]


def build_bm25_index(chunks: list[dict]) -> dict:
    k1, b = 1.5, 0.75
    N = len(chunks)
    doc_tfs, doc_lengths, df = [], [], collections.Counter()
    for c in chunks:
        tf = collections.Counter(tokenize(c.get('text', '')))
        doc_tfs.append(tf)
        doc_lengths.append(sum(tf.values()))
        for t in tf: df[t] += 1
    avg_dl = sum(doc_lengths) / N if N else 1
    # Keep terms appearing in < 50% of docs. Guard against N < 4 so the threshold
    # is always at least 2 — prevents wiping all terms when corpus is tiny.
    stopword_threshold = max(2, N * 0.5)
    df = {t: cnt for t, cnt in df.items() if cnt < stopword_threshold}
    return {'N': N, 'df': df, 'doc_tfs': doc_tfs, 'doc_lengths': doc_lengths,
            'avg_dl': avg_dl, 'k1': k1, 'b': b}


def bm25_search(index: dict, query: str, top_k: int = 10) -> list[tuple[int, float]]:
    if not index.get('N'): return []
    k1, b = index['k1'], index['b']
    N, avg_dl = index['N'], index['avg_dl']
    qterms = [t for t in tokenize(query) if t in index['df']]
    scores = []
    for i, (tf, dl) in enumerate(zip(index['doc_tfs'], index['doc_lengths'])):
        score = sum(
            math.log((N - index['df'][t] + 0.5) / (index['df'][t] + 0.5) + 1) *
            tf.get(t, 0) * (k1 + 1) / (tf.get(t, 0) + k1 * (1 - b + b * dl / avg_dl))
            for t in qterms if tf.get(t, 0) > 0
        )
        if score > 0: scores.append((i, score))
    return sorted(scores, key=lambda x: x[1], reverse=True)[:top_k]
