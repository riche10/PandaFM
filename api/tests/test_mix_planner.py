"""Panda DJ's transition planner (5.3): audible when it should be, conservative when it must be."""

import importlib.util
import sys

import numpy as np

from app.mix.analysis import SR, analyze_pcm
from app.mix.planner import fallback, plan, validate_override


def analysis(bpm=128.0, conf=0.8, dur=240000, lead=0, trail=0, intro=0.8, outro=0.8, key="8A", key_conf=0.6, fade=False, mix_out=None):
    return {"duration_ms": dur, "leading_silence_ms": lead, "trailing_silence_ms": trail, "audible_start_ms": lead, "audible_end_ms": dur - trail,
            "mix_out_ms": mix_out if mix_out is not None else dur - trail, "mix_in_ms": lead,
            "bpm": bpm, "bpm_confidence": conf, "first_beat_ms": 100 if conf >= 0.45 else None, "beat_interval_ms": round(60000 / bpm, 2) if bpm and conf >= 0.45 else None,
            "key_camelot": key, "key_confidence": key_conf, "intro_suitability": intro, "outro_suitability": outro, "fade_out": fade}


A = {"id": "a", "duration_seconds": 240, "genres": ["House"]}
B = {"id": "b", "duration_seconds": 240, "genres": ["Tech House"]}
POP_A = {"id": "p1", "duration_seconds": 240, "genres": ["Pop"]}
POP_B = {"id": "p2", "duration_seconds": 240, "genres": ["Pop"]}


def test_close_confident_dance_tempos_get_a_long_beat_aligned_blend():
    p = plan(A, B, analysis(150), analysis(151, key="9A"), "auto")
    assert p["type"] == "bass_handoff" and p["overlap_ms"] >= 12000 and p["source"] == "smart" and not p["intentional"]
    assert "150 → 151 BPM" in p["summary"] and p["tempo_ratio_out"] == p["tempo_ratio_in"] == 1.0
    assert plan(A, B, analysis(150), analysis(151, key="9A"), "energetic")["overlap_ms"] > p["overlap_ms"]


def test_half_time_is_compatible():
    assert plan(A, B, analysis(75), analysis(150), "flow")["type"] not in ("quick_switch", "clean_handoff")


def test_very_different_tempos_stay_conservative_on_purpose():
    p = plan(POP_A, POP_B, analysis(90), analysis(160), "auto")
    assert p["type"] == "quick_switch" and p["overlap_ms"] <= 3000 and p["intentional"]
    assert plan(A, B, analysis(90), analysis(160), "energetic")["type"] == "filter_glide"


def test_unclear_rhythm_hands_over_cleanly_only_when_the_song_ends_abruptly():
    abrupt = plan(POP_A, POP_B, analysis(None, conf=0.0, outro=0.2), analysis(None, conf=0.0), "auto")
    assert abrupt["type"] == "clean_handoff" and abrupt["intentional"]
    fading = plan(POP_A, POP_B, analysis(None, conf=0.0, mix_out=228000, trail=2000), analysis(None, conf=0.0), "auto")
    assert fading["type"] == "smooth_blend" and fading["overlap_ms"] >= 5000 and not fading["intentional"]  # under a fade: an audible blend


def test_the_fallback_is_a_recognisable_blend_that_avoids_the_tail():
    p = plan(A, B, None, None, "auto")
    assert (p["type"], p["overlap_ms"], p["outgoing_start_ms"], p["ready"], p["source"]) == ("smooth_blend", 5000, 232000, False, "fallback")
    assert fallback(A, B, "gentle")["overlap_ms"] == 3500
    assert fallback({"id": "s", "duration_seconds": 5}, B)["overlap_ms"] == 0  # a 5 s clip: no blend


def test_trailing_silence_and_fades_are_never_waited_through():
    p = plan(POP_A, POP_B, analysis(None, conf=0.0, trail=12000), analysis(None, conf=0.0), "auto")
    assert p["outgoing_start_ms"] + p["overlap_ms"] <= 228000
    faded = plan(POP_A, POP_B, analysis(120, conf=0.7, mix_out=216000, trail=2000), analysis(122, conf=0.7), "flow")
    assert faded["outgoing_start_ms"] + faded["overlap_ms"] <= 216000 + 4000  # ends near the musical end, not in the fade


def test_continuous_album_tracks_are_gapless():
    a = {"id": "l1", "album_id": "live", "track_number": 3, "duration_seconds": 300}
    b = {"id": "l2", "album_id": "live", "track_number": 4, "duration_seconds": 280}
    p = plan(a, b, analysis(dur=300000, trail=50), analysis(dur=280000, lead=40), "auto")
    assert p["type"] == "gapless" and p["overlap_ms"] == 0 and p["summary"] == "Gapless" and p["intentional"]


def test_the_personalities_are_meaningfully_different():
    near = [plan(POP_A, POP_B, analysis(120, conf=0.7), analysis(123, conf=0.7), m)["overlap_ms"] for m in ("gentle", "auto", "flow", "energetic")]
    assert near == sorted(near) and len(set(near)) == 4, near  # Gentle < Auto < Flow < Energetic
    for b_bpm in (128, 129, 90):
        p = plan(A, B, analysis(128), analysis(b_bpm), "gentle")
        assert p["overlap_ms"] <= 4000 and p["filter"] is None


def test_plans_are_directional():
    ab = plan(A, B, analysis(128, dur=240000), analysis(128, dur=300000, lead=3000), "flow")
    ba = plan(B, A, analysis(128, dur=300000, lead=3000), analysis(128, dur=240000), "flow")
    assert (ab["from"], ab["to"]) == ("a", "b") and (ba["from"], ba["to"]) == ("b", "a")
    assert ab["outgoing_start_ms"] != ba["outgoing_start_ms"]


def test_overrides_are_bounded_to_the_songs():
    o = validate_override({"type": "deep_blend", "overlap_ms": 99999, "outgoing_start_ms": 10**9, "incoming_start_ms": -5, "filter": "nope"}, 200000, 180000)
    assert o["manual"] is True and o["source"] == "manual" and o["overlap_ms"] == 60000 and o["outgoing_start_ms"] == 140000 and o["incoming_start_ms"] == 0


def _measure():
    spec = importlib.util.spec_from_file_location("mixmeasure_song", __file__)  # noqa: F841  (song generator below)


def _song(seed: int, fade: float, bpm: float = 118, clarity: float = 0.35) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(180 * SR)
    t = np.arange(n) / SR
    body = 0.25 * np.sin(2 * np.pi * 196 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.1 * t)) + 0.08 * rng.standard_normal(n)
    hit = rng.standard_normal(int(0.03 * SR)) * np.exp(-np.linspace(0, 5, int(0.03 * SR)))
    k = 0.0
    while k * SR + hit.size < n:
        i = int(k * SR)
        body[i:i + hit.size] += clarity * hit
        k += 60 / bpm
    env = np.ones(n)
    tail = int(1.5 * SR)
    if fade:
        f0 = n - tail - int(fade * SR)
        env[f0:n - tail] = np.linspace(1, 0, n - tail - f0)
    env[n - tail:] = 0
    return (body * env).astype(np.float32)


def _level(x, a_ms, b_ms):
    seg = x[int(a_ms / 1000 * SR):int(b_ms / 1000 * SR)]
    return 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9)


def test_song_a_is_still_audible_during_the_blend():
    """The 5.2 regression: blends landed inside A's fade (fallback: A ~22 dB down), sounding like plain playback."""
    for seed, fade, clarity in ((1, 10, 0.35), (3, 4, 0.0)):
        a, b = _song(seed, fade, clarity=clarity), _song(seed + 1, 2, bpm=121, clarity=clarity)
        aa, ba = analyze_pcm(a), analyze_pcm(b)
        body = _level(a, 30000, 150000)
        meta_a, meta_b = {"id": "a", "duration_seconds": 180, "genres": ["Pop"]}, {"id": "b", "duration_seconds": 180, "genres": ["Pop"]}
        for p in (plan(meta_a, meta_b, aa, ba, "auto"), plan(meta_a, meta_b, aa, ba, "flow"), fallback(meta_a, meta_b, "auto")):
            s, o = p["outgoing_start_ms"], p["overlap_ms"]
            assert o >= 5000, p
            assert _level(a, s, s + o) - body > -8, (p["source"], p["type"], s, o)


_ = sys



# ── 5.4: loudness, keys and sections shape the plan, and it explains itself ──
def test_a_big_loudness_gap_shortens_the_blend_and_says_so():
    a, b = {**analysis(120, conf=0.7), "integrated_lufs": -16.0}, {**analysis(122, conf=0.7), "integrated_lufs": -6.0}
    p = plan(POP_A, POP_B, a, b, "flow")
    assert p["overlap_ms"] <= 8000 and any("louder" in r for r in p["reasons"]) and any("loudness" in r for r in p["reasons"])


def test_a_confident_key_clash_keeps_harmonic_blends_short():
    clash = plan(A, B, analysis(128, key="8A", key_conf=0.8), analysis(128, key="3B", key_conf=0.8), "energetic")
    fit = plan(A, B, analysis(128, key="8A", key_conf=0.8), analysis(128, key="9A", key_conf=0.8), "energetic")
    assert clash["overlap_ms"] <= 8000 < fit["overlap_ms"]
    assert any("clash" in r for r in clash["reasons"])


def test_plans_explain_themselves_with_confident_facts_only():
    p = plan(POP_A, POP_B, {**analysis(128, key="8A"), "key": "A minor"}, {**analysis(130, key="9A"), "key": "E minor"}, "auto")
    assert "Tempo: 128 → 130 BPM" in p["reasons"] and "Key: 8A → 9A (compatible)" in p["reasons"]
    assert p["key_name_out"] == "A minor" and p["key_name_in"] == "E minor"
    unsure = plan(POP_A, POP_B, analysis(None, conf=0.0, key_conf=0.1), analysis(None, conf=0.0, key_conf=0.1), "auto")
    assert "Tempo uncertain" in unsure["reasons"] and "Key uncertain" in unsure["reasons"] and unsure["key_name_out"] is None
