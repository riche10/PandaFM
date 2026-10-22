"""Score one candidate song: a sum of named, weighted terms.

Every term is computed explicitly here and recorded in a breakdown, so any
radio choice can be explained ("why this song?") and tuned. Weights live in
config.py; this file has no tuning numbers of its own.
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass, field, replace

from app.radio import config
from app.radio.config import ModeProfile, Weights
from app.radio.session import SessionState


@dataclass(frozen=True)
class Candidate:
    track_id: int
    navidrome_id: str
    title: str
    artist: str
    artist_id: str | None
    album: str | None
    album_id: str | None
    genres: tuple[str, ...]
    year: int | None
    duration_s: int | None
    cover_art_id: str | None
    liked: bool = False
    play_count: int = 0
    completed_count: int = 0
    skip_count: int = 0
    early_skip_count: int = 0
    late_skip_count: int = 0
    hours_since_played: float | None = None
    sources: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Seed:
    """What the session started from: a song, album, artist, or (for a mode) your taste."""

    name: str | None = None
    track_id: int | None = None
    artist_id: str | None = None
    album_id: str | None = None
    genres: frozenset[str] = frozenset()
    year: int | None = None


@dataclass(frozen=True)
class Profile:
    """Long-term taste, from track_preferences (slow-moving)."""

    genre_affinity: Mapping[str, float] = field(default_factory=dict)
    artist_affinity: Mapping[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Recent:
    """What was just picked, for repetition and continuity rules."""

    track_ids: frozenset[int] = frozenset()
    artist_ids: tuple[str, ...] = ()  # oldest first
    album_ids: tuple[str, ...] = ()
    genres: frozenset[str] = frozenset()  # of the previous pick


PENALTIES = ("recent_track", "recent_artist", "recent_album", "skip_history", "session_skip")


def effective_weights(mode: ModeProfile, exploration: float) -> tuple[Weights, float]:
    """Exploration (raised by skips) loosens the seed and widens the net."""
    e = max(0.0, min(1.0, exploration))
    relief = 1 - config.EXPLORATION_SEED_RELIEF * e
    w = mode.weights
    weights = replace(
        w,
        seed_genre=w.seed_genre * relief,
        seed_artist=w.seed_artist * relief,
        randomness=w.randomness + config.EXPLORATION_EXTRA_RANDOMNESS * e,
        discovery=w.discovery + config.EXPLORATION_EXTRA_DISCOVERY * e,
    )
    return weights, mode.temperature * (1 + config.EXPLORATION_EXTRA_TEMPERATURE * e)


def _jaccard(a: frozenset[str] | set[str], b: frozenset[str] | set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def _weighted_skips(c: Candidate) -> float:
    late = c.late_skip_count
    early = c.early_skip_count
    mid = max(0, c.skip_count - early - late)
    return early * config.SKIP_WEIGHT["early"] + mid * config.SKIP_WEIGHT["mid"] + late * config.SKIP_WEIGHT["late"]


def _recent_play_penalty(hours: float | None) -> float:
    if hours is None:
        return 0.0
    for within, penalty in config.RECENT_PLAY_PENALTY:
        if hours < within:
            return penalty
    return 0.0


def raw_terms(c: Candidate, seed: Seed, profile: Profile, session: SessionState, recent: Recent, mode: ModeProfile, noise: float) -> dict[str, float]:
    """Each term in roughly [-1, 1] before weighting. Penalties are positive here."""
    genres = frozenset(c.genres)
    plays = c.play_count
    history_n = plays + config.TRACK_HISTORY_PRIOR
    session_genre = sum(session.genre_weights.get(g, 0.0) for g in genres) / len(genres) if genres else 0.0
    session_artist = session.artist_weights.get(c.artist_id or "", 0.0)
    recent_artists = recent.artist_ids
    gap = mode.artist_gap

    return {
        "seed_artist": 1.0 if c.artist_id and c.artist_id == seed.artist_id else 0.0,
        "seed_genre": _jaccard(genres, seed.genres),
        "seed_era": math.exp(-abs(c.year - seed.year) / 8) if c.year and seed.year else 0.0,
        "genre_affinity": sum(profile.genre_affinity.get(g, 0.0) for g in genres) / len(genres) if genres else 0.0,
        "artist_affinity": profile.artist_affinity.get(c.artist_id or "", 0.0),
        "favorite": 1.0 if c.liked else 0.0,
        "completion": c.completed_count / history_n,
        "familiarity": min(1.0, math.log1p(plays) / math.log1p(config.FAMILIARITY_SATURATION)),
        "discovery": 1.0 / (1.0 + plays),
        "session": max(-1.0, min(1.0, session_genre + session_artist)),
        "continuity": _jaccard(genres, recent.genres),
        "randomness": noise,
        # Penalties
        "recent_track": 1.0 if c.track_id in recent.track_ids else _recent_play_penalty(c.hours_since_played),
        "recent_artist": (
            0.0
            if not c.artist_id
            else 1.0
            if c.artist_id in recent_artists[-gap:]
            else 0.5
            if c.artist_id in recent_artists[-2 * gap :]
            else 0.0
        ),
        "recent_album": 1.0 if c.album_id and c.album_id in recent.album_ids[-mode.album_gap :] else 0.0,
        "skip_history": _weighted_skips(c) / history_n,
        "session_skip": 1.0 if c.artist_id and c.artist_id in session.skipped_artist_ids else 0.0,
    }


def score(c: Candidate, seed: Seed, profile: Profile, session: SessionState, recent: Recent, mode: ModeProfile, weights: Weights, noise: float) -> tuple[float, dict[str, float]]:
    """Total score and its breakdown (weighted contribution of each non-zero term)."""
    breakdown: dict[str, float] = {}
    for name, value in raw_terms(c, seed, profile, session, recent, mode, noise).items():
        contribution = getattr(weights, name) * value * (-1 if name in PENALTIES else 1)
        if abs(contribution) >= 1e-4:
            breakdown[name] = round(contribution, 4)
    return round(sum(breakdown.values()), 4), breakdown
