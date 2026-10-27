"""Track analysis for Panda Mix: deterministic, CPU-only, read-only.

ffmpeg decodes a private temporary copy (never the library file in place)
twice: once to small mono PCM for numpy, once through its EBU R128 filter for
loudness. Everything inferred carries a confidence; uncertain values are
reported as uncertain rather than guessed.
"""

import math
import os
import re
import subprocess
from pathlib import Path

import numpy as np

ANALYSIS_VERSION = 2  # 2 (5.3): musical mix-in/mix-out points
SR = 11025  # mono analysis rate: enough for rhythm, silence and loudness shape
HOP = 128  # ~11.6 ms frames for the onset envelope
WAVEFORM_BUCKETS = 512
CAMELOT = {  # (pitch class, major?) -> Camelot code
    **{(pc, True): code for pc, code in zip(range(12), ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"])},
    **{(pc, False): code for pc, code in zip(range(12), ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"])},
}
NOTE = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])  # Krumhansl–Kessler
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


class AnalysisError(Exception):
    pass


def _nice() -> None:  # analysis must yield to streaming and transcoding
    try:
        os.nice(15)
    except OSError:
        pass


def decode(path: Path, timeout: float = 300) -> np.ndarray:
    proc = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
                          capture_output=True, timeout=timeout, preexec_fn=_nice, check=False)
    if proc.returncode != 0 or not proc.stdout:
        raise AnalysisError("ffmpeg couldn’t decode this file")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def loudness(path: Path, timeout: float = 300) -> tuple[float | None, float | None]:
    """EBU R128 integrated loudness (LUFS) and true peak (dBTP) from ffmpeg's own filter."""
    proc = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
                          capture_output=True, text=True, timeout=timeout, preexec_fn=_nice, check=False)
    return parse_ebur128(proc.stderr)


def parse_ebur128(stderr: str) -> tuple[float | None, float | None]:
    summary = stderr[stderr.rfind("Summary:"):] if "Summary:" in stderr else ""
    i = re.search(r"I:\s*(-?[\d.]+|-inf)\s*LUFS", summary)
    p = re.search(r"Peak:\s*(-?[\d.]+|-inf)\s*dBFS", summary)
    val = lambda m: None if not m or m.group(1) == "-inf" else round(float(m.group(1)), 1)  # noqa: E731
    return val(i), val(p)


def analyze_file(path: Path) -> dict:
    samples = decode(path)
    result = analyze_pcm(samples, SR)
    lufs, peak = loudness(path)
    result["integrated_lufs"] = lufs
    if peak is not None:
        result["true_peak_db"] = peak
    return result


def analyze_pcm(x: np.ndarray, sr: int = SR) -> dict:
    """Everything Panda DJ needs from one track, as small metadata."""
    if x.size < sr:  # under a second: nothing to plan around
        raise AnalysisError("too short to analyse")
    x = np.nan_to_num(x.astype(np.float32))
    duration_ms = int(round(x.size * 1000 / sr))
    peak = float(np.max(np.abs(x))) or 1e-9
    frame = 512
    n = x.size // frame
    rms = np.sqrt(np.mean(x[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    threshold = max(-60.0, 20 * math.log10(peak) - 45)  # "audible": within 45 dB of the loudest moment
    loud = np.nonzero(db > threshold)[0]
    frame_ms = frame * 1000 / sr
    lead = int(loud[0] * frame_ms) if loud.size else 0
    trail = int((n - 1 - loud[-1]) * frame_ms) if loud.size else 0
    out = {
        "analysis_version": ANALYSIS_VERSION,
        "duration_ms": duration_ms,
        "leading_silence_ms": lead,
        "trailing_silence_ms": trail,
        "audible_start_ms": lead,
        "audible_end_ms": max(lead, duration_ms - trail),
        "peak_db": round(20 * math.log10(peak), 1),
        "waveform": waveform(x),
    }
    env = onset_envelope(x, sr)
    out.update(tempo(env, sr))
    out.update(key(x, sr))
    out.update(sections(x, sr, out, db, frame_ms))
    return out


def waveform(x: np.ndarray, buckets: int = WAVEFORM_BUCKETS) -> list[float]:
    """A compact peak envelope for drawing (a few KB; nothing like the audio itself)."""
    edges = np.linspace(0, x.size, buckets + 1).astype(int)
    peaks = [float(np.max(np.abs(x[a:b]))) if b > a else 0.0 for a, b in zip(edges[:-1], edges[1:])]
    top = max(peaks) or 1.0
    return [round(p / top, 3) for p in peaks]


def onset_envelope(x: np.ndarray, sr: int) -> np.ndarray:
    n_fft = 1024
    frames = 1 + max(0, (x.size - n_fft) // HOP)
    if frames < 8:
        return np.zeros(8)
    idx = np.arange(n_fft)[None, :] + HOP * np.arange(frames)[:, None]
    window = np.hanning(n_fft).astype(np.float32)
    spec = np.abs(np.fft.rfft(x[idx] * window, axis=1))
    logspec = np.log1p(100 * spec)
    flux = np.maximum(0.0, np.diff(logspec, axis=0)).sum(axis=1)
    flux = flux - np.convolve(flux, np.ones(16) / 16, mode="same")  # remove slow loudness changes
    flux = np.maximum(flux, 0)
    return flux / (flux.max() or 1.0)


def _comb(env: np.ndarray, period: float) -> float:
    t = np.arange(env.size - period - 1)
    shifted = np.interp(t + period, np.arange(env.size), env)
    return float(np.dot(env[: t.size], shifted) / max(1, t.size))


def tempo(env: np.ndarray, sr: int) -> dict:
    """BPM on a fine grid (60–200), with confidence; half/double time noted, never forced."""
    frame_rate = sr / HOP
    if env.size < frame_rate * 8 or not env.any():
        return {"bpm": None, "bpm_confidence": 0.0, "first_beat_ms": None, "beat_interval_ms": None}
    grid = np.arange(60.0, 200.0, 0.25)
    scores = np.array([_comb(env, frame_rate * 60 / b) for b in grid])
    prior = np.exp(-0.5 * (np.log2(grid / 120.0) / 0.9) ** 2)  # mild preference for common tempos, never decisive
    weighted = scores * (0.85 + 0.15 * prior)
    best = int(np.argmax(weighted))
    bpm = float(grid[best])
    baseline = float(np.median(scores)) or 1e-9
    contrast = (scores[best] - baseline) / (float(np.max(scores)) - baseline + 1e-9)
    sharpness = (scores[best] - baseline) / (baseline + 1e-9)
    confidence = float(max(0.0, min(1.0, 0.5 * contrast + 0.5 * min(1.0, sharpness / 3))))
    period = frame_rate * 60 / bpm
    phases = np.arange(0, period, 1.0)
    picks = [env[np.round(np.arange(p, env.size, period)).astype(int).clip(0, env.size - 1)].mean() for p in phases]
    phase = float(phases[int(np.argmax(picks))])
    reliable = confidence >= 0.45
    return {
        "bpm": round(bpm, 1),
        "bpm_confidence": round(confidence, 2),
        "first_beat_ms": int(round(phase / frame_rate * 1000)) if reliable else None,
        "beat_interval_ms": round(60000 / bpm, 2) if reliable else None,
    }


def key(x: np.ndarray, sr: int) -> dict:
    """Musical key from an averaged chroma vector; confidence is how clearly it beats the runner-up."""
    n_fft = 4096
    hop = 2048
    frames = 1 + max(0, (x.size - n_fft) // hop)
    if frames < 4:
        return {"key": None, "key_camelot": None, "key_confidence": 0.0}
    idx = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * np.hanning(n_fft), axis=1)).mean(axis=0)
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    band = (freqs > 55) & (freqs < 2000)
    pcs = np.round(12 * np.log2(freqs[band] / 440.0) + 9).astype(int) % 12
    chroma = np.bincount(pcs, weights=spec[band], minlength=12)
    if not chroma.any():
        return {"key": None, "key_camelot": None, "key_confidence": 0.0}
    chroma = chroma / chroma.sum()
    scores = []
    for tonic in range(12):
        for major, profile in ((True, MAJOR), (False, MINOR)):
            scores.append((float(np.corrcoef(chroma, np.roll(profile, tonic))[0, 1]), tonic, major))
    scores.sort(reverse=True)
    (best, tonic, major), second = scores[0], scores[1][0]
    confidence = float(max(0.0, min(1.0, (best - second) * 6))) if best > 0 else 0.0
    return {"key": f"{NOTE[tonic]} {'major' if major else 'minor'}", "key_camelot": CAMELOT[(tonic, major)], "key_confidence": round(confidence, 2)}


def sections(x: np.ndarray, sr: int, out: dict, db: np.ndarray, frame_ms: float) -> dict:
    """Heuristic intro/outro suitability (0–1), and whether the end fades: labelled as heuristics."""
    per_s = max(1, int(1000 / frame_ms))
    lead = int(out["audible_start_ms"] / frame_ms)
    end = int(out["audible_end_ms"] / frame_ms)
    body = db[lead:end] if end > lead else db
    if body.size < per_s * 20:
        return {"intro_suitability": 0.0, "outro_suitability": 0.0, "fade_out": False}
    median = float(np.median(body))
    intro = body[: per_s * 20]
    outro = body[-per_s * 20:]
    steady = lambda seg: 1.0 - min(1.0, float(np.std(seg)) / 12)  # noqa: E731  (steady level, e.g. a DJ-friendly intro)
    calm = lambda seg: 1.0 if float(np.mean(seg)) <= median + 1 else 0.6  # noqa: E731
    rhythm = out.get("bpm_confidence") or 0.0
    last = outro[-per_s * 10:]
    slope = float(np.polyfit(np.arange(last.size), last, 1)[0]) * per_s if last.size > 2 else 0.0
    # 5.3: where the music really ends and gets going. A 1 s loudness envelope against the song's
    # body level: mix_out is where it falls more than 6 dB below the body for good (a fade or a
    # quiet outro starts), mix_in where it first reaches that level. Overlaps that end near
    # mix_out keep Song A audible during the blend (5.2 often blended inside the fade).
    win = max(1, per_s)
    power = np.convolve(10 ** (db / 10), np.ones(win) / win, mode="same")
    smooth = 10 * np.log10(power + 1e-12)
    body_db = float(np.median(smooth[lead:end])) if end > lead else float(np.median(smooth))
    strong = np.nonzero(smooth[lead:end] >= body_db - 6)[0] if end > lead else np.array([], dtype=int)
    mix_in = int((lead + strong[0]) * frame_ms) if strong.size else out["audible_start_ms"]
    mix_out = int((lead + strong[-1] + 1) * frame_ms) if strong.size else out["audible_end_ms"]
    return {
        "body_db": round(body_db, 1),
        "mix_in_ms": max(out["audible_start_ms"], mix_in),
        "mix_out_ms": min(out["audible_end_ms"], max(mix_in, mix_out)),
        "intro_suitability": round(max(0.0, min(1.0, 0.5 * steady(intro) * calm(intro) + 0.5 * rhythm)), 2),
        "outro_suitability": round(max(0.0, min(1.0, 0.5 * steady(outro) * calm(outro) + 0.5 * rhythm)), 2),
        "fade_out": slope < -1.5,  # losing >1.5 dB a second over the last 10 s
    }


def tempo_ratio(a: float | None, b: float | None) -> float | None:
    """B's tempo relative to A's, folding half/double time (75 ≈ 150): 1.0 means identical."""
    if not a or not b:
        return None
    r = b / a
    while r > 1.5:
        r /= 2
    while r < 0.75:
        r *= 2
    return r
