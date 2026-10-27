"""Panda DJ's transition planner: conservative when unsure, never forced."""

from app.mix.planner import plan, validate_override


def analysis(bpm=128.0, conf=0.8, dur=240000, lead=0, trail=0, intro=0.8, outro=0.8, key="8A", key_conf=0.6, fade=False):
    return {"duration_ms": dur, "leading_silence_ms": lead, "trailing_silence_ms": trail, "audible_start_ms": lead, "audible_end_ms": dur - trail,
            "bpm": bpm, "bpm_confidence": conf, "first_beat_ms": 100 if conf >= 0.45 else None, "beat_interval_ms": round(60000 / bpm, 2) if bpm and conf >= 0.45 else None,
            "key_camelot": key, "key_confidence": key_conf, "intro_suitability": intro, "outro_suitability": outro, "fade_out": fade}


A = {"id": "a", "duration_seconds": 240, "genres": ["House"]}
B = {"id": "b", "duration_seconds": 240, "genres": ["Tech House"]}
ROCK_A = {"id": "r1", "duration_seconds": 200, "genres": ["Rock"]}
ROCK_B = {"id": "r2", "duration_seconds": 200, "genres": ["Acoustic"]}


def test_close_confident_dance_tempos_get_a_long_beat_aligned_blend():
    p = plan(A, B, analysis(150), analysis(151, key="9A"), "auto")
    assert p["type"] in ("bass_handoff", "deep_blend") and p["overlap_ms"] >= 8000
    assert p["confidence"] >= 0.7 and "150 → 151 BPM" in p["summary"]
    assert p["tempo_ratio_out"] == p["tempo_ratio_in"] == 1.0  # 5.2 never time-stretches


def test_half_time_is_compatible():
    p = plan(A, B, analysis(75), analysis(150), "flow")
    assert p["type"] not in ("quick_switch", "clean_handoff")


def test_very_different_tempos_stay_conservative():
    p = plan(A, B, analysis(90), analysis(160), "auto")
    assert p["type"] == "quick_switch" and p["overlap_ms"] <= 2000
    assert "tempo" in p["explanation"].lower()
    assert plan(A, B, analysis(90), analysis(160), "energetic")["type"] == "filter_glide"


def test_unknown_rhythm_means_a_clean_handoff():
    p = plan(ROCK_A, ROCK_B, analysis(None, conf=0.0, dur=200000), analysis(None, conf=0.0, dur=200000), "auto")
    assert p["type"] == "clean_handoff" and p["overlap_ms"] <= 1500
    assert "isn’t sure" in p["explanation"]


def test_missing_analysis_is_a_safe_fixed_crossfade():
    p = plan(A, B, None, None, "auto")
    assert (p["type"], p["overlap_ms"], p["outgoing_start_ms"], p["ready"], p["curve"]) == ("smooth_blend", 4000, 236000, False, "equal_power")
    assert p["confidence"] <= 0.3


def test_trailing_silence_is_never_waited_through():
    p = plan(ROCK_A, ROCK_B, analysis(None, conf=0.0, dur=200000, trail=12000), analysis(None, conf=0.0, dur=200000), "auto")
    assert p["outgoing_start_ms"] + p["overlap_ms"] <= 188000


def test_continuous_album_tracks_are_gapless():
    a = {"id": "l1", "album_id": "live", "track_number": 3, "duration_seconds": 300}
    b = {"id": "l2", "album_id": "live", "track_number": 4, "duration_seconds": 280}
    p = plan(a, b, analysis(dur=300000, trail=50), analysis(dur=280000, lead=40), "auto")
    assert p["type"] == "gapless" and p["overlap_ms"] == 0 and p["summary"] == "Gapless"


def test_gentle_stays_short_and_plain():
    for b_bpm in (128, 129, 90):
        p = plan(A, B, analysis(128), analysis(b_bpm), "gentle")
        assert p["overlap_ms"] <= 6000 and p["filter"] is None


def test_plans_are_directional():
    ab = plan(A, B, analysis(128, dur=240000), analysis(128, dur=300000, lead=3000), "flow")
    ba = plan(B, A, analysis(128, dur=300000, lead=3000), analysis(128, dur=240000), "flow")
    assert (ab["from"], ab["to"]) == ("a", "b") and (ba["from"], ba["to"]) == ("b", "a")
    assert ab["outgoing_start_ms"] != ba["outgoing_start_ms"]


def test_overrides_are_bounded_to_the_songs():
    o = validate_override({"type": "deep_blend", "overlap_ms": 99999, "outgoing_start_ms": 10**9, "incoming_start_ms": -5, "filter": "nope"}, 200000, 180000)
    assert o["manual"] is True and o["overlap_ms"] == 60000 and o["outgoing_start_ms"] == 140000 and o["incoming_start_ms"] == 0 and o["filter"] is None
