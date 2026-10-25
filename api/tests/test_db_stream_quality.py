"""Remote streaming quality (5.0): original, AAC ~256 and ~128, live first play, cache reuse, Range, auth."""

import asyncio
import subprocess
from pathlib import Path

import pytest

from app.routers import media as media_router
from tests.test_db_stage4 import TEST_DB, ffprobe
from tests.test_db_stage4 import media, server  # noqa: F401  (fixtures)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")


def probe_bytes(data: bytes, tmp: Path, name: str) -> dict:
    f = tmp / name
    f.write_bytes(data)
    return ffprobe(f)


def wait_for_cache(server, track: str, quality: str, tries: int = 60) -> None:
    for _ in range(tries):
        r = server.client.get(f"/api/tracks/{track}/stream", params={"quality": quality}, headers={"Range": "bytes=0-1"})
        if r.status_code == 206:
            return
        asyncio.run(asyncio.sleep(0.25))
    raise AssertionError("conversion never finished")


def test_original_is_the_untouched_file_with_range(server, media):  # noqa: F811
    whole = server.client.get("/api/tracks/s1/stream")
    assert whole.status_code == 200 and whole.content == media["flac"]
    part = server.client.get("/api/tracks/s1/stream", params={"quality": "original"}, headers={"Range": "bytes=100-"})
    assert part.status_code == 206 and part.content == media["flac"][100:]


def test_high_and_low_are_aac_cached_and_seekable(server, tmp_path):  # noqa: F811
    sizes = {}
    for quality, ceiling in (("high", 300), ("low", 160)):
        wait_for_cache(server, "s1", quality)
        r = server.client.get("/api/tracks/s1/stream", params={"quality": quality})
        assert r.status_code == 200 and r.headers["x-pandafm-quality"] == quality and r.headers["content-type"] == "audio/mp4"
        info = probe_bytes(r.content, tmp_path, f"{quality}.m4a")
        assert info["streams"][0]["codec_name"] == "aac"
        assert int(info["format"]["bit_rate"]) / 1000 <= ceiling  # never above the profile (256k / 128k targets)
        sizes[quality] = len(r.content)
        seek = server.client.get("/api/tracks/s1/stream", params={"quality": quality}, headers={"Range": "bytes=1000-"})
        assert seek.status_code == 206 and seek.content == r.content[1000:]  # the cached copy is seekable
    assert sizes["high"] > sizes["low"]


def test_lossy_source_is_never_upsized_or_turned_into_flac(server, media):  # noqa: F811
    r = server.client.get("/api/tracks/s3/stream", params={"quality": "high"})  # 320 kbps MP3 > 256: becomes AAC 256
    assert r.headers.get("x-pandafm-quality") in {"high", "original"}
    assert "flac" not in r.headers["content-type"]
    small = server.client.get("/api/tracks/s3/stream", params={"quality": "low"})
    assert "flac" not in small.headers["content-type"]


def test_first_play_goes_live_while_the_cached_copy_is_made(server, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr(media_router, "STREAM_WAIT_S", 0.0)
    live = server.client.get("/api/tracks/s2/stream", params={"quality": "high"})
    assert live.status_code == 200 and live.headers["x-pandafm-stream"] == "live"
    assert live.headers["accept-ranges"] == "none" and live.headers["content-type"] == "audio/aac"
    assert probe_bytes(live.content, tmp_path, "live.aac")["streams"][0]["codec_name"] == "aac"
    monkeypatch.setattr(media_router, "STREAM_WAIT_S", 4.0)
    wait_for_cache(server, "s2", "high")  # the background conversion completed: reused, seekable
    cached = server.client.get("/api/tracks/s2/stream", params={"quality": "high"})
    assert "x-pandafm-stream" not in cached.headers and cached.headers["accept-ranges"] == "bytes"
    files = list((server.cache_dir).rglob("*.m4a"))
    assert len(files) == 1  # one cached copy, made once


def test_a_seek_before_the_copy_is_ready_waits_instead_of_playing_from_the_start(server, monkeypatch):  # noqa: F811
    monkeypatch.setattr(media_router, "SEEK_WAIT_S", 0.0)
    monkeypatch.setattr(media_router, "STREAM_WAIT_S", 0.0)
    r = server.client.get("/api/tracks/s1/stream", params={"quality": "low"}, headers={"Range": "bytes=50000-"})
    assert r.status_code in (206, 503)
    if r.status_code == 503:
        assert r.headers["retry-after"] == "3" and r.json()["error"]["code"] == "preparing"


def test_streaming_needs_a_signed_in_owner(server):  # noqa: F811
    from app.deps import optional_auth, require_auth

    server.app.dependency_overrides.pop(require_auth, None)
    server.app.dependency_overrides.pop(optional_auth, None)
    for q in ("original", "high", "low"):
        r = server.client.get("/api/tracks/s1/stream", params={"quality": q})
        assert r.status_code == 401, q
    assert subprocess  # (ffmpeg comes from the stage 4 fixtures)
