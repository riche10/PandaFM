"""Audio facts, quality labels, download profiles, ffmpeg commands and safe file names."""

import pytest

from app.audio.files import relative_path, safe_component
from app.audio.profiles import PROFILES, ffmpeg_args, plan
from app.audio.quality import LOSSY_SUFFIXES, AudioFacts, describe, is_hi_res, is_lossless

FLAC_CD = AudioFacts("flac", "audio/flac", 900, 44_100, 16, 2, 30_000_000, 240)
FLAC_HIRES = AudioFacts("flac", "audio/flac", 3100, 96_000, 24, 2, 90_000_000, 240)
WAV = AudioFacts("wav", "audio/wav", 1411, 44_100, 16, 2, 42_000_000, 240)
ALAC = AudioFacts("m4a", "audio/mp4", 1000, 48_000, 24, 2, 35_000_000, 240)
AAC = AudioFacts("m4a", "audio/mp4", 256, 44_100, None, 2, 7_700_000, 240)
MP3_320 = AudioFacts("mp3", "audio/mpeg", 320, 44_100, None, 2, 9_600_000, 240)
MP3_192 = AudioFacts("mp3", "audio/mpeg", 192, 44_100, None, 2, 5_800_000, 240)
LOSSY_96K = AudioFacts("mp3", "audio/mpeg", 320, 96_000, None, 2, 9_600_000, 240)


# ── Quality ───────────────────────────────────────────────────────────


def test_lossless_and_lossy_are_told_apart():
    assert is_lossless(FLAC_CD) and is_lossless(WAV) and is_lossless(ALAC)
    assert is_lossless(MP3_320) is False and is_lossless(AAC) is False
    assert is_lossless(AudioFacts("xyz")) is None  # unknown: not claimed either way


def test_hi_res_is_conservative():
    assert is_hi_res(FLAC_HIRES) and is_hi_res(ALAC)  # 24-bit
    assert is_hi_res(AudioFacts("flac", sample_rate=96_000, bit_depth=16))  # >48 kHz
    assert not is_hi_res(FLAC_CD)
    assert not is_hi_res(LOSSY_96K)  # a lossy file is never hi-res, whatever its rate


def test_quality_labels():
    assert describe(FLAC_HIRES) == {"codec": "FLAC", "lossless": True, "hi_res": True, "badge": "HI-RES", "detail": "24-bit / 96 kHz", "short": "24/96", "bitrate_kbps": 3100}
    assert describe(FLAC_CD)["badge"] == "LOSSLESS" and describe(FLAC_CD)["detail"] == "16-bit / 44.1 kHz"
    assert describe(AAC) == {"codec": "AAC", "lossless": False, "hi_res": False, "badge": None, "detail": "44.1 kHz", "short": None, "bitrate_kbps": 256}
    assert describe(ALAC)["codec"] == "ALAC"


# ── Profiles ──────────────────────────────────────────────────────────


def test_original_is_never_reencoded():
    for facts in (FLAC_HIRES, WAV, ALAC, AAC, MP3_320):
        p = plan(facts, "original")
        assert p.action == "original" and p.extension == facts.suffix and p.exact_size


def test_lossless_portable():
    assert plan(FLAC_HIRES, "lossless_portable").action == "original"  # FLAC is already portable
    wav = plan(WAV, "lossless_portable")
    assert (wav.action, wav.codec, wav.lossless, wav.exact_size) == ("convert", "flac", True, False)
    alac = plan(ALAC, "lossless_portable")
    assert alac.codec == "flac" and alac.bit_depth == 24 and alac.sample_rate == 48_000  # no needless downsampling


@pytest.mark.parametrize("suffix", sorted(LOSSY_SUFFIXES) + ["m4a"])
@pytest.mark.parametrize("profile", sorted(PROFILES))
def test_a_lossy_source_never_becomes_flac(suffix: str, profile: str):
    facts = AudioFacts(suffix, bitrate_kbps=320, sample_rate=44_100, duration_s=200, size_bytes=8_000_000)
    p = plan(facts, profile)
    assert p.codec != "flac" and p.lossless is not True


def test_lossy_targets():
    hq = plan(FLAC_HIRES, "high_quality")
    assert (hq.action, hq.codec, hq.extension, hq.bitrate_kbps, hq.sample_rate) == ("convert", "aac", "m4a", 256, 48_000)
    assert plan(MP3_192, "high_quality").action == "original"  # smaller than the target already
    assert plan(MP3_320, "high_quality").action == "convert"
    assert plan(MP3_320, "space_saver").bitrate_kbps == 128
    assert plan(AudioFacts("wma", bitrate_kbps=128, duration_s=100), "space_saver").action == "convert"  # not Android-friendly


def test_estimates_are_marked_as_estimates():
    hq = plan(FLAC_CD, "high_quality")
    assert not hq.exact_size and 7_000_000 < hq.estimated_bytes < 8_200_000  # 256 kbps x 240 s + artwork
    assert plan(FLAC_CD, "original").estimated_bytes == 30_000_000 and plan(FLAC_CD, "original").exact_size


def test_ffmpeg_command_preserves_metadata_and_artwork():
    p = plan(FLAC_HIRES, "high_quality")
    args = ffmpeg_args(FLAC_HIRES, p, source="/cache/tmp/a.source", cover="/cache/tmp/a.jpg", output="/cache/conversions/ab/a.m4a.part",
                       tags={"title": "Night Run", "artist": "Neon Panda", "album": "", "date": "1986"})
    joined = " ".join(args)
    assert args[:2] == ["ffmpeg", "-nostdin"] and args[-1].endswith(".part")
    assert "-map_metadata 0" in joined and "-disposition:v:0 attached_pic" in joined
    assert "-c:a aac -b:a 256k" in joined and "-ar 48000" in joined and "-f ipod" in joined
    assert "-metadata title=Night Run" in joined and "album=" not in joined  # empty tags skipped
    flac = ffmpeg_args(WAV, plan(WAV, "lossless_portable"), source="s", cover=None, output="o.flac.part", tags={})
    assert "-vn" in flac and "-c:a flac" in " ".join(flac) and "-ar" not in flac


# ── File names ────────────────────────────────────────────────────────


def test_paths_are_clean_relative_and_cannot_escape():
    path = relative_path(artist="AC/DC", album="../../etc", title='What? "Now"*', track_number=3, disc_number=1, extension="flac", track_id="t1")
    assert path == "Music/AC_DC/_.._etc/03 - What_ _Now__.flac"
    assert ".." not in path.split("/") and not path.startswith("/")
    assert safe_component("CON") == "_CON" and safe_component("   ") == "Unknown" and safe_component("...") == "Unknown"
    assert len(safe_component("x" * 500)) == 100
    two_discs = relative_path(artist="A", album="B", title="Intro", track_number=1, disc_number=2, extension="mp3", track_id="t2")
    assert two_discs.endswith("2-01 - Intro.mp3")


def test_clashing_names_get_a_stable_disambiguator():
    a = relative_path(artist="A", album="B", title="Song", track_number=None, disc_number=None, extension="mp3", track_id="x1", disambiguate=True)
    b = relative_path(artist="A", album="B", title="Song", track_number=None, disc_number=None, extension="mp3", track_id="x2", disambiguate=True)
    assert a != b and a == relative_path(artist="A", album="B", title="Song", track_number=None, disc_number=None, extension="mp3", track_id="x1", disambiguate=True)
    assert relative_path(artist="A", album="B", title="S", track_number=1, disc_number=None, extension="../exe", track_id="x").endswith(".exe")
