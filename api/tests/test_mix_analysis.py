"""Panda DJ track analysis on small generated signals (no real music needed)."""

import subprocess
from pathlib import Path

import numpy as np
import pytest

from app.mix.analysis import SR, AnalysisError, analyze_file, analyze_pcm, parse_ebur128, tempo_ratio


def click_track(bpm: float, seconds: float, lead_s: float = 0.0, trail_s: float = 0.0, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    body = np.zeros(int(seconds * SR), dtype=np.float32)
    beat = 60.0 / bpm
    burst = (rng.standard_normal(int(0.02 * SR)) * np.exp(-np.linspace(0, 6, int(0.02 * SR)))).astype(np.float32)
    t = 0.25
    while t * SR + burst.size < body.size:
        i = int(t * SR)
        body[i:i + burst.size] += 0.8 * burst
        t += beat
    body += 0.05 * np.sin(2 * np.pi * 220 * np.arange(body.size) / SR).astype(np.float32)  # a quiet bed
    return np.concatenate([np.zeros(int(lead_s * SR), np.float32), body, np.zeros(int(trail_s * SR), np.float32)])


def test_tempo_silence_beats_and_waveform_from_a_click_track():
    a = analyze_pcm(click_track(128, 30, lead_s=2, trail_s=5))
    assert abs(tempo_ratio(128, a["bpm"]) - 1) < 0.012  # 128 (or its half/double), within ~1.5 BPM
    assert a["bpm_confidence"] >= 0.45
    assert a["beat_interval_ms"] and a["first_beat_ms"] is not None
    assert abs(a["leading_silence_ms"] - 2000) < 150 and abs(a["trailing_silence_ms"] - 5000) < 150
    assert a["audible_end_ms"] == a["duration_ms"] - a["trailing_silence_ms"]
    assert len(a["waveform"]) == 512 and max(a["waveform"]) == 1.0 and min(a["waveform"]) == 0.0
    assert len(str(a["waveform"])) < 4000  # a drawing, not the audio


def test_unclear_rhythm_is_reported_as_unclear():
    rng = np.random.default_rng(3)
    noise = analyze_pcm((0.3 * rng.standard_normal(SR * 30)).astype(np.float32))
    clicks = analyze_pcm(click_track(124, 30))
    assert noise["bpm_confidence"] < clicks["bpm_confidence"]


def test_half_and_double_time_are_compatible():
    assert tempo_ratio(75, 150) == 1.0 and tempo_ratio(70, 140) == 1.0 and tempo_ratio(140, 70) == 1.0
    assert abs(tempo_ratio(147, 150) - 1) < 0.03
    assert abs(tempo_ratio(90, 160) - 1) > 0.08  # really different
    assert tempo_ratio(None, 120) is None


def test_key_of_a_c_major_chord():
    t = np.arange(SR * 12) / SR
    chord = sum(np.sin(2 * np.pi * f * t) for f in (261.63, 329.63, 392.0, 523.25)).astype(np.float32) * 0.2
    k = analyze_pcm(chord)
    assert k["key_camelot"] in ("8B", "8A")  # C major (or its relative A minor)
    assert 0 <= k["key_confidence"] <= 1


def test_ebur128_summary_parsing():
    stderr = "[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.5 LUFS\n\n  True peak:\n    Peak:       -0.7 dBFS\n"
    assert parse_ebur128(stderr) == (-14.2, -0.7)
    assert parse_ebur128("no summary") == (None, None)


def test_a_real_file_end_to_end_and_failures(tmp_path: Path):
    f = tmp_path / "tone.wav"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                    "-filter_complex", "[1]atrim=duration=2[s];[0][s]concat=n=2:v=0:a=1", str(f)], check=True)
    a = analyze_file(f)
    assert a["integrated_lufs"] is not None and a["integrated_lufs"] < 0
    assert abs(a["trailing_silence_ms"] - 2000) < 200
    bad = tmp_path / "bad.flac"
    bad.write_bytes(b"not audio at all")
    with pytest.raises(AnalysisError):
        analyze_file(bad)
    with pytest.raises(AnalysisError):
        analyze_pcm(np.zeros(100, np.float32))
