"""Custom Panda Radio presets: six understandable controls on top of a built-in mode.

A preset is a built-in base mode plus controls (0-100). The controls move the
base mode's weights by bounded amounts, relative to the base mode's own
defaults, so a preset that keeps its base's defaults behaves exactly like the
base. Everything here is clamped: no preset can switch off repeat protection,
let one artist take over, or bring back unavailable songs (those rules live in
selection and SQL, and the gaps below have hard minimums).
"""

from dataclasses import asdict, replace

from app.radio.config import MODES, ModeProfile, Weights

CONTROLS = ("familiarity", "discovery", "continuity", "artist_variety", "genre_variety", "wildcards")

# Each built-in mode expressed in the same six controls (what "Start from" fills in).
DEFAULT_CONTROLS: dict[str, dict[str, int]] = {
    "panda": {"familiarity": 50, "discovery": 50, "continuity": 50, "artist_variety": 50, "genre_variety": 50, "wildcards": 35},
    "familiar": {"familiarity": 85, "discovery": 10, "continuity": 55, "artist_variety": 45, "genre_variety": 35, "wildcards": 15},
    "discovery": {"familiarity": 20, "discovery": 90, "continuity": 45, "artist_variety": 55, "genre_variety": 60, "wildcards": 45},
    "study": {"familiarity": 55, "discovery": 20, "continuity": 90, "artist_variety": 25, "genre_variety": 20, "wildcards": 10},
    "chaos": {"familiarity": 15, "discovery": 75, "continuity": 10, "artist_variety": 90, "genre_variety": 95, "wildcards": 95},
}

# Hard limits that no preset can cross.
MIN_ARTIST_GAP = 1
MAX_ARTIST_GAP = 8
MIN_ALBUM_GAP = 2
MAX_ALBUM_GAP = 14
WEIGHT_MIN, WEIGHT_MAX = -1.5, 4.0
POOL_MIN, POOL_MAX = 10, 80
TEMP_MIN, TEMP_MAX = 0.1, 1.5
EXPLORE_MIN, EXPLORE_MAX = 0.0, 0.8

# How far each control can move things at its extremes (delta = (value - base default) / 100).
_EFFECTS = {
    "familiarity": {"favorite": 1.6, "completion": 1.0, "familiarity": 1.4, "artist_affinity": 1.0, "genre_affinity": 0.6},
    "discovery": {"discovery": 2.2},
    "continuity": {"continuity": 2.0, "session": 1.0, "seed_genre": 0.8, "seed_era": 0.4},
    "artist_variety": {"recent_artist": 1.6, "seed_artist": -0.6},
    "genre_variety": {"seed_genre": -1.2, "genre_affinity": -0.5},
    "wildcards": {"randomness": 2.2},
}
# Weights a preset never changes: the core repetition penalties.
_PROTECTED = ("recent_track", "recent_album", "skip_history", "session_skip", "off_genre")


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def clean_controls(base: str, controls: dict | None) -> dict[str, int]:
    """Fill gaps from the base mode's defaults and keep every value in 0..100."""
    defaults = DEFAULT_CONTROLS.get(base, DEFAULT_CONTROLS["panda"])
    out = {}
    for name in CONTROLS:
        raw = (controls or {}).get(name, defaults[name])
        try:
            out[name] = int(_clamp(round(float(raw)), 0, 100))
        except (TypeError, ValueError):
            out[name] = defaults[name]
    return out


def effective_profile(base: str, controls: dict | None, label: str | None = None) -> ModeProfile:
    """The scoring profile a preset gives the Stage 3 engine."""
    mode = MODES[base]
    values = clean_controls(base, controls)
    defaults = DEFAULT_CONTROLS[base]
    delta = {name: (values[name] - defaults[name]) / 100 for name in CONTROLS}

    weights = asdict(mode.weights)
    for control, effects in _EFFECTS.items():
        for weight, amount in effects.items():
            weights[weight] += amount * delta[control]
    for name in weights:
        if name not in _PROTECTED:
            weights[name] = round(_clamp(weights[name], WEIGHT_MIN, WEIGHT_MAX), 3)

    return replace(
        mode,
        label=label or mode.label,
        weights=Weights(**weights),
        pool_size=int(_clamp(round(mode.pool_size + 30 * delta["wildcards"] + 10 * delta["discovery"]), POOL_MIN, POOL_MAX)),
        temperature=round(_clamp(mode.temperature + 0.6 * delta["wildcards"], TEMP_MIN, TEMP_MAX), 3),
        base_exploration=round(_clamp(mode.base_exploration + 0.3 * delta["discovery"] + 0.2 * delta["wildcards"], EXPLORE_MIN, EXPLORE_MAX), 3),
        artist_gap=int(_clamp(round(mode.artist_gap + 4 * delta["artist_variety"]), MIN_ARTIST_GAP, MAX_ARTIST_GAP)),
        album_gap=int(_clamp(round(mode.album_gap + 6 * delta["artist_variety"]), MIN_ALBUM_GAP, MAX_ALBUM_GAP)),
    )


def snapshot(base: str, controls: dict | None, name: str) -> dict:
    """What a radio session keeps, so it stays understandable after the preset changes."""
    p = effective_profile(base, controls, name)
    return {
        "base": base,
        "name": name,
        "controls": clean_controls(base, controls) if controls is not None else None,
        "profile": {"weights": asdict(p.weights), "pool_size": p.pool_size, "temperature": p.temperature,
                    "base_exploration": p.base_exploration, "artist_gap": p.artist_gap, "album_gap": p.album_gap},
    }


def from_snapshot(data: dict | None, fallback_mode: str) -> ModeProfile:
    """A session's profile from its snapshot, re-clamped; the built-in mode if anything is off."""
    base = MODES.get(fallback_mode, MODES["panda"])
    try:
        stored = data["profile"]
        weights = {k: float(v) for k, v in stored["weights"].items() if k in asdict(base.weights)}
        for name in weights:
            weights[name] = _clamp(weights[name], WEIGHT_MIN, WEIGHT_MAX) if name not in _PROTECTED else getattr(base.weights, name)
        return replace(
            base,
            label=str(data.get("name") or base.label)[:80],
            weights=replace(base.weights, **weights),
            pool_size=int(_clamp(int(stored["pool_size"]), POOL_MIN, POOL_MAX)),
            temperature=_clamp(float(stored["temperature"]), TEMP_MIN, TEMP_MAX),
            base_exploration=_clamp(float(stored["base_exploration"]), EXPLORE_MIN, EXPLORE_MAX),
            artist_gap=int(_clamp(int(stored["artist_gap"]), MIN_ARTIST_GAP, MAX_ARTIST_GAP)),
            album_gap=int(_clamp(int(stored["album_gap"]), MIN_ALBUM_GAP, MAX_ALBUM_GAP)),
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return base


def preset_reasons(name: str, controls: dict[str, int]) -> list[str]:
    """One plain sentence about what a custom preset leans towards (for "Why this song?")."""
    leanings = [
        ("familiarity", 70, "favors songs you already love"),
        ("discovery", 70, "leans towards songs you rarely play"),
        ("continuity", 75, "keeps a steady flow"),
        ("wildcards", 70, "mixes in wildcards"),
        ("artist_variety", 75, "keeps artists varied"),
    ]
    strongest = max(((controls.get(k, 0) - limit, phrase) for k, limit, phrase in leanings if controls.get(k, 0) >= limit), default=None)
    return [f"{name} {strongest[1]}"] if strongest else []
