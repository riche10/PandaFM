"""Panda Mix playlist order (5.3): a stable, optimised order of the playlist's own songs.

Pure and deterministic: the same songs, analyses and seed give the same order.
Panda DJ never adds or removes songs here; it only arranges what the playlist
already contains so neighbours blend well. The Navidrome playlist and its
original order are never changed.
"""

import random

from app.mix.analysis import tempo_ratio
from app.mix.planner import camelot_compatible


def cost(a_meta: dict, b_meta: dict, aa: dict | None, ba: dict | None) -> float:
    """How awkward A→B is (0 = ideal). Unknowns are neutral, never prohibitive."""
    c = 0.0
    if aa and ba:
        conf = min(aa.get("bpm_confidence") or 0, ba.get("bpm_confidence") or 0)
        ratio = tempo_ratio(aa.get("bpm"), ba.get("bpm"))
        c += min(1.0, abs(ratio - 1) / 0.08) if ratio and conf >= 0.4 else 0.5
        ok = camelot_compatible(aa.get("key_camelot") if (aa.get("key_confidence") or 0) >= 0.3 else None,
                                ba.get("key_camelot") if (ba.get("key_confidence") or 0) >= 0.3 else None)
        c += 0.0 if ok else 0.35 if ok is False else 0.15
        la, lb = aa.get("integrated_lufs"), ba.get("integrated_lufs")
        c += min(0.4, abs(la - lb) / 15) if la is not None and lb is not None else 0.1
    else:
        c += 0.8
    if a_meta.get("album_id") and a_meta.get("album_id") == b_meta.get("album_id") and a_meta.get("track_number") and b_meta.get("track_number") \
            and b_meta["track_number"] == a_meta["track_number"] + 1:
        c -= 1.5  # keep album runs (live albums, joined tracks) together: stronger than any mismatch
    return c


def mixed_order(ids: list[str], meta: dict[str, dict], analyses: dict[str, dict], seed: int = 0) -> list[str]:
    """Greedy chaining from the playlist's first song (or a seeded start for a Remix), then bounded 2-opt."""
    ids = list(dict.fromkeys(ids))  # a song listed twice plays once in the mixed order
    n = len(ids)
    if n < 3:
        return ids
    rng = random.Random(seed)
    jitter = {i: (rng.random() * 0.15 if seed else 0.0) for i in ids}
    m = [[cost(meta.get(a, {}), meta.get(b, {}), analyses.get(a), analyses.get(b)) + jitter[b] for b in ids] for a in ids]
    pos = {i: k for k, i in enumerate(ids)}
    start = 0 if seed == 0 else rng.randrange(n)
    order, left = [start], set(range(n)) - {start}
    while left:
        cur = order[-1]
        nxt = min(left, key=lambda j: (m[cur][j], j))  # ties keep the playlist's own order
        order.append(nxt)
        left.discard(nxt)
    for _ in range(2):  # bounded improvement: reverse segments that make the path cheaper
        improved = False
        for i in range(1, n - 2):
            for j in range(i + 1, n - 1):
                a, b, c, d = order[i - 1], order[i], order[j], order[j + 1]
                if m[a][c] + m[b][d] + 1e-9 < m[a][b] + m[c][d]:
                    order[i:j + 1] = reversed(order[i:j + 1])
                    improved = True
        if not improved:
            break
    _ = pos
    return [ids[k] for k in order]


def insert(order: list[str], new: str, meta: dict[str, dict], analyses: dict[str, dict]) -> list[str]:
    """A song added to the playlist goes where it fits best; everything else keeps its place."""
    if new in order:
        return order
    if not order:
        return [new]
    c = lambda x, y: cost(meta.get(x, {}), meta.get(y, {}), analyses.get(x), analyses.get(y))  # noqa: E731
    best, where = c(order[-1], new), len(order)
    for k in range(len(order)):
        extra = c(new, order[k]) - (c(order[k - 1], order[k]) if k > 0 else 0) + (c(order[k - 1], new) if k > 0 else 0)
        if extra < best - 1e-9:
            best, where = extra, k
    return order[:where] + [new] + order[where:]
