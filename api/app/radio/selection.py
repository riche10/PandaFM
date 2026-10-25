"""Choose radio songs: score every candidate, then pick at random among the
strongest few, weighted by score. Never simply the top score (that makes
repetitive radio), and never the same song twice in a session.
"""

import math
import random
from dataclasses import dataclass

from app.radio.config import ModeProfile
from app.radio.genres import OFF_GENRE, STATION_MIN, affinity
from app.radio.scoring import Candidate, Profile, Recent, Seed, effective_weights, score
from app.radio.session import SessionState


@dataclass(frozen=True)
class Pick:
    candidate: Candidate
    score: float
    breakdown: dict[str, float]


def station_pool(candidates: list[Candidate], anchor: frozenset[str], count: int) -> list[Candidate]:
    """A saved station plays inside its neighbourhood. Only if that runs dry (a tiny
    library) may the nearest songs below it join; clearly unrelated ones never do."""
    fits = [(affinity(c.genres, anchor), c) for c in candidates]
    inside = [c for f, c in fits if f >= STATION_MIN]
    if len(inside) >= count:
        return inside
    nearby = sorted(((f, c) for f, c in fits if OFF_GENRE <= f < STATION_MIN), key=lambda x: -x[0])
    return inside + [c for _, c in nearby[: count - len(inside)]]


def choose(
    candidates: list[Candidate],
    *,
    count: int,
    mode: ModeProfile,
    seed: Seed,
    profile: Profile,
    session: SessionState,
    recent: Recent,
    rng: random.Random,
) -> list[Pick]:
    weights, temperature = effective_weights(mode, session.exploration, seed.strict)
    if seed.strict and seed.anchor:
        candidates = station_pool(candidates, seed.anchor, count)
    # One noise value per candidate for this whole batch, so re-scoring between
    # picks (as repetition rules change) stays consistent.
    noise = {c.track_id: rng.random() for c in candidates}
    taken = set(recent.track_ids)
    artists = list(recent.artist_ids)
    albums = list(recent.album_ids)
    previous_genres = recent.genres
    picks: list[Pick] = []

    for _ in range(count):
        eligible = [c for c in candidates if c.track_id not in taken]
        # Hard rule: an artist waits `artist_gap` picks. Relaxed only if nothing else is left.
        spaced = [c for c in eligible if not (c.artist_id and c.artist_id in artists[-mode.artist_gap :])]
        pool_source = spaced or eligible
        if not pool_source:
            break
        now = Recent(frozenset(taken), tuple(artists), tuple(albums), previous_genres)
        scored = sorted(
            ((score(c, seed, profile, session, now, mode, weights, noise[c.track_id]), c) for c in pool_source),
            key=lambda item: (-item[0][0], item[1].track_id),
        )
        pool = scored[: mode.pool_size]
        best = pool[0][0][0]
        odds = [math.exp((total - best) / max(temperature, 1e-6)) for (total, _), _ in pool]
        (total, breakdown), chosen = pool[_weighted_index(odds, rng)]

        picks.append(Pick(chosen, total, breakdown))
        taken.add(chosen.track_id)
        artists.append(chosen.artist_id or "")
        albums.append(chosen.album_id or "")
        previous_genres = frozenset(chosen.genres)
    return picks


def _weighted_index(weights: list[float], rng: random.Random) -> int:
    target = rng.random() * sum(weights)
    running = 0.0
    for index, weight in enumerate(weights):
        running += weight
        if running >= target:
            return index
    return len(weights) - 1
