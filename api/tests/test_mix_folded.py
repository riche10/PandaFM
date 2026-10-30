"""Panda Mix 5.5.1: half/double-time pairs are first-class, and the drift math is done after folding.

Rules, not magic numbers: folded pairs get what an equal-tempo pair gets; only real limits (a tempo
difference left after folding, vocals, a weak beat grid) shorten them, and the reasons say which.
"""

import pytest

from app.mix.planner import DRIFT_BUDGET_MS, plan

DNB = {"id": "x", "duration_seconds": 240, "genres": ["Drum and Bass"]}


def an(bpm, vocal=0.1, bass=0.3, grid=0.8, conf=0.9, db=0.7):
    """A strong analysis by default (clear tempo, beat grid and bars), every beat and bar from 0 ms."""
    beat = 60000 / bpm
    prof = {"step_ms": 2000, "loud_db": [0] * 120, "bass": [bass] * 120, "vocal": [vocal] * 120}
    return {"duration_ms": 240000, "audible_start_ms": 0, "audible_end_ms": 239000, "mix_out_ms": 236000, "mix_in_ms": 0,
            "trailing_silence_ms": 1000, "leading_silence_ms": 0, "bpm": bpm, "bpm_confidence": conf, "first_beat_ms": 0,
            "beat_interval_ms": beat, "beat_grid_confidence": grid, "first_downbeat_ms": 0, "downbeat_confidence": db, "meter": 4,
            "downbeat_index": 0, "intro_grid": [0.0, beat], "outro_grid": [0.0, beat], "ending": "hard", "integrated_lufs": -9.0,
            "key_camelot": None, "key_confidence": 0.0, "profile": prof}


def mix(a, b, mode="auto", **kw):
    return plan(DNB, DNB, an(a, **kw), an(b, **kw), mode)


@pytest.mark.parametrize("a,b", [(174, 87), (87, 174), (140, 70), (150, 75)])
@pytest.mark.parametrize("mode", ["auto", "flow", "energetic"])
def test_exact_half_double_time_gets_what_equal_tempos_get(a, b, mode):
    p, same = mix(a, b, mode), mix(a, a, mode)
    assert p["tier"] in ("moderate", "deep") and p["tier"] == same["tier"]
    assert p["facts"]["folded"] and any("(half/double time)" in r for r in p["reasons"])
    assert p["facts"]["beat_ms_in_folded"] == pytest.approx(p["facts"]["beat_ms_out"], abs=0.5)  # effective beats match
    assert not any("drift" in r for r in p["reasons"])


def test_the_effective_beat_is_compared_after_folding():
    f = mix(174, 85)["facts"]
    assert f["beat_ms_out"] == pytest.approx(60000 / 174, abs=0.01)
    assert f["beat_ms_in_folded"] == pytest.approx(60000 / 170, abs=0.01)  # 85 counted as 170, not as 705.9 ms
    assert f["drift_ms_per_beat"] == pytest.approx(abs(60000 / 174 - 60000 / 170), abs=0.1)


@pytest.mark.parametrize("mode", ["gentle", "auto", "flow", "energetic"])
def test_folding_is_no_penalty_174_to_85_plans_like_174_to_170(mode):
    folded, plain = mix(174, 85, mode), mix(174, 170, mode)
    assert (folded["tier"], folded["overlap_ms"]) == (plain["tier"], plain["overlap_ms"])


def test_a_tempo_gap_left_after_folding_is_named_as_the_limit():
    p = mix(174, 85, "energetic")
    limits = next(r for r in p["reasons"] if r.startswith("Limited by:"))
    assert "after folding" in limits and "ms per beat" in limits
    assert p["reasons"][-1].startswith("Result:")


def test_vocals_overlapping_heavily_keep_a_folded_pair_short_and_say_so():
    p = mix(174, 85, "energetic", vocal=0.8)
    assert p["overlap_ms"] <= 4000
    assert "Vocals: overlap heavily" in p["reasons"]
    assert "Vocals on both sides" in next(r for r in p["reasons"] if r.startswith("Limited by:"))


def test_a_weak_beat_grid_keeps_a_folded_pair_short_or_clean():
    p = mix(174, 85, "energetic", grid=0.1)
    assert p["tier"] in ("short", "clean") and p["overlap_ms"] <= 4000
    assert "Beat grid: weak" in p["reasons"] and p.get("aligned") == "time"


def _slips(p, tA, tB_eff):
    """Signed distance (ms) from each of A's beats inside the overlap to the nearest of B's (folded) beats."""
    out = []
    k = int(p["outgoing_start_ms"] // tA) + 1
    while k * tA - p["outgoing_start_ms"] <= p["overlap_ms"]:
        w = k * tA - p["outgoing_start_ms"]  # wall time of A's beat, from the blend's start
        bpos = p["incoming_start_ms"] + w  # where B is then
        j = round(bpos / tB_eff)
        out.append((w, bpos - j * tB_eff))
        k += 1
    return out


@pytest.mark.parametrize("mode", ["auto", "energetic"])
@pytest.mark.parametrize("a,b", [(174, 85), (126, 127)])
def test_beats_meet_at_the_midpoint_and_never_slip_past_the_budget(mode, a, b):
    p = mix(a, b, mode)
    tA, tB = 60000 / a, p["facts"]["beat_ms_in_folded"]
    slips = _slips(p, tA, tB)
    mid = min(slips, key=lambda s: abs(s[0] - p["overlap_ms"] / 2))
    assert abs(mid[1]) <= 6, slips
    assert max(abs(s) for _, s in slips) <= DRIFT_BUDGET_MS[mode] + 2
