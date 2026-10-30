"""Panda Mix 5.5: analysis accuracy and planner rules on generated songs with known ground truth.

The tests check musical rules (bar alignment, drift, collisions, levelling, endings), not magic numbers.
"""

import numpy as np
import pytest

from app.mix.analysis import analyze_pcm
from app.mix.planner import DRIFT_BUDGET_MS, plan
from tests.mix_corpus import Section, Song, render, standard, vocal_heavy

SONGS = {
    "A": standard(126, 1.3, 1, name="A"),
    "B": standard(127, 0.4, 2, name="B", gain_db=-7),
    "C": standard(128, 2.1, 3, name="C", ending="fade"),
    "D": standard(124, 0.9, 4, name="D", ending="sustain"),
    "E": vocal_heavy(100, 0.6, 5, name="E"),
    "F": vocal_heavy(102, 0.2, 6, name="F", ending="sustain"),
    "G": standard(90, 0.7, 7, name="G"),
    "H": standard(140, 1.9, 8, name="H"),
    "I": standard(126, 0.5, 9, name="I"),
    "P": vocal_heavy(110, 0.3, 10, name="P", ending="hard"),  # a pop song with a hard final hit
}


@pytest.fixture(scope="module")
def an():
    out = {}
    for k, s in SONGS.items():
        a = analyze_pcm(render(s))
        a["integrated_lufs"] = -10.0 + s.gain_db  # ffmpeg's EBU R128 runs on files; generated songs carry it here
        out[k] = a
    return out


def facts(k):
    s = SONGS[k]
    return {"id": k, "duration_seconds": s.duration, "genres": list(s.genres)}


def mix(an, a, b, mode="auto"):
    return plan(facts(a), facts(b), an[a], an[b], mode)


def _beat_err_ms(grid, beats, region):
    first, beat = grid
    errs = [abs(first + round((b * 1000 - first) / beat) * beat - b * 1000) for b in beats if region[0] <= b <= region[1]]
    return float(np.median(errs))


# ── analysis accuracy ──
def test_tempo_beats_and_downbeats_where_panda_mixes(an):
    for k, s in SONGS.items():
        a = an[k]
        assert abs(a["bpm"] - s.bpm) <= 0.1, (k, a["bpm"])
        assert _beat_err_ms(a["intro_grid"], s.beats(), (0, 30)) <= 25, k
        assert _beat_err_ms(a["outro_grid"], s.beats(), (s.body_end - 30, s.body_end)) <= 25, k
        if a["downbeat_confidence"] >= 0.4:  # when Panda trusts bars, they're the right bars
            bar = 60 / s.bpm * s.meter
            d = (a["first_downbeat_ms"] / 1000 - s.first_downbeat) % bar
            assert min(d, bar - d) <= 0.03, (k, a["first_downbeat_ms"])


def test_the_section_profile_hears_vocals_and_sustained_bass(an):
    s, p = SONGS["A"], an["A"]["profile"]
    step = p["step_ms"] / 1000
    voc_in, voc_out, bass_kick_only = [], [], []
    for i, v in enumerate(p["vocal"]):
        layers = s.layer_at(i * step + step / 2)
        (voc_in if "vocal" in layers else voc_out).append(v)
        if layers == ("kick", "hat"):
            bass_kick_only.append(p["bass"][i])
    assert np.median(voc_in) >= 0.4 and np.median(voc_out) <= 0.15
    assert max(bass_kick_only) <= 0.2  # kicks are not a bassline


def test_endings_are_classified(an):
    assert an["C"]["ending"] == "fade" and an["D"]["ending"] == "sustain" and an["A"]["ending"] == "hard"


# ── planner rules ──
def _lands_on_bar(an, p, a, b):
    """Does B's first downbeat (at or after its start) land on one of A's bars?"""
    A, B = SONGS[a], SONGS[b]
    bar_a, bar_b = 60 / A.bpm * 4, 60 / B.bpm * 4
    lead = (B.first_downbeat - p["incoming_start_ms"] / 1000) % bar_b
    d = (p["outgoing_start_ms"] / 1000 + lead - A.first_downbeat) % bar_a
    # 5.5.1: centred on the midpoint, so at the start B may sit up to max_slip_ms off A's bar
    return min(d, bar_a - d) <= 0.04 + (p["facts"].get("max_slip_ms") or 0) / 1000


def test_same_tempo_and_clear_bars_allow_a_long_bar_aligned_blend(an):
    for mode in ("auto", "energetic"):
        p = mix(an, "A", "I", mode)
        assert p["tier"] == "deep" and p["overlap_ms"] >= 12000 and _lands_on_bar(an, p, "A", "I"), mode
    assert mix(an, "A", "I", "gentle")["overlap_ms"] <= 4000


def test_near_tempos_never_drift_past_the_budget_and_personalities_differ(an):
    lengths = []
    for mode in ("gentle", "auto", "energetic"):
        p = mix(an, "A", "B", mode)
        beats = p["overlap_ms"] / (60000 / 126)
        drift = beats * abs(60000 / 126 - 60000 / 127)
        # 5.5.1: aligned at the midpoint, so the worst slip (at either end) is half the total drift
        assert drift / 2 <= DRIFT_BUDGET_MS[mode] + 1, (mode, drift)
        assert (p["facts"]["max_slip_ms"] or 0) <= DRIFT_BUDGET_MS[mode] + 1
        assert _lands_on_bar(an, p, "A", "B")
        lengths.append(p["overlap_ms"])
    assert lengths == sorted(lengths) and len(set(lengths)) == 3


def test_far_tempos_hand_over_quickly_on_purpose(an):
    for mode in ("gentle", "auto", "energetic"):
        p = mix(an, "A", "G", mode)
        assert p["type"] in ("quick_switch", "clean_handoff") and p["intentional"] and p["overlap_ms"] <= 2500


def test_vocals_on_both_sides_stay_short(an):
    for mode in ("auto", "energetic"):
        assert mix(an, "E", "F", mode)["overlap_ms"] <= 4000


def test_loudness_is_levelled_by_attenuation_only(an):
    down = mix(an, "A", "B")  # B is 7 LU quieter: A is brought down towards it
    up = mix(an, "B", "C")  # C is 7 LU louder: C comes in lower
    assert down["gain_out_db"] == pytest.approx(-7, abs=0.6) and down["gain_in_db"] == 0
    assert up["gain_in_db"] == pytest.approx(-7, abs=0.6) and up["gain_out_db"] == 0
    for p in (down, up, mix(an, "A", "I")):
        assert p["gain_out_db"] <= 0 and p["gain_in_db"] <= 0  # never a boost: no clipping


def test_a_held_final_note_rings_out_under_the_next_song(an):
    p = mix(an, "D", "A")
    assert p["curve"] == "under_tail" and p["outgoing_start_ms"] >= an["D"]["last_hit_ms"] - 50
    assert p["outgoing_start_ms"] + p["overlap_ms"] <= an["D"]["audible_end_ms"] + 50


def test_a_hard_final_hit_is_not_buried_under_a_long_blend(an):
    p = mix(an, "P", "E", "energetic")
    assert p["tier"] in ("short", "clean") and p["overlap_ms"] <= 6000


def test_uncertain_rhythm_is_never_beat_matched():
    weak = {"duration_ms": 200000, "audible_start_ms": 0, "audible_end_ms": 199000, "mix_out_ms": 199000, "trailing_silence_ms": 1000,
            "leading_silence_ms": 0, "bpm": 120, "bpm_confidence": 0.2, "beat_interval_ms": None, "beat_grid_confidence": 0.0,
            "ending": "hard", "profile": None}
    p = plan({"id": "x", "duration_seconds": 200, "genres": ["Rock"]}, {"id": "y", "duration_seconds": 200, "genres": ["Rock"]}, weak, dict(weak), "energetic")
    assert p["tier"] in ("clean", "short") and p.get("aligned", "time") == "time" and p["overlap_ms"] <= 4000


def test_every_plan_explains_itself(an):
    for a, b in (("A", "I"), ("A", "B"), ("A", "G"), ("E", "F"), ("D", "A")):
        p = mix(an, a, b)
        assert p["reasons"] and p["explanation"] and p["tier"] in ("clean", "short", "moderate", "deep")
        assert {"tempo_diff_pct", "drift_budget_beats", "grid_confidence", "bars", "key_fit", "loudness_diff_lu"} <= set(p["facts"])


def test_saved_overrides_stay_within_the_songs_and_keep_their_curve():
    from app.mix.planner import validate_override

    v = validate_override({"type": "smooth_blend", "overlap_ms": 90000, "outgoing_start_ms": 500000, "incoming_start_ms": 400000, "curve": "sharp"},
                          200000, 180000)
    assert v["overlap_ms"] <= 60000
    assert v["outgoing_start_ms"] + v["overlap_ms"] <= 200000 and v["incoming_start_ms"] + v["overlap_ms"] <= 180000
    assert v["curve"] == "sharp" and v["manual"] is True
