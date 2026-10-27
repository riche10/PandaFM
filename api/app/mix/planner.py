"""Panda DJ's transition planner: HOW Track A becomes Track B (never WHICH song plays).

A pure function of the two tracks, their (possibly missing) analyses and the
Panda Mix personality. Plans are directional (A→B is not B→A), explicit and
inspectable, say how sure they are, and where they came from (source: smart,
fallback or manual). 5.2 never time-stretches: tempo ratios are always 1.0.

5.3: overlaps END near Song A's musical end (mix_out: where it drops below its
body level for good), not at the last audible sample, so A is still there for
most of the blend (5.2 often blended inside a fade-out, where it was hard to
hear). The personalities differ in length and in what they dare; incompatible
songs still get a deliberate Quick Switch or Clean Handoff.
"""

from app.mix.analysis import ANALYSIS_VERSION, tempo_ratio

MODES = ("auto", "gentle", "flow", "energetic")
TYPES = {
    "clean_handoff": "Clean Handoff", "smooth_blend": "Smooth Blend", "deep_blend": "Deep Blend", "bass_handoff": "Bass Handoff",
    "filter_glide": "Filter Glide", "quick_switch": "Quick Switch", "gapless": "Gapless",
}
INTENTIONAL = ("clean_handoff", "quick_switch", "gapless")  # deliberately conservative: never a failure
DANCE = ("house", "techno", "trance", "edm", "electronic", "dance", "drum and bass", "dnb", "dubstep", "electro", "garage", "breakbeat", "hardstyle", "disco")
FALLBACK_MS = {"auto": 5000, "flow": 5000, "energetic": 6000, "gentle": 3500}
FALLBACK_TAIL_MS = 3000  # the fallback blend ends this long before the file ends (out of most fades and silences)
TAIL_GRACE_MS = 4000  # a smart overlap ends at most this far into A's fade


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


def fallback(a: dict, b: dict, mode: str = "auto") -> dict:
    """No analysis yet (or it failed): a recognisable equal-power blend that ends before A's tail."""
    mode = mode if mode in MODES else "auto"
    dur = int((a.get("duration_seconds") or 0) * 1000)
    overlap = FALLBACK_MS[mode] if dur > FALLBACK_MS[mode] + FALLBACK_TAIL_MS else 0
    return {"from": a.get("id"), "to": b.get("id"), "type": "smooth_blend", "label": "Smooth Blend", "summary": f"Smooth Blend · {_fmt_s(overlap)}",
            "overlap_ms": overlap, "outgoing_start_ms": max(0, dur - overlap - FALLBACK_TAIL_MS), "incoming_start_ms": 0, "handoff_ms": overlap // 2,
            "curve": "equal_power", "filter": None, "tempo_ratio_out": 1.0, "tempo_ratio_in": 1.0, "bpm_out": None, "bpm_in": None, "key_out": None,
            "key_in": None, "confidence": 0.3, "ready": False, "source": "fallback", "intentional": False, "manual": False,
            "analysis_version": ANALYSIS_VERSION, "explanation": "Panda hasn’t analysed these songs yet, so it uses a short, safe blend."}


def classify(aa: dict, ba: dict) -> tuple[str, float, float | None]:
    """tight | near | between | far | unknown, with the rhythm confidence and the folded tempo difference."""
    conf = min(aa.get("bpm_confidence") or 0, ba.get("bpm_confidence") or 0)
    ratio = tempo_ratio(aa.get("bpm"), ba.get("bpm"))
    diff = abs(ratio - 1) if ratio else None
    if diff is None or conf < 0.4:
        return "unknown", conf, diff
    if diff <= 0.03 and conf >= 0.55:
        return "tight", conf, diff
    if diff <= 0.06:
        return "near", conf, diff
    if diff <= 0.08:
        return "between", conf, diff
    return "far", conf, diff


def plan(a: dict, b: dict, aa: dict | None, ba: dict | None, mode: str = "auto") -> dict:
    """a/b: track facts (id, duration_seconds, album_id, track_number, genres); aa/ba: analyses or None."""
    mode = mode if mode in MODES else "auto"
    if not aa or not ba:
        return fallback(a, b, mode)
    a_dur = int(aa.get("duration_ms") or 0)
    base = {"from": a.get("id"), "to": b.get("id"), "tempo_ratio_out": 1.0, "tempo_ratio_in": 1.0, "manual": False, "analysis_version": ANALYSIS_VERSION,
            "bpm_out": None, "bpm_in": None, "key_out": None, "key_in": None, "filter": None, "curve": "equal_power", "source": "smart", "ready": True}
    end = aa["audible_end_ms"]
    mix_out = min(end, aa.get("mix_out_ms", end))
    anchor = min(end, mix_out + min(end - mix_out, TAIL_GRACE_MS))  # the overlap ends here: A is still playing for most of it
    start = ba["audible_start_ms"]
    quiet_intro = max(0, ba.get("mix_in_ms", start) - start)

    def make(kind: str, overlap: int, confidence: float, why: str, beat: bool = False, **extra) -> dict:
        overlap = max(0, min(overlap, max(0, anchor - 1000)))
        out_start = anchor - overlap
        if beat:
            out_start = on_beat(out_start)
        out_start = max(0, min(out_start, max(0, a_dur - overlap)))
        in_start = in_on_beat() if beat else start
        p = {**base, **extra, "type": kind, "label": TYPES[kind], "overlap_ms": overlap, "outgoing_start_ms": out_start, "incoming_start_ms": max(0, in_start),
             "handoff_ms": overlap // 2, "confidence": round(confidence, 2), "explanation": why, "intentional": kind in INTENTIONAL}
        bpm = f" · {round(p['bpm_out'])} → {round(p['bpm_in'])} BPM" if p.get("bpm_out") and p.get("bpm_in") and kind in ("deep_blend", "bass_handoff", "smooth_blend") else ""
        p["summary"] = f"{TYPES[kind]}{'' if kind == 'gapless' else ' · ' + _fmt_s(overlap)}{bpm}"
        return p

    def bars(n: int) -> int:
        beat = aa.get("beat_interval_ms") or (60000 / aa["bpm"] if aa.get("bpm") else 500)
        return int(round(n * 4 * beat))

    def on_beat(t: int) -> int:  # line A's transition start up with its beat grid
        first, beat = aa.get("first_beat_ms"), aa.get("beat_interval_ms")
        if first is None or not beat:
            return t
        return int(first + round((t - first) / beat) * beat)

    def in_on_beat() -> int:
        first = ba.get("first_beat_ms")
        return first if first is not None and first >= start - 50 else start

    # Continuous album neighbours (live albums, joined tracks): play them as one.
    continuous = (a.get("album_id") and a.get("album_id") == b.get("album_id") and a.get("track_number") and b.get("track_number")
                  and b["track_number"] == a["track_number"] + 1)
    if continuous and aa["trailing_silence_ms"] < 250 and ba["leading_silence_ms"] < 250:
        p = make("gapless", 0, 0.9, "These album tracks run into each other, so Panda plays them without a gap.")
        p.update(outgoing_start_ms=aa["duration_ms"], incoming_start_ms=0)
        return p

    tempo, conf, diff = classify(aa, ba)
    dance = is_dance(a.get("genres")) and is_dance(b.get("genres"))
    key_ok = camelot_compatible(aa.get("key_camelot") if (aa.get("key_confidence") or 0) >= 0.3 else None,
                                ba.get("key_camelot") if (ba.get("key_confidence") or 0) >= 0.3 else None)
    fade = end - mix_out
    abrupt = fade < 1000 and (aa.get("outro_suitability") or 0) < 0.4  # a hard, sudden ending: don't smear it
    base.update(bpm_out=aa.get("bpm") if conf >= 0.4 else None, bpm_in=ba.get("bpm") if conf >= 0.4 else None,
                key_out=aa.get("key_camelot") if (aa.get("key_confidence") or 0) >= 0.3 else None,
                key_in=ba.get("key_camelot") if (ba.get("key_confidence") or 0) >= 0.3 else None)
    under_fade = "Song A fades out, so B comes in underneath the fade." if fade >= 3000 else None

    def smooth(ms: int, why: str, c: float = 0.55) -> dict:
        # a quiet intro on B fits under A's ending: give it room (within reason)
        if 2000 <= quiet_intro <= 12000:
            ms = max(ms, min(quiet_intro + 2000, ms * 2))
        return make("smooth_blend", ms, c, under_fade or why)

    def quick(ms: int = 2500) -> dict:
        return make("quick_switch", ms, 0.6, "Very different tempos; a long overlap would sound muddy, so Panda keeps it quick.")

    def clean(ms: int = 2000) -> dict:
        return make("clean_handoff", ms, 0.55, "Panda isn’t sure these songs will blend (a sudden ending, unclear rhythm), so it hands over cleanly.")

    if mode == "gentle":
        if tempo in ("tight", "near"):
            return smooth(4000, "Compatible songs: a short, gentle blend.", 0.6)
        if tempo == "far" or abrupt:
            return clean()
        return smooth(3000, "A short, gentle blend.", 0.45)

    if tempo == "tight" and dance:
        if mode == "energetic":
            overlap = min(bars(16), 32000)
            if key_ok is not False:
                return make("bass_handoff", overlap, 0.5 + 0.4 * conf, "Two dance tracks at nearly the same tempo: a long blend that swaps the bass over on the beat.",
                            beat=True, filter="bass_swap")
            return make("deep_blend", overlap, 0.45 + 0.4 * conf, "Nearly the same tempo: a long, beat-aligned blend.", beat=True)
        if mode == "auto" and key_ok is not False and conf >= 0.65:
            return make("bass_handoff", min(bars(8), 24000), 0.5 + 0.4 * conf, "Two dance tracks at nearly the same tempo: Panda swaps the bass over on the beat.",
                        beat=True, filter="bass_swap")
        return make("deep_blend", min(bars(8), 20000), 0.45 + 0.4 * conf, "Close tempos: room for a long, beat-aligned blend.", beat=True)

    if tempo in ("tight", "near"):
        if mode == "energetic" and dance:
            return make("deep_blend", min(bars(8), 24000), 0.45 + 0.35 * conf, "Compatible dance tempos: a long, beat-aligned blend.", beat=True)
        return smooth({"energetic": 12000, "flow": 10000}.get(mode, 8000), "Compatible tempos: a clear, smooth overlap.", 0.45 + 0.35 * conf)

    if tempo == "far":
        if mode == "energetic" and dance:
            return make("filter_glide", 6000, 0.5, "The tempos are far apart, so Panda keeps it short and lets a filter carry it.", filter="highpass_out")
        if mode == "auto" and abrupt:
            return clean()
        return quick(3000 if mode in ("flow", "energetic") else 2500)

    # between, or the rhythm is unclear: a moderate blend, unless A ends abruptly
    if abrupt and not under_fade:
        return quick(3000) if mode == "energetic" else clean()
    return smooth({"energetic": 7000, "flow": 6000}.get(mode, 5000), "A moderate blend: Panda isn’t sure about the rhythm, so it doesn’t beat-match.", 0.45)


def validate_override(p: dict, a_duration_ms: int, b_duration_ms: int) -> dict:
    """A user's edit, bounded to the songs (it is stored exactly for this pair/playlist)."""
    kind = p.get("type") if p.get("type") in TYPES else "smooth_blend"
    overlap = int(max(0, min(int(p.get("overlap_ms") or 0), 60000, a_duration_ms, b_duration_ms)))
    out_start = int(max(0, min(int(p.get("outgoing_start_ms") or 0), max(0, a_duration_ms - overlap))))
    in_start = int(max(0, min(int(p.get("incoming_start_ms") or 0), max(0, b_duration_ms - overlap))))
    curve = p.get("curve") if p.get("curve") in ("equal_power", "linear") else "equal_power"
    filt = p.get("filter") if p.get("filter") in (None, "bass_swap", "highpass_out", "lowpass_in") else None
    return {"type": kind, "label": TYPES[kind], "overlap_ms": 0 if kind == "gapless" else overlap, "outgoing_start_ms": out_start,
            "incoming_start_ms": in_start, "handoff_ms": overlap // 2, "curve": curve, "filter": filt, "manual": True, "source": "manual",
            "intentional": kind in INTENTIONAL}
