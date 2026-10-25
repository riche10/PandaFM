"""Downloads against a real PostgreSQL and real ffmpeg: conversions, the cache,
manifests and file serving. Skipped without PANDAFM_TEST_DATABASE_URL or ffmpeg."""

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app.deps import get_navidrome
from app.main import create_app
from app.migrate import upgrade
from tests.fakes import sign_in_as_first_user, FakeNavidrome
from tests.test_db_stage3 import TEST_DB, settings

pytestmark = [
    pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests"),
    pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is needed for conversion tests"),
]


def _make(path: Path, args: list[str]) -> bytes:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", *args, str(path)], check=True)
    return path.read_bytes()


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("media")
    files = {
        "flac": _make(d / "a.flac", ["-ar", "96000", "-sample_fmt", "s32", "-c:a", "flac"]),
        "wav": _make(d / "b.wav", ["-ar", "44100"]),
        "mp3": _make(d / "c.mp3", ["-b:a", "320k"]),
    }
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", str(d / "cover.jpg")], check=True)
    files["cover"] = (d / "cover.jpg").read_bytes()
    return files


def song(sid: str, suffix: str, data: bytes, **extra) -> dict:
    facts = {"flac": (96000, 24, "audio/flac", 2800), "wav": (44100, 16, "audio/wav", 1411), "mp3": (44100, 0, "audio/mpeg", 320)}[suffix]
    return {"id": sid, "title": f"Song {sid}", "artist": "Neon Panda", "artistId": "ar1", "album": "Midnight Drive", "albumId": "al1",
            "displayAlbumArtist": "Neon Panda", "track": int(sid[-1]), "year": 1986, "genres": [{"name": "Synthwave"}], "duration": 3,
            "coverArt": "al-1", "suffix": suffix, "contentType": facts[2], "bitRate": facts[3], "samplingRate": facts[0],
            "bitDepth": facts[1], "channelCount": 1, "size": len(data), **extra}


class Server:
    def __init__(self, media):
        self.files = {"s1": media["flac"], "s2": media["wav"], "s3": media["mp3"]}
        self.songs = {"s1": song("s1", "flac", media["flac"]), "s2": song("s2", "wav", media["wav"]), "s3": song("s3", "mp3", media["mp3"])}
        self.cover = media["cover"]
        self.stream_calls = 0

    def get_song(self, request):
        sid = request.url.params["id"]
        if sid not in self.songs:
            return httpx.Response(200, json={"subsonic-response": {"status": "failed", "error": {"code": 70, "message": "Song not found"}}})
        return httpx.Response(200, json={"subsonic-response": {"status": "ok", "song": self.songs[sid]}})

    def stream(self, request):
        self.stream_calls += 1
        data = self.files[request.url.params["id"]]
        requested = request.headers.get("range")
        if requested:
            start = int(requested.split("=")[1].split("-")[0])
            part = data[start:]
            return httpx.Response(206, headers={"Content-Type": "audio/x", "Content-Length": str(len(part)), "Content-Range": f"bytes {start}-{len(data) - 1}/{len(data)}"}, stream=httpx.ByteStream(part))
        return httpx.Response(200, headers={"Content-Type": "audio/x", "Content-Length": str(len(data)), "Accept-Ranges": "bytes"}, stream=httpx.ByteStream(data))

    def album(self, request):
        return httpx.Response(200, json={"subsonic-response": {"status": "ok", "album": {"id": "al1", "name": "Midnight Drive", "artist": "Neon Panda", "song": list(self.songs.values())}}})

    def fake(self) -> FakeNavidrome:
        return (FakeNavidrome().handle("getSong", self.get_song).handle("stream", self.stream).handle("getAlbum", self.album)
                .handle("getCoverArt", lambda r: httpx.Response(200, headers={"Content-Type": "image/jpeg"}, content=self.cover)))


@pytest.fixture
def server(media, tmp_path):
    upgrade(settings())
    engine = create_engine(settings().database_url)
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE conversions, listening_events, track_preferences, radio_queue_items, radio_sessions, library_syncs, tracks RESTART IDENTITY CASCADE"))
    engine.dispose()
    srv = Server(media)
    app = create_app(settings().model_copy(update={"cache_dir": str(tmp_path / "cache"), "cache_max_gb": 1.0}))
    fake = srv.fake().client()
    app.dependency_overrides[get_navidrome] = lambda: fake
    sign_in_as_first_user(app)  # not about sign-in (see test_db_auth.py)
    client = TestClient(app)
    client.__enter__()
    app.state.conversions._navidrome = fake
    srv.client, srv.app, srv.cache_dir = client, app, tmp_path / "cache"
    yield srv
    client.__exit__(None, None, None)


def ffprobe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_audio_info_reports_quality_and_profile_plans(server):
    info = server.client.get("/api/tracks/s1/audio-info").json()
    assert info["quality"]["badge"] == "HI-RES" and info["quality"]["detail"] == "24-bit / 96 kHz"
    plans = {p["profile"]: p for p in info["plans"]}
    assert plans["original"]["extension"] == "flac" and plans["original"]["exact_size"]
    assert plans["high_quality"]["codec"] == "aac" and not plans["high_quality"]["exact_size"]
    mp3 = {p["profile"]: p for p in server.client.get("/api/tracks/s3/audio-info").json()["plans"]}
    assert mp3["lossless_portable"]["action"] == "original" and mp3["lossless_portable"]["codec"] == "mp3"


def test_album_manifest_with_paths_estimates_and_no_server_paths(server):
    manifest = server.client.post("/api/downloads/prepare", json={"kind": "album", "id": "al1", "profile": "original", "warm": False}).json()
    assert manifest["name"] == "Midnight Drive" and len(manifest["items"]) == 3
    paths = [i["relative_path"] for i in manifest["items"]]
    assert paths[0] == "Music/Neon Panda/Midnight Drive/01 - Song s1.flac"
    assert all(i["status"] == "ready" and i["size_bytes"] for i in manifest["items"])  # originals: exact sizes
    estimates = {e["profile"]: e for e in manifest["estimates"]}
    assert estimates["original"]["exact"] and not estimates["high_quality"]["exact"]
    assert "/cache" not in json.dumps(manifest) and "/music" not in json.dumps(manifest)


def test_original_download_is_the_untouched_file_and_resumes(server):
    whole = server.client.get("/api/downloads/files/s1/original")
    assert whole.status_code == 200 and whole.content == server.files["s1"]
    assert "attachment" in whole.headers["content-disposition"]
    rest = server.client.get("/api/downloads/files/s1/original", headers={"Range": "bytes=100-"})
    assert rest.status_code == 206 and rest.content == server.files["s1"][100:]


def test_lossy_source_is_never_turned_into_flac(server):
    response = server.client.get("/api/downloads/files/s3/lossless_portable")
    assert response.content == server.files["s3"]  # the MP3 itself


def test_high_quality_conversion_keeps_tags_and_artwork_and_is_cached(server):
    first = server.client.get("/api/downloads/files/s1/high_quality")
    assert first.status_code == 200
    out = server.cache_dir / "check.m4a"
    out.write_bytes(first.content)
    probe = ffprobe(out)
    audio = next(s for s in probe["streams"] if s["codec_type"] == "audio")
    assert audio["codec_name"] == "aac" and audio["sample_rate"] == "48000"
    assert any(s["codec_type"] == "video" for s in probe["streams"])  # embedded cover
    tags = {k.lower(): v for k, v in probe["format"]["tags"].items()}
    assert tags["title"] == "Song s1" and tags["artist"] == "Neon Panda" and tags["album"] == "Midnight Drive"
    assert first.headers["x-pandafm-sha256"] == hashlib.sha256(first.content).hexdigest()

    calls = server.stream_calls
    again = server.client.get("/api/downloads/files/s1/high_quality", headers={"Range": "bytes=10-"})
    assert again.status_code == 206 and again.content == first.content[10:]
    assert server.stream_calls == calls  # served from the cache, no new conversion
    assert not list(server.cache_dir.rglob("*.part")) and not list((server.cache_dir / "tmp").iterdir())


def test_wav_becomes_lossless_flac(server):
    response = server.client.get("/api/downloads/files/s2/lossless_portable")
    out = server.cache_dir / "check.flac"
    out.write_bytes(response.content)
    audio = next(s for s in ffprobe(out)["streams"] if s["codec_type"] == "audio")
    assert audio["codec_name"] == "flac" and audio["sample_rate"] == "44100"


def test_space_saver_and_manifest_reports_ready_conversions(server):
    assert server.client.get("/api/downloads/files/s1/space_saver").status_code == 200
    manifest = server.client.post("/api/downloads/prepare", json={"kind": "tracks", "track_ids": ["s1"], "profile": "space_saver", "warm": False}).json()
    item = manifest["items"][0]
    assert item["status"] == "ready" and item["sha256"] and item["relative_path"].endswith(".m4a")


def test_changed_source_invalidates_the_old_conversion(server):
    server.client.get("/api/downloads/files/s1/space_saver")
    old = list((server.cache_dir / "conversions").rglob("*.m4a"))
    server.songs["s1"]["size"] += 1  # the library file was replaced
    server.client.get("/api/downloads/files/s1/space_saver")
    new = list((server.cache_dir / "conversions").rglob("*.m4a"))
    assert len(new) == 1 and new != old


def test_failed_conversion_leaves_nothing_that_looks_valid(server):
    server.files["s2"] = b"not audio at all"
    response = server.client.get("/api/downloads/files/s2/high_quality")
    assert response.status_code == 502 and response.json()["error"]["code"] == "conversion_failed"
    assert not list((server.cache_dir / "conversions").rglob("*.m4a")) and not list(server.cache_dir.rglob("*.part"))


def test_cache_cleanup_removes_least_recently_used_first(server):
    server.client.get("/api/downloads/files/s1/space_saver")
    server.client.get("/api/downloads/files/s2/space_saver")
    cache = server.app.state.conversions
    cache.max_bytes = 1  # pretend the cache is full
    freed = server.client.portal.call(cache.enforce_limit)  # run on the app's event loop
    assert freed > 0
    assert server.client.get("/api/downloads/cache").json()["entries"] == 0


def test_unknown_ids_and_profiles_are_rejected(server):
    assert server.client.get("/api/downloads/files/s1/everything").status_code == 404
    assert server.client.get("/api/downloads/files/..%2F..%2Fetc%2Fpasswd/original").status_code == 404
    assert server.client.get("/api/downloads/files/s1/..").status_code in (404, 422)
    assert server.client.post("/api/downloads/prepare", json={"kind": "tracks", "track_ids": ["s1"], "profile": "lossless_please"}).status_code == 422
