"""Short-term taste for one Panda Radio session: quick to move, and drifting
back to neutral over time. Stored as JSON in radio_sessions.state.

Nothing here touches long-term preferences: a session full of skipped
synthwave changes this session only.
"""

from dataclasses import asdict, dataclass, field
from typing import Any

from app.radio import config
from app.radio.signals import SkipKind


@dataclass
class SessionState:
    genre_weights: dict[str, float] = field(default_factory=dict)
    artist_weights: dict[str, float] = field(default_factory=dict)
    exploration: float = 0.0
    skip_streak: int = 0
    skips: int = 0
    completions: int = 0
    steer_version: int = 0  # bumps when queued picks should be re-planned
    recent_track_ids: list[int] = field(default_factory=list)
    recent_artist_ids: list[str] = field(default_factory=list)
    recent_album_ids: list[str] = field(default_factory=list)
    last_genres: list[str] = field(default_factory=list)
    skipped_artist_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_json(cls, data: dict[str, Any] | None, base_exploration: float = 0.0) -> "SessionState":
        if not data:
            return cls(exploration=base_exploration)
        known = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
        return cls(**known)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def _decay(weights: dict[str, float]) -> dict[str, float]:
    return {k: round(v * config.SESSION_DECAY, 4) for k, v in weights.items() if abs(v * config.SESSION_DECAY) >= 0.02}


def _clamp(value: float) -> float:
    return max(-1.0, min(1.0, value))


def on_skip(state: SessionState, genres: list[str], artist_id: str | None, kind: SkipKind) -> SessionState:
    delta = config.SESSION_SKIP_DELTA[kind]
    genre_weights = _decay(state.genre_weights)
    for genre in genres:
        genre_weights[genre] = _clamp(genre_weights.get(genre, 0.0) - delta)
    artist_weights = _decay(state.artist_weights)
    if artist_id:
        artist_weights[artist_id] = _clamp(artist_weights.get(artist_id, 0.0) - delta * config.SESSION_ARTIST_FACTOR)

    counts = kind != "late"  # skipping the last seconds isn't a rejection
    streak = state.skip_streak + 1 if counts else state.skip_streak
    skipped_artists = state.skipped_artist_ids
    if counts and artist_id and artist_id not in skipped_artists:
        skipped_artists = [*skipped_artists, artist_id][-20:]
    return SessionState(
        **{
            **state.to_json(),
            "genre_weights": genre_weights,
            "artist_weights": artist_weights,
            "exploration": min(1.0, state.exploration + config.SESSION_EXPLORATION_STEP[kind]),
            "skip_streak": streak,
            "skips": state.skips + (1 if counts else 0),
            "steer_version": state.steer_version + (1 if counts and streak >= config.STEER_SKIP_STREAK else 0),
            "skipped_artist_ids": skipped_artists,
        }
    )


def on_complete(state: SessionState, genres: list[str], artist_id: str | None, base_exploration: float = 0.0) -> SessionState:
    genre_weights = _decay(state.genre_weights)
    for genre in genres:
        genre_weights[genre] = _clamp(genre_weights.get(genre, 0.0) + config.SESSION_COMPLETE_DELTA)
    artist_weights = _decay(state.artist_weights)
    if artist_id:
        artist_weights[artist_id] = _clamp(artist_weights.get(artist_id, 0.0) + config.SESSION_COMPLETE_DELTA)
    settled = base_exploration + (state.exploration - base_exploration) * config.SESSION_EXPLORATION_SETTLE
    return SessionState(
        **{
            **state.to_json(),
            "genre_weights": genre_weights,
            "artist_weights": artist_weights,
            "exploration": max(base_exploration, settled),
            "skip_streak": 0,
            "completions": state.completions + 1,
        }
    )


def on_pick(state: SessionState, track_id: int, artist_id: str | None, album_id: str | None, genres: list[str]) -> SessionState:
    keep = config.SESSION_HISTORY
    return SessionState(
        **{
            **state.to_json(),
            "recent_track_ids": [*state.recent_track_ids, track_id][-keep:],
            "recent_artist_ids": [*state.recent_artist_ids, artist_id or ""][-keep:],
            "recent_album_ids": [*state.recent_album_ids, album_id or ""][-keep:],
            "last_genres": list(genres),
        }
    )
