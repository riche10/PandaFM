"""5.4.2: opening an audio stream may wait for sleeping disks; everything else stays quick."""

import asyncio
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors import classify, register_error_handlers
from app.navidrome.client import (
    NavidromeAuthError,
    NavidromeClient,
    NavidromeNotFound,
    NavidromeSlow,
    NavidromeUnavailable,
)


class Stub(BaseHTTPRequestHandler):
    """A Navidrome stand-in: /rest/stream waits `stream_delay` (a waking disk), the rest `meta_delay`."""

    stream_delay = 0.0
    meta_delay = 0.0

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0].endswith("/rest/stream"):
            time.sleep(Stub.stream_delay)
            body = b"fLaC" + b"\0" * 2048
            self.send_response(200)
            self.send_header("Content-Type", "audio/flac")
        else:
            time.sleep(Stub.meta_delay)
            body = json.dumps({"subsonic-response": {"status": "ok", "version": "1.16.1", "type": "navidrome"}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def navidrome():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    Stub.stream_delay = Stub.meta_delay = 0.0
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


async def _open(url, delay, timeout=0.3, stream_timeout=1.5):
    Stub.stream_delay = delay
    client = NavidromeClient(url, "panda", "secret-pw", timeout=timeout, stream_timeout=stream_timeout)
    started = time.monotonic()
    try:
        stream = await client.open_stream("t1")
        status = stream.status_code if hasattr(stream, "status_code") else 200
        await stream.aclose() if hasattr(stream, "aclose") else None
        return status, time.monotonic() - started
    finally:
        await client.aclose()


def test_warm_storage_starts_at_once(navidrome):
    status, took = asyncio.run(_open(navidrome, 0.0))
    assert status in (200, 206) and took < 0.3


def test_cold_storage_waits_within_the_stream_timeout(navidrome):
    status, took = asyncio.run(_open(navidrome, 0.8))  # slower than the 0.3 s metadata timeout, within the 1.5 s stream one
    assert status in (200, 206) and 0.8 <= took < 1.5


def test_too_slow_storage_is_a_distinct_transient_error(navidrome):
    started = time.monotonic()
    with pytest.raises(NavidromeSlow):
        asyncio.run(_open(navidrome, 2.5))
    assert 1.4 < time.monotonic() - started < 2.4  # bounded by the stream timeout, not hanging


def test_metadata_calls_keep_their_short_timeout(navidrome):
    async def ping():
        Stub.meta_delay = 0.8
        client = NavidromeClient(navidrome, "panda", "secret-pw", timeout=0.3, stream_timeout=5.0)
        try:
            await client.ping()
        finally:
            await client.aclose()
    started = time.monotonic()
    with pytest.raises(NavidromeUnavailable) as caught:
        asyncio.run(ping())
    assert not isinstance(caught.value, NavidromeSlow)
    assert time.monotonic() - started < 0.7


def _app():
    app = FastAPI()
    register_error_handlers(app)
    for name, exc in {"slow": NavidromeSlow("x"), "down": NavidromeUnavailable("x"), "auth": NavidromeAuthError("x", 40), "gone": NavidromeNotFound("x", 70)}.items():
        app.add_api_route(f"/{name}", (lambda e: (lambda: (_ for _ in ()).throw(e)))(exc))
    return TestClient(app)


def test_errors_say_what_happened_safely():
    c = _app()
    slow = c.get("/slow")
    assert (slow.status_code, slow.json()["error"]["code"], slow.headers["Retry-After"], slow.headers["X-PandaFM-Error"]) == (503, "navidrome_unavailable", "5", "navidrome_unavailable")
    assert "longer than expected" in slow.json()["error"]["message"]
    down = c.get("/down")
    assert down.status_code == 503 and down.headers["Retry-After"] == "5"
    auth = c.get("/auth")
    assert (auth.status_code, auth.headers["X-PandaFM-Error"]) == (503, "navidrome_auth") and "Retry-After" not in auth.headers  # retrying won't fix credentials
    gone = c.get("/gone")
    assert (gone.status_code, gone.headers["X-PandaFM-Error"]) == (404, "not_found") and "Retry-After" not in gone.headers
    assert classify(NavidromeSlow("x")) == (503, "navidrome_unavailable")


def test_a_failed_stream_open_is_logged_without_secrets(caplog):
    from app.routers.media import stream_track

    class FakeNavidrome:
        async def open_stream(self, track_id, **kwargs):
            raise NavidromeSlow("Navidrome didn't start the audio within 30s")

    caplog.set_level(logging.INFO, logger="pandafm.stream")
    with pytest.raises(NavidromeSlow):
        asyncio.run(stream_track("trk42", FakeNavidrome(), None, None, 1, "original", "bytes=0-", None))
    lines = [r.getMessage() for r in caplog.records if r.name == "pandafm.stream"]
    assert lines[0] == "stream_open track=trk42 quality=original range=yes waiting_for_navidrome"
    assert "failed" in lines[1] and "panda_status=503 error=navidrome_unavailable" in lines[1] and "elapsed_ms=" in lines[1]
    import re

    text = " ".join(lines)
    assert "secret" not in text and "Authorization" not in text
    assert not re.search(r"[?&](t|s|u|p)=", text)  # no Subsonic credential query parameters



def test_a_502_names_what_navidrome_actually_did(caplog):
    """5.5.1: repeated 'HTTP 502 · navidrome_error' must be explainable from one log line."""
    from app.navidrome.client import NavidromeError
    from app.routers.media import stream_track

    cases = [(NavidromeError("Error opening file", 0), "panda_status=502 error=navidrome_error upstream=subsonic_0"),
             (NavidromeUnavailable("Navidrome returned HTTP 500 for stream"), "panda_status=503 error=navidrome_unavailable upstream=http_500"),
             (NavidromeUnavailable("Cannot reach Navidrome (ConnectError: refused)"), "upstream=connect"),
             (NavidromeSlow("Navidrome didn't start the audio within 30s"), "upstream=timeout")]
    caplog.set_level(logging.INFO, logger="pandafm.stream")
    for exc, expected in cases:
        class Fake:
            async def open_stream(self, track_id, **kwargs):
                raise exc
        caplog.clear()
        with pytest.raises(type(exc)):
            asyncio.run(stream_track("trk9", Fake(), None, None, 1, "original", None, None))
        line = [r.getMessage() for r in caplog.records if r.name == "pandafm.stream"][-1]
        assert expected in line and "track=trk9 quality=original" in line, line
