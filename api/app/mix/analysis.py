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

ANALYSIS_VERSION = 3  # 2 (5.3): mix-in/mix-out points; 3 (5.5): beat phase, downbeats, section profile, endings
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
    env, low, t0, low_energy = onset_envelopes(x, sr)
    out.update(rhythm(env, low, t0, sr, low_energy))
    out.update(key(x, sr))
    out.update(sections(x, sr, out, db, frame_ms))
    out.update(ending(env, t0, sr, out, db, frame_ms))
    out["profile"] = profile(x, sr)
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


# ── 5.5: rhythm (beat phase, downbeats, meter), section profile and ending ──
RHYTHM_FFT = 512
ONSET_LAG_S = 0.0  # calibrated on generated onsets (see tests/mix_corpus.py): added to every onset time


def onset_envelopes(x: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, float, np.ndarray]:
    """Full-band and low-band (kick/bass, 30-160 Hz) onset strength, and the time of index 0 in seconds.

    Each value compares two consecutive short frames; its time is the second frame's window
    centre (5.4 used the frame start of a 93 ms window: a systematic early bias).
    """
    n_fft = RHYTHM_FFT
    frames = 1 + max(0, (x.size - n_fft) // HOP)
    if frames < 16:
        z = np.zeros(16)
        return z, z, 0.0, z
    idx = np.arange(n_fft)[None, :] + HOP * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * np.hanning(n_fft).astype(np.float32), axis=1))
    logspec = np.log1p(100 * spec)
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    low = (freqs > 30) & (freqs < 160)

    def flux(ls: np.ndarray) -> np.ndarray:
        f = np.maximum(0.0, np.diff(ls, axis=0)).sum(axis=1)
        f = f - np.convolve(f, np.ones(16) / 16, mode="same")  # remove slow loudness changes
        f = np.maximum(f, 0)
        return f / (f.max() or 1.0)

    low_energy = (spec[1:, low] ** 2).sum(axis=1)  # aligned with the flux values (frame i+1)
    return flux(logspec), flux(logspec[:, low]), (HOP + n_fft / 2) / sr + ONSET_LAG_S, low_energy


def _comb_multi(env: np.ndarray, period: float) -> float:
    return float(np.mean([_comb(env, k * period) for k in (1, 2, 4)]))


def _phase_score(env: np.ndarray, phase: float, period: float) -> float:
    pos = np.arange(phase, env.size - 1, period)
    return float(np.interp(pos, np.arange(env.size), env).mean()) if pos.size else 0.0


def _track_points(combo: np.ndarray, period: float, phase: float) -> tuple[np.ndarray, np.ndarray]:
    """Adaptive beat tracking: each beat is searched around the position predicted by a running fit of the
    recent tracked beats (not by the first tempo guess), so a slightly-off starting tempo can't drift onto
    the off-beat over a long song. Returns beat numbers and sub-frame onset positions."""
    ks, ts = [], []
    top = combo.max() or 1.0
    est_period, pos, k = period, phase, 0
    while pos < combo.size - 2:
        lo, hi = int(max(1, pos - 0.15 * est_period)), int(min(combo.size - 2, pos + 0.15 * est_period))
        if hi > lo:
            i = lo + int(np.argmax(combo[lo:hi + 1]))
            if combo[i] >= 0.2 * top:
                a, b, c = combo[i - 1], combo[i], combo[i + 1]
                denom = a - 2 * b + c
                ks.append(k)
                ts.append(i + (0.5 * (a - c) / denom if denom else 0.0))  # parabolic: sub-frame peak
        k += 1
        if len(ks) >= 8:
            rk, rt = np.array(ks[-32:], float), np.array(ts[-32:], float)
            slope, icpt = np.polyfit(rk, rt, 1)
            if abs(slope / period - 1) < 0.03:
                est_period = slope
                pos = icpt + slope * k
                continue
        pos += est_period
    return np.array(ks, float), np.array(ts, float)


def _fit(ks: np.ndarray, ts: np.ndarray, period: float, minimum: int = 12) -> tuple[float, float] | None:
    """A robust straight line through onset position vs beat number (outliers dropped): (period, position of beat 0).
    Tempo and phase come out together, far more precisely than a single-lag search."""
    if ks.size < minimum:
        return None
    for _ in range(3):
        slope, icpt = np.polyfit(ks, ts, 1)
        keep = np.abs(ts - (icpt + slope * ks)) < 0.06 * period
        if keep.sum() < minimum:
            break
        ks, ts = ks[keep], ts[keep]
    slope, icpt = np.polyfit(ks, ts, 1)
    return float(slope), float(icpt)


def rhythm(env: np.ndarray, low: np.ndarray, t0: float, sr: int, low_energy: np.ndarray | None = None) -> dict:
    """Tempo, beat phase, how clearly onsets sit on the grid, downbeats and meter, and local beat grids
    for the first and last ~45 s (where Panda mixes). Weak evidence is reported as unknown, never guessed."""
    frame_rate = sr / HOP
    out = {"bpm": None, "bpm_confidence": 0.0, "first_beat_ms": None, "beat_interval_ms": None, "beat_grid_confidence": 0.0,
           "first_downbeat_ms": None, "downbeat_confidence": 0.0, "meter": None, "downbeat_index": None,
           "intro_grid": None, "outro_grid": None}
    if env.size < frame_rate * 8 or not env.any():
        return out
    grid = np.arange(60.0, 200.0, 0.25)
    scores = np.array([_comb(env, frame_rate * 60 / b) for b in grid])
    prior = np.exp(-0.5 * (np.log2(grid / 120.0) / 0.9) ** 2)  # mild preference for common tempos, never decisive
    best = int(np.argmax(scores * (0.85 + 0.15 * prior)))
    coarse = float(grid[best])
    baseline = float(np.median(scores)) or 1e-9
    contrast = (scores[best] - baseline) / (float(np.max(scores)) - baseline + 1e-9)
    sharpness = (scores[best] - baseline) / (baseline + 1e-9)
    confidence = float(max(0.0, min(1.0, 0.5 * contrast + 0.5 * min(1.0, sharpness / 3))))
    out["bpm"], out["bpm_confidence"] = round(coarse, 2), round(confidence, 2)
    if confidence < 0.45:
        return out
    combo = env + 2 * low  # the kick and the bass carry the beat; hats on the off-beat must not win the phase
    fine = np.arange(coarse - 1.0, coarse + 1.0, 0.02)
    period = frame_rate * 60 / float(fine[int(np.argmax([_comb_multi(combo, frame_rate * 60 / b) for b in fine]))])
    phases = np.arange(0, period, 0.25)
    phase = float(phases[int(np.argmax([_phase_score(combo, p, period) for p in phases]))])
    ks, ts = _track_points(combo, period, phase)
    local_in = local_out = None
    tracked = _fit(ks, ts, period, 16)
    if tracked and abs(tracked[0] / period - 1) < 0.02:  # refine, never re-decide the tempo
        period, phase = tracked
        # Local phase where Panda actually mixes (the first and last ~45 s): the global tempo, but each
        # region's own phase (the median offset of its tracked onsets), so a tiny tempo error across a
        # whole song can't shift the beat where the transition happens.
        span = 45 * frame_rate
        resid = ts - ks * period
        sel_in, sel_out = ts <= ts.min() + span, ts >= ts.max() - span
        ok = np.abs(resid - phase) < 0.1 * period
        local_in = float(np.median(resid[sel_in & ok])) if (sel_in & ok).sum() >= 8 else None
        local_out = float(np.median(resid[sel_out & ok])) if (sel_out & ok).sum() >= 8 else None
    # Off-beat check: kicks land on the beat; if the low end is clearly stronger half a beat later, the
    # tracker locked onto the off-beat (hats): move the whole grid by half a beat.
    kick = low_energy if low_energy is not None and low_energy.size == low.size else low

    def kick_at(ph: float) -> float:
        pos = np.arange(ph % period, kick.size - 3, period)
        return float(np.mean([kick[max(0, int(b) - 2):int(b) + 3].max() for b in pos])) if pos.size else 0.0

    if kick_at(phase + period / 2) > 1.25 * kick_at(phase):
        phase += period / 2
        local_in = None if local_in is None else local_in + period / 2
        local_out = None if local_out is None else local_out + period / 2
    on = _phase_score(combo, phase % period, period)
    off = _phase_score(combo, (phase + period / 2) % period, period)
    beat_s = period / frame_rate
    first_beat_s = phase / frame_rate + t0
    shift = int(np.floor(first_beat_s / beat_s))  # beat 0 → the first beat at or after 0 s
    first_beat_s -= shift * beat_s
    out.update(bpm=round(60.0 / beat_s, 2), first_beat_ms=int(round(first_beat_s * 1000)), beat_interval_ms=round(beat_s * 1000, 3),
               beat_grid_confidence=round(float(max(0.0, min(1.0, (on - off) / (on + 1e-9)))), 2))

    # downbeats: which beat of the bar carries the strongest low-end accent, measured as energy
    source = low_energy if low_energy is not None and low_energy.size == low.size else low
    # counted from the global first beat (beat 0), so the bar index means the same beat everywhere
    beats = np.arange((first_beat_s - t0) * frame_rate, source.size - 3, period)
    beats = beats[beats >= 0] if beats.size and beats[0] < 0 else beats
    lead_skipped = int(np.sum(np.arange((first_beat_s - t0) * frame_rate, source.size - 3, period) < 0))
    if beats.size >= 16:
        strength = np.sqrt(np.array([source[max(0, int(b) - 2):int(b) + 3].max() for b in beats]))
        best_meter, best_d, best_contrast = None, 0, 0.0
        for meter in (4, 3):
            means = np.array([strength[d::meter].mean() for d in range(meter)])
            d = int(np.argmax(means))
            c = float((means[d] - np.delete(means, d).mean()) / (means[d] + 1e-9))
            if meter == 4:
                c *= 1.15  # 4/4 is far more common: it wins ties, never a clear 3/4
            if c > best_contrast:
                best_meter, best_d, best_contrast = meter, d, c
        db_conf = float(max(0.0, min(1.0, best_contrast * 2.0)))
        out["downbeat_confidence"] = round(db_conf, 2)
        if db_conf >= 0.3:
            # beats[] start at the first beat of the song (global beat 0 after the shift above)
            best_d = (best_d + lead_skipped) % best_meter  # back to numbering from beat 0
            first_down = first_beat_s + best_d * beat_s
            out.update(first_downbeat_ms=int(round(first_down * 1000)), meter=best_meter, downbeat_index=best_d)
    # local grids, numbered like the global grid: [time of global beat 0 per the region's phase, beat ms]
    for key_, local_phase in (("intro_grid", local_in), ("outro_grid", local_out)):
        if local_phase is not None:
            beat0 = (local_phase + shift * period) / frame_rate + t0  # beat 0 is tracked beat number `shift`
            out[key_] = [round(beat0 * 1000, 1), round(beat_s * 1000, 3)]
    return out


PROFILE_STEP_S = 2.0


def profile(x: np.ndarray, sr: int) -> dict:
    """A compact 2 s section profile: loudness (dB vs the song's median), bass share, and a vocal-likelihood
    heuristic (energy in the voice band that is harmonic AND syllable-modulated at 3-8 Hz). It is a
    signal heuristic, not vocal detection: it can be fooled, and the planner treats it as one hint."""
    n_fft, hop = 2048, 512
    frames = 1 + max(0, (x.size - n_fft) // hop)
    per = max(1, int(round(PROFILE_STEP_S * sr / hop)))
    if frames < per:
        return {"step_ms": int(PROFILE_STEP_S * 1000), "loud_db": [], "bass": [], "vocal": []}
    idx = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
    power = np.abs(np.fft.rfft(x[idx] * np.hanning(n_fft).astype(np.float32), axis=1)) ** 2 + 1e-12
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    bass_b = (freqs >= 30) & (freqs < 160)
    voc_b = (freqs >= 250) & (freqs < 3500)
    total = power.sum(axis=1)
    e_bass = power[:, bass_b].sum(axis=1)
    e_voc = power[:, voc_b].sum(axis=1)
    pv = power[:, voc_b]
    flat = np.exp(np.log(pv).mean(axis=1)) / pv.mean(axis=1)  # 1 = noise-like, near 0 = harmonic
    frame_rate = sr / hop
    loud, bass, vocal = [], [], []
    for w in range(frames // per):
        sl = slice(w * per, (w + 1) * per)
        e = total[sl].mean()
        loud.append(10 * np.log10(e))
        bass.append(float(np.clip(np.percentile(e_bass[sl], 30) / e * 2, 0, 1)))  # sustained low end, not kicks
        ev = e_voc[sl]
        share = float(ev.mean() / (e - e_bass[sl].mean() + 1e-12))
        env = ev / (ev.mean() + 1e-12) - 1
        spec = np.abs(np.fft.rfft(env * np.hanning(env.size))) ** 2
        f = np.fft.rfftfreq(env.size, 1 / frame_rate)
        mod = float(spec[(f >= 3) & (f <= 8)].sum() / (spec[f > 0.4].sum() + 1e-12))
        harm = float(1 - np.clip(flat[sl].mean() * 3, 0, 1))
        vocal.append(float(np.clip(min(1.0, share * 1.5) * min(1.0, mod * 3.0) * harm, 0, 1)))
    med = float(np.median(loud)) if loud else 0.0
    return {"step_ms": int(PROFILE_STEP_S * 1000), "loud_db": [int(round(max(-40.0, min(12.0, v - med)))) for v in loud],
            "bass": [round(v, 2) for v in bass], "vocal": [round(v, 2) for v in vocal]}


def ending(env: np.ndarray, t0: float, sr: int, out: dict, db: np.ndarray | None = None, frame_ms: float = 46.4) -> dict:
    """How the music ends: 'sustain' (a held last note/chord after the final hit), 'fade' (the level slides
    down while the music keeps playing) or 'hard'. musical_end_ms is the end Panda must not cut."""
    frame_rate = sr / HOP
    end_s = out["audible_end_ms"] / 1000
    lo = max(0, int((end_s - 15 - t0) * frame_rate))
    hi = max(lo, int((end_s - t0) * frame_rate))
    strong = np.nonzero(env[lo:hi] >= 0.35)[0]
    last_hit = (lo + strong[-1]) / frame_rate + t0 if strong.size else end_s
    tail = end_s - last_hit
    # Is the music still playing in the last 4 s? In a fade the level slides down with a bump at every
    # beat; after a held final note it just decays. Judged on the short-term level against its own trend,
    # so a quiet fade still counts as playing.
    rhythmic = False
    if db is not None and db.size:
        e = int(out["audible_end_ms"] / frame_ms)
        seg = db[max(0, e - int(4000 / frame_ms)):e]
        if seg.size > 12:
            width = max(3, int(500 / frame_ms))
            trend = np.convolve(seg, np.ones(width) / width, mode="same")
            bump = seg - trend
            peaks = np.nonzero((bump[1:-1] > 3) & (bump[1:-1] >= bump[:-2]) & (bump[1:-1] >= bump[2:]))[0]
            rhythmic = peaks.size >= 4 and (peaks[-1] - peaks[0]) * frame_ms / 1000 >= 2.0
    if not rhythmic and tail >= 1.5:
        kind = "sustain"
    elif out.get("fade_out"):
        kind = "fade"
    else:
        kind = "hard"
    musical_end = out["audible_end_ms"] if kind != "fade" else out.get("mix_out_ms", out["audible_end_ms"])
    return {"ending": kind, "last_hit_ms": int(round(last_hit * 1000)), "musical_end_ms": int(musical_end)}


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
