"""Panda DJ's transition planner: HOW Track A becomes Track B (never WHICH song plays).

A pure function of the two tracks, their (possibly missing) analyses and the
Panda Mix personality. Plans are directional (A→B is not B→A), explicit and
inspectable, and say how sure they are. Low confidence means conservative.
5.2 never time-stretches: tempo ratios are always 1.0.
"""

from app.mix.analysis import ANALYSIS_VERSION, tempo_ratio

MODES = ("auto", "gentle", "flow", "energetic")
TYPES = {
    "clean_handoff": "Clean Handoff", "smooth_blend": "Smooth Blend", "deep_blend": "Deep Blend", "bass_handoff": "Bass Handoff",
    "filter_glide": "Filter Glide", "quick_switch": "Quick Switch", "gapless": "Gapless",
}
DANCE = ("house", "techno", "trance", "edm", "electronic", "dance", "drum and bass", "dnb", "dubstep", "electro", "garage", "breakbeat", "hardstyle", "disco")
FALLBACK_MS = 4000


def is_dance(genres) -> bool:
    return any(any(d in (g or "").lower() for d in DANCE) for g in genres or [])


def camelot_compatible(a: str | None, b: str | None) -> bool | None:
    if not a or not b:
        return None
    na, la, nb, lb = int(a[:-1]), a[-1], int(b[:-1]), b[-1]
    if a == b:
        return True
    if la == lb and (abs(na - nb) in (1, 11)):
        return True
    return na == nb  # relative major/minor


def _fmt_s(ms: int) -> str:
    return f"{round(ms / 1000)} sec" if ms >= 1000 else "instant"


def plan(a: dict, b: dict, aa: dict | None, ba: dict | None, mode: str = "auto") -> dict:
    """a/b: track facts (id, duration_seconds, album_id, track_number, genres); aa/ba: analyses or None."""
    mode = mode if mode in MODES else "auto"
    a_dur = int((aa or {}).get("duration_ms") or (a.get("duration_seconds") or 0) * 1000)
    base = {"from": a.get("id"), "to": b.get("id"), "tempo_ratio_out": 1.0, "tempo_ratio_in": 1.0, "manual": False, "analysis_version": ANALYSIS_VERSION,
            "bpm_out": None, "bpm_in": None, "key_out": None, "key_in": None, "filter": None, "curve": "equal_power"}

    def make(kind: str, overlap: int, out_start: int, in_start: int, confidence: float, why: str, **extra) -> dict:
        overlap = max(0, overlap)
        out_start = max(0, min(out_start, max(0, a_dur - overlap)))
        p = {**base, **extra, "type": kind, "label": TYPES[kind], "overlap_ms": overlap, "outgoing_start_ms": out_start,
             "incoming_start_ms": max(0, in_start), "handoff_ms": overlap // 2, "confidence": round(confidence, 2), "explanation": why}
        bpm = f" · {round(p['bpm_out'])} → {round(p['bpm_in'])} BPM" if p.get("bpm_out") and p.get("bpm_in") and kind in ("deep_blend", "bass_handoff", "smooth_blend") else ""
        p["summary"] = f"{TYPES[kind]}{'' if kind == 'gapless' else ' · ' + _fmt_s(overlap)}{bpm}"
        return p

    # Continuous album neighbours (live albums, joined tracks): play them as one.
    continuous = (a.get("album_id") and a.get("album_id") == b.get("album_id") and a.get("track_number") and b.get("track_number")
                  and b["track_number"] == a["track_number"] + 1)
    if continuous and aa and ba and aa["trailing_silence_ms"] < 250 and ba["leading_silence_ms"] < 250:
        return make("gapless", 0, aa["duration_ms"], 0, 0.9, "These album tracks run into each other, so Panda plays them without a gap.")

    if not aa or not ba:  # analysis not ready (or failed): a safe, fixed equal-power crossfade
        overlap = 2500 if mode == "gentle" else FALLBACK_MS
        p = make("smooth_blend", overlap, a_dur - overlap, 0, 0.3, "Panda hasn’t analysed these songs yet, so it uses a short, safe blend.")
        p["ready"] = False
        return p

    end = aa["audible_end_ms"]  # skip trailing silence, never wait through it
    start = ba["audible_start_ms"]
    bpm_a, bpm_b = aa.get("bpm"), ba.get("bpm")
    conf = min(aa.get("bpm_confidence") or 0, ba.get("bpm_confidence") or 0)
    ratio = tempo_ratio(bpm_a, bpm_b)
    diff = abs(ratio - 1) if ratio else None
    key_ok = camelot_compatible(aa.get("key_camelot") if (aa.get("key_confidence") or 0) >= 0.3 else None,
                                ba.get("key_camelot") if (ba.get("key_confidence") or 0) >= 0.3 else None)
    dance = is_dance(a.get("genres")) and is_dance(b.get("genres"))
    outro, intro = aa.get("outro_suitability") or 0, ba.get("intro_suitability") or 0
    base.update(bpm_out=bpm_a if conf >= 0.45 else None, bpm_in=bpm_b if conf >= 0.45 else None,
                key_out=aa.get("key_camelot") if (aa.get("key_confidence") or 0) >= 0.3 else None,
                key_in=ba.get("key_camelot") if (ba.get("key_confidence") or 0) >= 0.3 else None)

    def bars(n: int) -> int:
        beat = aa.get("beat_interval_ms") or (60000 / bpm_a if bpm_a else 500)
        return int(round(n * 4 * beat))

    def on_beat(t: int) -> int:  # line A's transition start up with its beat grid
        first, beat = aa.get("first_beat_ms"), aa.get("beat_interval_ms")
        if first is None or not beat:
            return t
        return int(first + round((t - first) / beat) * beat)

    def in_on_beat() -> int:
        first = ba.get("first_beat_ms")
        return first if first is not None and first >= start - 50 else start

    tempo_close = diff is not None and conf >= 0.6 and diff <= 0.03
    tempo_near = diff is not None and conf >= 0.45 and diff <= 0.06
    clear_sections = outro >= 0.5 and intro >= 0.5

    if mode != "gentle" and dance and tempo_close and clear_sections and (mode in ("energetic", "auto") or key_ok is not False):
        long = bars(16 if mode == "energetic" else 8)
        if mode in ("energetic", "auto") and key_ok is not False and conf >= 0.7:
            overlap = min(long, 32000)
            return make("bass_handoff", overlap, on_beat(end - overlap), in_on_beat(), 0.5 + 0.4 * conf,
                        "Both are dance tracks at nearly the same tempo with clean intro and outro sections; Panda swaps the bass over on the beat.",
                        filter="bass_swap")
        overlap = min(long, 24000)
        return make("deep_blend", overlap, on_beat(end - overlap), in_on_beat(), 0.45 + 0.4 * conf,
                    "Close tempos and long, steady intro and outro sections: room for a long, beat-aligned blend.")
    if tempo_near and mode != "gentle" and (clear_sections or dance):
        overlap = min(bars(4) if dance else 10000, 14000)
        return make("smooth_blend", overlap, on_beat(end - overlap) if dance else end - overlap, in_on_beat() if dance else start, 0.4 + 0.4 * conf,
                    "Compatible tempos and calm enough sections for a smooth overlap.")
    if mode == "energetic" and dance and diff is not None and diff > 0.06:
        overlap = 4000
        return make("filter_glide", overlap, end - overlap, start, 0.45,
                    "The tempos are far apart, so Panda keeps the overlap short and lets a filter carry it.", filter="highpass_out")
    if diff is not None and conf >= 0.45 and diff > 0.08:
        return make("quick_switch", 2000, end - 2000, start, 0.55, "Large tempo difference; a long overlap would sound muddy.")
    if aa.get("fade_out"):
        overlap = 3000 if mode == "gentle" else 6000
        return make("smooth_blend", overlap, end - overlap, start, 0.5, "Song A fades out, so B can come in underneath the fade.")
    if mode == "gentle" or conf < 0.45 or not clear_sections:
        return make("clean_handoff", 1500, end - 1500, start, 0.5,
                    "Panda isn’t sure about the rhythm or the song sections here, so it hands over cleanly instead of forcing a mix.")
    return make("smooth_blend", 6000, end - 6000, start, 0.45, "A moderate blend: the songs neither clash nor share a groove.")


def validate_override(p: dict, a_duration_ms: int, b_duration_ms: int) -> dict:
    """A user's edit, bounded to the songs (it is stored exactly for this pair/playlist)."""
    kind = p.get("type") if p.get("type") in TYPES else "smooth_blend"
    overlap = int(max(0, min(int(p.get("overlap_ms") or 0), 60000, a_duration_ms, b_duration_ms)))
    out_start = int(max(0, min(int(p.get("outgoing_start_ms") or 0), max(0, a_duration_ms - overlap))))
    in_start = int(max(0, min(int(p.get("incoming_start_ms") or 0), max(0, b_duration_ms - overlap))))
    curve = p.get("curve") if p.get("curve") in ("equal_power", "linear") else "equal_power"
    filt = p.get("filter") if p.get("filter") in (None, "bass_swap", "highpass_out", "lowpass_in") else None
    return {"type": kind, "label": TYPES[kind], "overlap_ms": 0 if kind == "gapless" else overlap, "outgoing_start_ms": out_start,
            "incoming_start_ms": in_start, "handoff_ms": overlap // 2, "curve": curve, "filter": filt, "manual": True}
