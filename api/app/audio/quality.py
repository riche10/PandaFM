"""What a file's audio actually is: one place for lossless / Hi-Res rules.

Conservative on purpose. A lossy file is never called lossless, whatever
its container or sample rate, and "Hi-Res" needs a known-lossless source.
"""

from dataclasses import dataclass

# Codecs (by Navidrome's file suffix) that are lossless by nature.
LOSSLESS_SUFFIXES = frozenset({"flac", "wav", "aif", "aiff", "ape", "wv", "tta", "alac", "dsf", "dff"})
LOSSY_SUFFIXES = frozenset({"mp3", "aac", "ogg", "oga", "opus", "wma", "mpc", "mp2"})
# m4a / mp4 hold either AAC (lossy) or ALAC (lossless).
AMBIGUOUS_SUFFIXES = frozenset({"m4a", "mp4", "m4b"})

CODEC_LABELS = {
    "flac": "FLAC", "wav": "WAV", "aif": "AIFF", "aiff": "AIFF", "ape": "APE", "wv": "WavPack", "tta": "TTA",
    "alac": "ALAC", "dsf": "DSD", "dff": "DSD", "mp3": "MP3", "aac": "AAC", "ogg": "Vorbis", "oga": "Vorbis",
    "opus": "Opus", "wma": "WMA", "mpc": "Musepack", "mp2": "MP2",
}

HI_RES_MIN_BITS = 17  # more than 16-bit
HI_RES_MIN_RATE = 48_001  # above 48 kHz


@dataclass(frozen=True)
class AudioFacts:
    suffix: str | None
    content_type: str | None = None
    bitrate_kbps: int | None = None
    sample_rate: int | None = None
    bit_depth: int | None = None
    channels: int | None = None
    size_bytes: int | None = None
    duration_s: int | None = None


def is_lossless(facts: AudioFacts) -> bool | None:
    """True / False when known; None when the file type can't tell us."""
    suffix = (facts.suffix or "").lower()
    if suffix in LOSSLESS_SUFFIXES:
        return True
    if suffix in LOSSY_SUFFIXES:
        return False
    if suffix in AMBIGUOUS_SUFFIXES:
        # ALAC reports a bit depth; AAC doesn't.
        return bool(facts.bit_depth and facts.bit_depth > 0)
    return None


def codec_label(facts: AudioFacts) -> str:
    suffix = (facts.suffix or "").lower()
    if suffix in AMBIGUOUS_SUFFIXES:
        return "ALAC" if is_lossless(facts) else "AAC"
    return CODEC_LABELS.get(suffix, suffix.upper() or "Audio")


def is_hi_res(facts: AudioFacts) -> bool:
    if is_lossless(facts) is not True:
        return False
    return bool((facts.bit_depth or 0) >= HI_RES_MIN_BITS or (facts.sample_rate or 0) >= HI_RES_MIN_RATE)


def revision(facts: AudioFacts) -> str:
    """A fingerprint of the source file as Navidrome describes it. It changes when the
    file is replaced (new size, format or encoding), which invalidates old conversions."""
    import hashlib

    key = f"{facts.size_bytes}:{facts.suffix}:{facts.bitrate_kbps}:{facts.duration_s}:{facts.sample_rate}:{facts.bit_depth}:{facts.channels}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def format_rate(sample_rate: int | None) -> str | None:
    if not sample_rate:
        return None
    khz = sample_rate / 1000
    return f"{khz:g} kHz" if khz != int(khz) else f"{int(khz)} kHz"


def describe(facts: AudioFacts) -> dict:
    """The quality summary the app shows: codec, badges and a technical line."""
    lossless = is_lossless(facts)
    hi_res = is_hi_res(facts)
    rate = format_rate(facts.sample_rate)
    if lossless and facts.bit_depth:
        detail = f"{facts.bit_depth}-bit / {rate}" if rate else f"{facts.bit_depth}-bit"
    else:
        detail = rate
    badge = "HI-RES" if hi_res else "LOSSLESS" if lossless else None
    short = None
    if lossless and facts.bit_depth and facts.sample_rate:
        short = f"{facts.bit_depth}/{facts.sample_rate / 1000:g}"
    return {
        "codec": codec_label(facts),
        "lossless": lossless,
        "hi_res": hi_res,
        "badge": badge,
        "detail": detail,  # "24-bit / 96 kHz" or "44.1 kHz"
        "short": short,  # "24/96"
        "bitrate_kbps": facts.bitrate_kbps,
    }


def sql_lossless(alias: str = "t") -> tuple[str, dict]:
    """A WHERE fragment matching is_lossless() exactly (same constants)."""
    return (
        f"(lower({alias}.suffix) = ANY(CAST(:q_lossless AS text[])) OR "
        f"(lower({alias}.suffix) = ANY(CAST(:q_ambiguous AS text[])) AND coalesce({alias}.bit_depth, 0) > 0))",
        {"q_lossless": sorted(LOSSLESS_SUFFIXES), "q_ambiguous": sorted(AMBIGUOUS_SUFFIXES)},
    )


def sql_hi_res(alias: str = "t") -> tuple[str, dict]:
    """A WHERE fragment matching is_hi_res(): known lossless AND (>16-bit OR >48 kHz)."""
    lossless, params = sql_lossless(alias)
    return (
        f"({lossless} AND (coalesce({alias}.bit_depth, 0) >= :q_bits OR coalesce({alias}.sample_rate, 0) >= :q_rate))",
        {**params, "q_bits": HI_RES_MIN_BITS, "q_rate": HI_RES_MIN_RATE},
    )
