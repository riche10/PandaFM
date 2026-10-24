"""Custom radio presets: six controls translated into bounded Stage 3 profiles."""

from dataclasses import asdict

import pytest

from app.radio.config import MODES
from app.radio.presets import (
    CONTROLS, DEFAULT_CONTROLS, MIN_ALBUM_GAP, MIN_ARTIST_GAP, POOL_MAX, POOL_MIN, TEMP_MAX, WEIGHT_MAX, WEIGHT_MIN,
    clean_controls, effective_profile, from_snapshot, preset_reasons, snapshot,
)

PROTECTED = ("recent_track", "recent_album", "skip_history", "session_skip")


@pytest.mark.parametrize("mode", sorted(MODES))
def test_a_preset_left_at_its_base_defaults_is_exactly_the_built_in(mode):
    p = effective_profile(mode, DEFAULT_CONTROLS[mode], "Mine")
    base = MODES[mode]
    assert asdict(p.weights) == pytest.approx(asdict(base.weights))
    assert (p.pool_size, p.temperature, p.base_exploration, p.artist_gap, p.album_gap) == (base.pool_size, base.temperature, base.base_exploration, base.artist_gap, base.album_gap)
    assert p.id == mode and p.label == "Mine"


@pytest.mark.parametrize("mode", sorted(MODES))
@pytest.mark.parametrize("value", [0, 100])
def test_extremes_stay_inside_hard_limits(mode, value):
    p = effective_profile(mode, dict.fromkeys(CONTROLS, value))
    weights = asdict(p.weights)
    for name, w in weights.items():
        if name in PROTECTED:
            assert w == getattr(MODES[mode].weights, name)  # repetition penalties untouched
        else:
            assert WEIGHT_MIN <= w <= WEIGHT_MAX
    assert p.artist_gap >= MIN_ARTIST_GAP and p.album_gap >= MIN_ALBUM_GAP
    assert POOL_MIN <= p.pool_size <= POOL_MAX and 0 < p.temperature <= TEMP_MAX and 0 <= p.base_exploration <= 0.8


def test_controls_move_the_engine_the_way_their_names_say():
    base = DEFAULT_CONTROLS["panda"]
    more = lambda name, v: effective_profile("panda", {**base, name: v})  # noqa: E731
    assert more("familiarity", 100).weights.favorite > more("familiarity", 0).weights.favorite
    assert more("discovery", 100).weights.discovery > more("discovery", 0).weights.discovery
    assert more("continuity", 100).weights.continuity > more("continuity", 0).weights.continuity
    assert more("artist_variety", 100).artist_gap > more("artist_variety", 0).artist_gap
    assert more("genre_variety", 100).weights.seed_genre < more("genre_variety", 0).weights.seed_genre
    assert more("wildcards", 100).weights.randomness > more("wildcards", 0).weights.randomness


def test_controls_are_cleaned():
    assert clean_controls("study", {"familiarity": 500, "discovery": -3, "continuity": "abc", "bogus": 9}) == {
        **DEFAULT_CONTROLS["study"], "familiarity": 100, "discovery": 0}


def test_snapshots_round_trip_and_tampering_is_clamped():
    controls = {**DEFAULT_CONTROLS["familiar"], "wildcards": 80}
    snap = snapshot("familiar", controls, "Night Drive")
    assert asdict(from_snapshot(snap, "familiar")) == asdict(effective_profile("familiar", controls, "Night Drive"))
    snap["profile"]["weights"]["recent_track"] = 0  # try to switch off repeat protection
    snap["profile"]["artist_gap"] = 0
    snap["profile"]["pool_size"] = 10_000
    p = from_snapshot(snap, "familiar")
    assert p.weights.recent_track == MODES["familiar"].weights.recent_track and p.artist_gap == MIN_ARTIST_GAP and p.pool_size == POOL_MAX
    assert from_snapshot({"profile": "garbage"}, "study") == MODES["study"]


def test_preset_reasons_name_the_strongest_leaning():
    assert preset_reasons("Night Drive", {**DEFAULT_CONTROLS["panda"], "familiarity": 90}) == ["Night Drive favors songs you already love"]
    assert preset_reasons("Plain", DEFAULT_CONTROLS["panda"]) == []
