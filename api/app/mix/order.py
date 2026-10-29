"""Panda Mix playlist order (5.4): an order of the playlist's own songs driven by musical fit.

Pure and deterministic: the same songs, analyses and seed give the same order.
Panda DJ never adds or removes songs here (repeated entries stay); it only
arranges what the playlist already contains so neighbours blend well. The
Navidrome playlist and its original order are never changed.

The cost of A→B weighs, in order of importance: tempo (half/double time folded,
confident differences count fully, uncertain ones fade to neutral), harmonic
(Camelot) fit when the keys are confident, loudness jumps, and usable
intro/outro sections; consecutive album tracks stay together. Unknown or
low-confidence facts are neutral, never guessed.

Remix explores among strong orders only: several candidates are built
(randomness only breaks near-ties and picks among similar starts), each is
scored with the same musical cost, anything clearly worse than the best is
discarded, and a candidate that differs from the current mix is chosen.
"""

import random

from app.mix.analysis import tempo_ratio
from app.mix.planner import camelot_compatible

W_TEMPO, W_KEY, W_LOUD, W_SECTIONS = 1.0, 0.6, 0.4, 0.2
NEUTRAL_TEMPO, NEUTRAL_KEY = 0.35, 0.15
REMIX_SLACK = 0.10  # a Remix may be at most ~10% costlier than the best order found
NEAR_TIE = 0.04  # randomness only chooses among next songs this close to the best


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def _camelot_steps(a: str, b: str) -> int:
    na, nb = int(a[:-1]), int(b[:-1])
    ring = min(abs(na - nb), 12 - abs(na - nb))
    return ring + (0 if a[-1] == b[-1] else 1)


def components(aa: dict | None, ba: dict | None) -> dict:
    """The parts of A→B's musical cost (0 = ideal), each with how sure it is."""
    if not aa or not ba:
        return {"tempo": NEUTRAL_TEMPO, "key": NEUTRAL_KEY, "loud": 0.1, "sections": 0.1, "known": False}
    conf = min(aa.get("bpm_confidence") or 0, ba.get("bpm_confidence") or 0)
    ratio = tempo_ratio(aa.get("bpm"), ba.get("bpm"))
    w = _clamp((conf - 0.3) / 0.5) if ratio else 0.0  # confident tempo facts count fully; uncertain ones fade to neutral
    tempo = w * min(1.0, abs(ratio - 1) / 0.08) + (1 - w) * NEUTRAL_TEMPO if ratio else NEUTRAL_TEMPO
    kc = min(aa.get("key_confidence") or 0, ba.get("key_confidence") or 0)
    ka, kb = aa.get("key_camelot"), ba.get("key_camelot")
    if ka and kb and kc >= 0.3:
        wk = _clamp((kc - 0.3) / 0.4)
        fit = 0.0 if camelot_compatible(ka, kb) else 0.2 if _camelot_steps(ka, kb) == 2 else 0.6
        key = wk * fit + (1 - wk) * NEUTRAL_KEY
    else:
        key = NEUTRAL_KEY
    la, lb = aa.get("integrated_lufs"), ba.get("integrated_lufs")
    loud = min(1.0, max(0.0, abs(la - lb) - 2) / 10) if la is not None and lb is not None else 0.1
    sections = 1 - 0.5 * ((aa.get("outro_suitability") or 0) + (ba.get("intro_suitability") or 0))
    return {"tempo": tempo, "key": key, "loud": loud, "sections": sections, "known": True}


def _album_run(a_meta: dict, b_meta: dict) -> bool:
    return bool(a_meta.get("album_id") and a_meta.get("album_id") == b_meta.get("album_id") and a_meta.get("track_number")
                and b_meta.get("track_number") and b_meta["track_number"] == a_meta["track_number"] + 1)


def cost(a_meta: dict, b_meta: dict, aa: dict | None, ba: dict | None) -> float:
    """How awkward A→B is (0 = ideal). Unknowns are neutral, never prohibitive."""
    p = components(aa, ba)
    c = W_TEMPO * p["tempo"] + W_KEY * p["key"] + W_LOUD * p["loud"] + W_SECTIONS * p["sections"]
    if _album_run(a_meta, b_meta):
        c -= 2.5  # keep album runs (live albums, joined tracks) together: stronger than any mismatch
    return c


def explain(a_meta: dict, b_meta: dict, aa: dict | None, ba: dict | None) -> list[str]:
    """'Why here?': the musical facts behind this neighbour, only the ones Panda is sure of."""
    if _album_run(a_meta, b_meta):
        return ["The next track on the same album"]
    if not aa or not ba:
        return ["Not analysed yet"]
    out = []
    conf = min(aa.get("bpm_confidence") or 0, ba.get("bpm_confidence") or 0)
    ratio = tempo_ratio(aa.get("bpm"), ba.get("bpm"))
    if ratio and conf >= 0.4:
        a, b = round(aa["bpm"]), round(ba["bpm"])
        folded = abs(aa["bpm"] / ba["bpm"] - 1) > 0.3
        out.append(f"{a} → {b} BPM" + (" (half/double time)" if folded else "") + (", close tempo" if abs(ratio - 1) <= 0.03 else ""))
    else:
        out.append("Tempo uncertain")
    kc = min(aa.get("key_confidence") or 0, ba.get("key_confidence") or 0)
    ka, kb = aa.get("key_camelot"), ba.get("key_camelot")
    if ka and kb and kc >= 0.3:
        out.append(f"{ka} → {kb} " + ("compatible key" if camelot_compatible(ka, kb) else "nearby key" if _camelot_steps(ka, kb) == 2 else "key clash"))
    else:
        out.append("Key uncertain")
    la, lb = aa.get("integrated_lufs"), ba.get("integrated_lufs")
    if la is not None and lb is not None:
        d = lb - la
        out.append("Similar loudness" if abs(d) <= 2 else f"{'louder' if d > 0 else 'quieter'} by {abs(d):.0f} LU")
    return out


def _matrix(ids, meta, analyses):
    cache: dict[tuple[str, str], float] = {}

    def c(a: str, b: str) -> float:
        if (a, b) not in cache:
            cache[(a, b)] = cost(meta.get(a, {}), meta.get(b, {}), analyses.get(a), analyses.get(b))
        return cache[(a, b)]

    return [[c(a, b) for b in ids] for a in ids]


def path_cost(order_idx: list[int], m) -> float:
    return sum(m[a][b] for a, b in zip(order_idx, order_idx[1:]))


def _chain(n: int, m, start: int, rng: random.Random | None) -> list[int]:
    order, left = [start], set(range(n)) - {start}
    while left:
        cur = order[-1]
        best = min(m[cur][j] for j in left)
        near = sorted(j for j in left if m[cur][j] <= best + (NEAR_TIE if rng else 1e-9))
        nxt = rng.choice(near) if rng and len(near) > 1 else near[0]  # ties keep the playlist's own order
        order.append(nxt)
        left.discard(nxt)
    return order


def _improve(order: list[int], m, passes: int = 2) -> list[int]:
    n = len(order)
    for _ in range(passes):  # bounded 2-opt: reverse segments that make the path cheaper
        improved = False
        for i in range(1, n - 2):
            for j in range(i + 1, n - 1):
                a, b, c, d = order[i - 1], order[i], order[j], order[j + 1]
                if m[a][c] + m[b][d] + 1e-9 < m[a][b] + m[c][d]:
                    order[i:j + 1] = reversed(order[i:j + 1])
                    improved = True
        if not improved:
            break
    return order


def _difference(a: list[str], b: list[str] | None) -> float:
    """Share of neighbour pairs in a that b doesn't have (0 = the same mix)."""
    if not b or len(a) < 2:
        return 1.0
    pairs = set(zip(b, b[1:]))
    return sum(1 for p in zip(a, a[1:]) if p not in pairs) / (len(a) - 1)


def mixed_order(ids: list[str], meta: dict[str, dict], analyses: dict[str, dict], seed: int = 0, current: list[str] | None = None) -> list[str]:
    """The best order found from the playlist's first song (seed 0), or a strong, different Remix (seed > 0)."""
    ids = list(ids)  # preserve repeated playlist entries; each occurrence still plays
    n = len(ids)
    if n < 3:
        return ids
    m = _matrix(ids, meta, analyses)
    canonical = _improve(_chain(n, m, 0, None), m)
    if not seed:
        return [ids[k] for k in canonical]
    rng = random.Random(seed)
    tries = 12 if n <= 150 else 6 if n <= 300 else 3
    starts = sorted(range(n), key=lambda k: (sum(sorted(m[k])[:2]), k))[: max(3, n // 3)]  # songs that connect well
    candidates = [canonical] + [_improve(_chain(n, m, rng.choice(starts), rng), m) for _ in range(tries)]
    scored = [(path_cost(c, m), c) for c in candidates]
    best = min(s for s, _ in scored)
    strong = [c for s, c in scored if s <= best * (1 + REMIX_SLACK) + 0.05]  # never clearly worse than the best
    fresh = [c for c in strong if _difference([ids[k] for k in c], current) >= 0.3]
    pick = rng.choice(fresh or strong)
    return [ids[k] for k in pick]


def order_cost(order: list[str], meta: dict[str, dict], analyses: dict[str, dict]) -> float:
    return sum(cost(meta.get(a, {}), meta.get(b, {}), analyses.get(a), analyses.get(b)) for a, b in zip(order, order[1:]))


def insert(order: list[str], new: str, meta: dict[str, dict], analyses: dict[str, dict]) -> list[str]:
    """A song added to the playlist goes where it fits best; everything else keeps its place."""
    if not order:
        return [new]
    c = lambda x, y: cost(meta.get(x, {}), meta.get(y, {}), analyses.get(x), analyses.get(y))  # noqa: E731
    best, where = c(order[-1], new), len(order)
    for k in range(len(order)):
        extra = c(new, order[k]) - (c(order[k - 1], order[k]) if k > 0 else 0) + (c(order[k - 1], new) if k > 0 else 0)
        if extra < best - 1e-9:
            best, where = extra, k
    return order[:where] + [new] + order[where:]
