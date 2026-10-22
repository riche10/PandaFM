"""What a listening action means. Thresholds live in config.py."""

from typing import Literal

from app.radio import config

SkipKind = Literal["early", "mid", "late"]


def classify_skip(position_s: float | None, duration_s: float | None) -> SkipKind:
    """Early skips are strong "not now"s; late ones are nearly neutral."""
    position = max(0.0, position_s or 0.0)
    if duration_s and duration_s > 0:
        early_limit = min(config.EARLY_SKIP_SECONDS, duration_s * config.EARLY_SKIP_FRACTION)
        if position < early_limit:
            return "early"
        if position >= duration_s * config.LATE_SKIP_FRACTION or duration_s - position <= config.LATE_SKIP_REMAINING_S:
            return "late"
        return "mid"
    return "early" if position < config.EARLY_SKIP_SECONDS else "mid"


def counts_as_listen(position_s: float | None, duration_s: float | None) -> bool:
    """Enough of a song was heard to call it a play (e.g. for Navidrome scrobbles)."""
    position = position_s or 0.0
    if position < config.LISTEN_MIN_S:
        return False
    if not duration_s:
        return position >= config.LISTEN_MAX_S
    return position >= min(duration_s * config.LISTEN_FRACTION, config.LISTEN_MAX_S)


def smoothed_affinity(completed: float, weighted_skips: float, plays: float, liked: float = 0.0) -> float:
    """Long-term liking in [-1, 1], pulled towards 0 when there is little evidence."""
    positive = completed + liked * config.FAVORITE_AFFINITY_WEIGHT
    value = (positive - weighted_skips) / (plays + liked + config.AFFINITY_PRIOR)
    return max(-1.0, min(1.0, value))
