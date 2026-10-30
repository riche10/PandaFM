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


def p_key(x: dict) -> bool:
    return bool(x.get("key_camelot")) and (x.get("key_confidence") or 0) >= 0.3


# ── 5.5 planner: evidence → ambition → a placed, aligned, compensated transition ──
DRIFT_BUDGET_MS = {"gentle": 20.0, "flow": 30.0, "auto": 30.0, "energetic": 45.0}  # no time-stretching: how far beats may slip over a blend
TIERS = ("clean", "short", "moderate", "deep")
CAP = {"gentle": "short", "flow": "moderate", "energetic": "deep", "auto": "moderate"}
MAX_INTRO_SKIP_MS = 8000  # never skip more of B's start than this (and never past its first vocal)


def _window(profile: dict | None, key: str, start_ms: float, length_ms: float) -> float | None:
    """The mean of a section-profile value over [start, start+length]."""
    if not profile or not profile.get(key):
        return None
    step = profile.get("step_ms") or 2000
    vals = profile[key]
    a = max(0, int(start_ms // step))
    b = max(a + 1, int((start_ms + max(length_ms, step)) // step))
    seg = vals[a:min(b, len(vals))]
    return float(sum(seg) / len(seg)) if seg else None


def _grid(an: dict, which: str) -> tuple[float, float] | None:
    """(time of beat 0 ms, beat ms) of the intro/outro grid, else the global grid; None when untrusted."""
    if (an.get("beat_grid_confidence") or 0) < 0.25 or not an.get("beat_interval_ms"):
        return None
    g = an.get(which)
    if g:
        return float(g[0]), float(g[1])
    return float(an["first_beat_ms"]), float(an["beat_interval_ms"])


def _bars_ok(an: dict) -> bool:
    return (an.get("downbeat_confidence") or 0) >= 0.4 and an.get("meter") in (3, 4) and an.get("downbeat_index") is not None


def evidence(a: dict, b: dict, aa: dict, ba: dict, mode: str = "auto") -> dict:
    """Everything the decision rests on, each with how sure Panda is (also shown in diagnostics)."""
    conf = min(aa.get("bpm_confidence") or 0, ba.get("bpm_confidence") or 0)
    ratio = tempo_ratio(aa.get("bpm"), ba.get("bpm"))
    diff = abs(ratio - 1) if ratio else None
    beat_a = aa.get("beat_interval_ms")
    drift_beats = None
    if ratio and beat_a and conf >= 0.4:
        per_beat = abs(beat_a - beat_a / ratio)  # how far B's beat slips from A's on every beat
        drift_beats = 10_000 if per_beat < 1e-3 else int(DRIFT_BUDGET_MS.get(mode, 30.0) // per_beat)
    grid = min(aa.get("beat_grid_confidence") or 0, ba.get("beat_grid_confidence") or 0)
    bars = _bars_ok(aa) and _bars_ok(ba) and aa.get("meter") == ba.get("meter")
    key_ok = camelot_compatible(aa.get("key_camelot") if p_key(aa) else None, ba.get("key_camelot") if p_key(ba) else None)
    la, lb = aa.get("integrated_lufs"), ba.get("integrated_lufs")
    return {
        "tempo_confidence": round(conf, 2), "tempo_diff_pct": None if diff is None else round(diff * 100, 2),
        "folded": bool(ratio and aa.get("bpm") and ba.get("bpm") and abs(aa["bpm"] / ba["bpm"] - 1) > 0.3),
        "drift_budget_beats": drift_beats, "grid_confidence": round(grid, 2), "bars": bars,
        "downbeat_confidence": round(min(aa.get("downbeat_confidence") or 0, ba.get("downbeat_confidence") or 0), 2),
        "key_fit": "compatible" if key_ok else "clash" if key_ok is False else "unknown",
        "key_confidence": round(min(aa.get("key_confidence") or 0, ba.get("key_confidence") or 0), 2),
        "loudness_diff_lu": None if la is None or lb is None else round(lb - la, 1),
        "ending": aa.get("ending"), "dance": is_dance(a.get("genres")) and is_dance(b.get("genres")),
    }


def ambition(ev: dict, mode: str) -> tuple[str, list[str]]:
    """How much a transition may attempt, from the evidence; the personality only caps it."""
    why = []
    diff, conf, grid = ev["tempo_diff_pct"], ev["tempo_confidence"], ev["grid_confidence"]
    drift = ev["drift_budget_beats"] or 0
    loud = abs(ev["loudness_diff_lu"] or 0)
    if diff is None or conf < 0.4:
        tier = "short" if ev["ending"] == "fade" else "clean"
        why.append("Tempo uncertain: no beat-matched overlap")
    elif diff <= 2 and conf >= 0.6 and grid >= 0.3 and ev["bars"] and drift >= 16 and ev["key_fit"] != "clash" and loud <= 6:
        tier = "deep"
        why.append("Close tempos, a clear beat grid and bars: room for a long, bar-aligned blend")
    elif diff <= 4 and conf >= 0.5 and grid >= 0.25 and drift >= 8:
        tier = "moderate"
        why.append("Compatible tempos and a usable beat grid: a moderate, beat-aligned blend")
    elif diff <= 8:
        tier = "short"
        why.append("Tempos are related but not close: a short blend")
    else:
        tier = "clean"
        why.append("Very different tempos: a long overlap would sound muddy")
    if ev["key_fit"] == "clash" and ev["key_confidence"] >= 0.5 and TIERS.index(tier) > TIERS.index("short"):
        tier = "short"
        why.append("The keys clash: a short overlap")
    if loud > 6 and TIERS.index(tier) > TIERS.index("moderate"):
        tier = "moderate"
        why.append("Very different loudness: kept moderate (and levelled)")
    cap = CAP[mode] if not (mode == "auto" and ev["dance"]) else "deep"
    if TIERS.index(tier) > TIERS.index(cap):
        tier = cap
        why.append(f"{mode.capitalize()} keeps it to a {cap} transition")
    return tier, why


def plan(a: dict, b: dict, aa: dict | None, ba: dict | None, mode: str = "auto") -> dict:
    """a/b: track facts (id, duration_seconds, album_id, track_number, genres); aa/ba: analyses or None."""
    mode = mode if mode in MODES else "auto"
    if not aa or not ba:
        return fallback(a, b, mode)
    a_dur = int(aa.get("duration_ms") or 0)
    end = int(aa["audible_end_ms"])
    start = int(ba["audible_start_ms"])
    ev = evidence(a, b, aa, ba, mode)
    base = {"from": a.get("id"), "to": b.get("id"), "tempo_ratio_out": 1.0, "tempo_ratio_in": 1.0, "manual": False,
            "analysis_version": ANALYSIS_VERSION, "source": "smart", "ready": True, "filter": None, "curve": "equal_power",
            "bpm_out": aa.get("bpm") if ev["tempo_confidence"] >= 0.4 else None, "bpm_in": ba.get("bpm") if ev["tempo_confidence"] >= 0.4 else None,
            "key_out": aa.get("key_camelot") if p_key(aa) else None, "key_in": ba.get("key_camelot") if p_key(ba) else None,
            "key_name_out": aa.get("key") if p_key(aa) else None, "key_name_in": ba.get("key") if p_key(ba) else None,
            "gain_out_db": 0.0, "gain_in_db": 0.0, "facts": ev, "degradations": []}

    def finish(kind: str, overlap: int, out_start: int, in_start: int, confidence: float, why: str, reasons: list[str], **extra) -> dict:
        overlap = max(0, overlap)
        out_start = max(0, min(out_start, max(0, a_dur - overlap)))
        p = {**base, **extra, "type": kind, "label": TYPES[kind], "overlap_ms": overlap, "outgoing_start_ms": out_start,
             "incoming_start_ms": max(0, in_start), "handoff_ms": overlap // 2, "confidence": round(confidence, 2), "explanation": why,
             "intentional": kind in INTENTIONAL, "reasons": reasons}
        bpm = f" · {round(p['bpm_out'])} → {round(p['bpm_in'])} BPM" if p.get("bpm_out") and p.get("bpm_in") and kind in ("deep_blend", "bass_handoff", "smooth_blend") else ""
        p["summary"] = f"{TYPES[kind]}{'' if kind == 'gapless' else ' · ' + _fmt_s(overlap)}{bpm}"
        return p

    reasons = _facts_lines(aa, ba, ev)

    # Continuous album neighbours (live albums, joined tracks): play them as one.
    continuous = (a.get("album_id") and a.get("album_id") == b.get("album_id") and a.get("track_number") and b.get("track_number")
                  and b["track_number"] == a["track_number"] + 1)
    if continuous and aa["trailing_silence_ms"] < 250 and ba["leading_silence_ms"] < 250:
        p = finish("gapless", 0, aa["duration_ms"], 0, 0.9, "These album tracks run into each other, so Panda plays them without a gap.",
                   ["The next track on the same album"], tier="clean")
        p.update(outgoing_start_ms=aa["duration_ms"], incoming_start_ms=0)
        return p

    tier, why_tier = ambition(ev, mode)
    reasons += why_tier

    # Loudness: level the louder side during the overlap (attenuation only: no clipping, files untouched)
    d = ev["loudness_diff_lu"]
    gains = {}
    if d is not None and abs(d) > 1.5:
        gains = {"gain_in_db": -round(min(8.0, d), 1)} if d > 0 else {"gain_out_db": -round(min(8.0, -d), 1)}
        reasons.append(f"Levelling {abs(d):.0f} LU during the blend")

    # Endings: a held final note is a place to come in under; a hard final hit is not to be cut.
    if aa.get("ending") == "sustain" and aa.get("last_hit_ms") and end - aa["last_hit_ms"] >= 1500 and tier != "clean":
        tail = min(6000, end - int(aa["last_hit_ms"]))
        return finish("smooth_blend", tail, int(aa["last_hit_ms"]), start, 0.6, "Song B comes in under Song A's held final note.",
                      reasons + ["Song A ends on a held note: it rings out under Song B"], curve="under_tail", tier=tier, **gains)
    if aa.get("ending") == "hard" and TIERS.index(tier) > TIERS.index("short") and not ev["dance"]:
        tier = "short"
        reasons.append("Song A ends on a hard final hit: kept short so it isn't buried")

    # Where the overlap should end: near A's musical end (5.3), never inside trailing silence
    mix_out = min(end, int(aa.get("mix_out_ms", end)))
    anchor = min(end, mix_out + min(end - mix_out, TAIL_GRACE_MS))
    ga, gb = _grid(aa, "outro_grid"), _grid(ba, "intro_grid")
    beat_ms = ga[1] if ga else None
    drift = ev["drift_budget_beats"] or 0
    a_voc = _window(aa.get("profile"), "vocal", anchor - 8000, 8000)
    a_bass = _window(aa.get("profile"), "bass", anchor - 8000, 8000)

    # B's entry: its first downbeat (or beat) after the audible start, bounded, never past its first vocal
    in_start = start
    lead = 0.0  # from B's start to its first downbeat: A's bar boundary must coincide with that downbeat
    if gb and tier != "clean":
        b0, bb = gb
        step = bb * (ba["meter"] if ev["bars"] else 1)
        offset = (ba["downbeat_index"] or 0) * bb if ev["bars"] else 0
        k = max(0, int((start - b0 - offset) // step))
        cand = b0 + offset + k * step
        while cand < start - 5:
            cand += step
        first_vocal = _first_above(ba.get("profile"), "vocal", 0.5)
        if cand - start <= MAX_INTRO_SKIP_MS and (first_vocal is None or cand <= first_vocal):
            in_start = int(round(cand))
        else:
            lead = max(0.0, cand - start)  # start at the audible start; its downbeat comes `lead` later
    b_voc = _window(ba.get("profile"), "vocal", in_start, 8000)
    b_bass = _window(ba.get("profile"), "bass", in_start, 8000)

    # How long: beats for beat-matched tiers (capped by the drift budget), seconds otherwise
    beats = {"deep": 64 if mode == "energetic" else 32, "moderate": 16, "short": 8, "clean": 0}[tier]
    curve, kind, filt = "equal_power", {"deep": "deep_blend", "moderate": "smooth_blend", "short": "smooth_blend", "clean": "clean_handoff"}[tier], None
    vocal_clash = (a_voc or 0) >= 0.5 and (b_voc or 0) >= 0.5
    bass_clash = (a_bass or 0) >= 0.6 and (b_bass or 0) >= 0.6
    if vocal_clash and (a_bass or 0) >= 0.6 and (b_bass or 0) >= 0.6 and tier in ("moderate", "deep"):
        tier, kind, beats = "short", "smooth_blend", 8
        reasons.append("Both sides are dense (vocals and bass): a short blend")
    elif vocal_clash:
        beats = min(beats, 8)
        reasons.append("Vocals on both sides: the overlap stays short")
    if bass_clash and tier in ("moderate", "deep"):
        curve = "sharp"  # hand the low end over quickly around the midpoint
        if ev["dance"] and mode in ("energetic", "auto") and tier == "deep":
            kind, filt = "bass_handoff", "bass_swap"
        reasons.append("Bass on both sides: the low end changes hands quickly")
    if beat_ms and tier in ("deep", "moderate", "short") and ev["tempo_confidence"] >= 0.4:
        if drift and beats > drift:
            reasons.append(f"Tempos drift apart: limited to {drift} beats")
            beats = max(4, drift - drift % 4)
        overlap = int(round(beats * beat_ms))
    else:
        overlap = {"short": 3000 if mode == "gentle" else 4000, "clean": 1500}.get(tier, 6000)
    if mode == "gentle":
        overlap = min(overlap, 4000)
    if tier == "clean":
        kind = "quick_switch" if ev["tempo_diff_pct"] is not None and ev["tempo_diff_pct"] > 8 and ev["tempo_confidence"] >= 0.4 else "clean_handoff"
        overlap = 2500 if kind == "quick_switch" else 1500
    overlap = min(overlap, max(0, anchor - 1000))

    # Vocals over the whole overlap, not just its first seconds: shrink in whole bars while both sides sing
    bar_ms = (beat_ms or 0) * (aa.get("meter") or 4)
    for _ in range(4):
        shared = _both_vocal_ms(aa.get("profile"), anchor - overlap, ba.get("profile"), in_start, overlap)
        if shared <= 4000 or overlap <= 4000:
            break
        overlap = max(4000, int(round((overlap / 2) / bar_ms) * bar_ms) if bar_ms else overlap // 2)
        if "Vocals on both sides: the overlap stays short" not in reasons:
            reasons.append("Vocals on both sides: the overlap stays short")

    # Place it: at most half of the overlap reaches past A's musical end (so a short blend isn't buried
    # in a fade: A stays at body level for at least half of it), then start on A's bar (or beat) so
    # B's downbeat lands on it
    place_end = min(end, mix_out + min(end - mix_out, TAIL_GRACE_MS, overlap // 2))
    out_start = place_end - overlap
    aligned = "time"
    if ga and tier in ("deep", "moderate", "short") and overlap > 0:
        a0, ab = ga
        step = ab * (aa["meter"] if ev["bars"] else 1)
        offset = (aa["downbeat_index"] or 0) * ab if ev["bars"] else 0
        snapped = a0 + offset + int((out_start + lead - a0 - offset) // step) * step - lead
        if snapped >= 0:
            out_start = int(round(snapped))
            aligned = "bar" if ev["bars"] else "beat"
    reasons.append({"bar": "Starts on a bar: Song B's downbeat lands on it", "beat": "Starts on a beat",
                    "time": "Not beat-matched"}[aligned])
    confidence = {"deep": 0.85, "moderate": 0.7, "short": 0.55, "clean": 0.55}[tier]
    why = {"deep": "Close tempos, clear bars and compatible sections: a long, bar-aligned blend.",
           "moderate": "Compatible tempos and a clear beat: a moderate, beat-aligned blend.",
           "short": "A short blend: Panda isn't sure enough for a longer one.",
           "clean": "These songs don't blend well, so Panda hands over cleanly."}[tier]
    return finish(kind, overlap, out_start, in_start, confidence, why, reasons, curve=curve, filter=filt, tier=tier,
                  aligned=aligned, **gains)


def _both_vocal_ms(pa: dict | None, a_start: float, pb: dict | None, b_start: float, length: float) -> int:
    """How long both songs look vocal-heavy at the same time during an overlap (profile heuristic)."""
    if not pa or not pb or not pa.get("vocal") or not pb.get("vocal"):
        return 0
    step = pa.get("step_ms") or 2000
    shared, t = 0, 0.0
    while t < length:
        va = pa["vocal"][min(len(pa["vocal"]) - 1, max(0, int((a_start + t) // step)))]
        vb = pb["vocal"][min(len(pb["vocal"]) - 1, max(0, int((b_start + t) // step)))]
        if va >= 0.5 and vb >= 0.5:
            shared += 500
        t += 500
    return shared


def _first_above(profile: dict | None, key: str, threshold: float) -> int | None:
    if not profile or not profile.get(key):
        return None
    for i, v in enumerate(profile[key]):
        if v >= threshold:
            return i * (profile.get("step_ms") or 2000)
    return None


def _facts_lines(aa: dict, ba: dict, ev: dict) -> list[str]:
    lines = []
    if ev["tempo_diff_pct"] is not None and ev["tempo_confidence"] >= 0.4:
        lines.append(f"Tempo: {aa['bpm']:.0f} → {ba['bpm']:.0f} BPM" + (" (half/double time)" if ev["folded"] else ""))
    else:
        lines.append("Tempo uncertain")
    if ev["key_fit"] != "unknown":
        lines.append(f"Key: {aa['key_camelot']} → {ba['key_camelot']}" + (" (compatible)" if ev["key_fit"] == "compatible" else " (clash)"))
    else:
        lines.append("Key uncertain")
    d = ev["loudness_diff_lu"]
    if d is not None:
        lines.append("Similar loudness" if abs(d) <= 2 else f"Song B is {abs(d):.0f} LU {'louder' if d > 0 else 'quieter'}")
    return lines


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
