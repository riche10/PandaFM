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


def test_half_time_is_compatible():
    assert plan(A, B, analysis(75), analysis(150), "flow")["type"] not in ("quick_switch", "clean_handoff")


def test_the_fallback_is_a_recognisable_blend_that_avoids_the_tail():
    p = plan(A, B, None, None, "auto")
    assert (p["type"], p["overlap_ms"], p["outgoing_start_ms"], p["ready"], p["source"]) == ("smooth_blend", 5000, 232000, False, "fallback")
    assert fallback(A, B, "gentle")["overlap_ms"] == 3500
    assert fallback({"id": "s", "duration_seconds": 5}, B)["overlap_ms"] == 0  # a 5 s clip: no blend


def test_continuous_album_tracks_are_gapless():
    a = {"id": "l1", "album_id": "live", "track_number": 3, "duration_seconds": 300}
    b = {"id": "l2", "album_id": "live", "track_number": 4, "duration_seconds": 280}
    p = plan(a, b, analysis(dur=300000, trail=50), analysis(dur=280000, lead=40), "auto")
    assert p["type"] == "gapless" and p["overlap_ms"] == 0 and p["summary"] == "Gapless" and p["intentional"]


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
            assert o >= 1500, p  # 5.5: the length follows the evidence; the rule is that A stays audible
            assert _level(a, s, s + o) - body > -8, (p["source"], p["type"], s, o)


_ = sys



# ── 5.4: loudness, keys and sections shape the plan, and it explains itself ──
