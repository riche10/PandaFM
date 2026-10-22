"""Download profiles: what a song becomes on your device. All tuning lives here.

Rules that never bend:
- A lossy source is never converted to a lossless format (no fake "upgrades").
- Originals are copied as-is, never re-encoded.
- Converting never makes a file bigger than keeping the original would be
  for no reason: lossy sources at or below a profile's bitrate stay original.
"""

from dataclasses import dataclass, field

from app.audio.quality import AudioFacts, is_lossless

ANDROID_FRIENDLY_LOSSY = frozenset({"mp3", "aac", "m4a", "ogg", "oga", "opus"})
LOSSY_KEEP_TOLERANCE = 1.15  # a 280 kbps MP3 isn't worth re-encoding to 256 kbps AAC
CONTAINER_OVERHEAD = 1.02
ARTWORK_ALLOWANCE = 150_000  # bytes for embedded cover art in converted files
FLAC_RATIO = 0.6  # rough FLAC size vs uncompressed PCM, for estimates only


@dataclass(frozen=True)
class Profile:
    id: str
    label: str
    description: str
    target: str  # "original" | "flac" | "aac"
    bitrate_kbps: int | None = None
    max_sample_rate: int | None = None
    ffmpeg_audio: tuple[str, ...] = field(default=())


PROFILES: dict[str, Profile] = {
    p.id: p
    for p in (
        Profile("original", "Original", "Your library files exactly as they are.", "original"),
        Profile(
            "lossless_portable",
            "Lossless Portable",
            "Lossless sources as FLAC (originals kept when already portable); lossy sources stay as they are.",
            "flac",
            ffmpeg_audio=("-c:a", "flac", "-compression_level", "5"),
        ),
        Profile(
            "high_quality",
            "High Quality",
            "AAC at 256 kbps. Plays everywhere, about a quarter of lossless size.",
            "aac",
            bitrate_kbps=256,
            max_sample_rate=48_000,
            ffmpeg_audio=("-c:a", "aac", "-b:a", "256k"),
        ),
        Profile(
            "space_saver",
            "Space Saver",
            "AAC at 128 kbps. Fits the most music.",
            "aac",
            bitrate_kbps=128,
            max_sample_rate=48_000,
            ffmpeg_audio=("-c:a", "aac", "-b:a", "128k"),
        ),
    )
}

PORTABLE_LOSSLESS = frozenset({"flac"})  # already ideal for Lossless Portable


@dataclass(frozen=True)
class Plan:
    """What a song becomes under a profile."""

    profile: str
    action: str  # "original" | "convert"
    extension: str
    codec: str
    lossless: bool | None
    bitrate_kbps: int | None
    sample_rate: int | None
    bit_depth: int | None
    estimated_bytes: int | None
    exact_size: bool
    note: str | None = None


def plan(facts: AudioFacts, profile_id: str) -> Plan:
    profile = PROFILES[profile_id]
    suffix = (facts.suffix or "bin").lower()
    lossless = is_lossless(facts)
    original = Plan(profile_id, "original", suffix, suffix, lossless, facts.bitrate_kbps, facts.sample_rate,
                    facts.bit_depth, facts.size_bytes, facts.size_bytes is not None)

    if profile.target == "original":
        return original

    if profile.target == "flac":
        if lossless is not True:
            return _with_note(original, "Lossy source kept as it is: converting it to FLAC wouldn't add quality.")
        if suffix in PORTABLE_LOSSLESS:
            return original
        pcm = _pcm_bytes(facts)
        estimate = int(pcm * FLAC_RATIO) + ARTWORK_ALLOWANCE if pcm else facts.size_bytes
        return Plan(profile_id, "convert", "flac", "flac", True, None, facts.sample_rate, facts.bit_depth, estimate, False)

    # Lossy targets (AAC).
    target = profile.bitrate_kbps or 256
    if lossless is False and suffix in ANDROID_FRIENDLY_LOSSY and (facts.bitrate_kbps or 0) <= target * LOSSY_KEEP_TOLERANCE:
        return _with_note(original, "Already a compact, compatible file: kept as it is.")
    rate = min(facts.sample_rate or 44_100, profile.max_sample_rate or 48_000)
    estimate = int(target * 1000 / 8 * (facts.duration_s or 0) * CONTAINER_OVERHEAD) + ARTWORK_ALLOWANCE if facts.duration_s else None
    return Plan(profile_id, "convert", "m4a", "aac", False, target, rate, None, estimate, False)


def _with_note(p: Plan, note: str) -> Plan:
    return Plan(**{**p.__dict__, "note": note})


def _pcm_bytes(facts: AudioFacts) -> int | None:
    if not (facts.sample_rate and facts.duration_s):
        return None
    return int(facts.sample_rate * (facts.bit_depth or 16) / 8 * (facts.channels or 2) * facts.duration_s)


def ffmpeg_args(facts: AudioFacts, p: Plan, *, source: str, cover: str | None, output: str, tags: dict[str, str]) -> list[str]:
    """The exact ffmpeg command for a conversion. Inputs are local temp files we created."""
    profile = PROFILES[p.profile]
    args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source]
    if cover:
        args += ["-i", cover]
    args += ["-map", "0:a:0"]
    if cover:
        args += ["-map", "1:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic"]
    else:
        args += ["-vn"]
    args += ["-map_metadata", "0", *profile.ffmpeg_audio]
    if p.sample_rate and facts.sample_rate and p.sample_rate < facts.sample_rate:
        args += ["-ar", str(p.sample_rate)]
    if (facts.channels or 2) > 2 and p.codec == "aac":
        args += ["-ac", "2"]
    for key, value in tags.items():
        if value:
            args += ["-metadata", f"{key}={value}"]
    if p.extension == "m4a":
        args += ["-movflags", "+faststart", "-f", "ipod"]
    else:
        args += ["-f", "flac"]
    return [*args, output]
