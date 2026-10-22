"""Audio streaming and cover art proxying."""

import anyio
import httpx
import pytest
from starlette.requests import ClientDisconnect

from app.navidrome.client import AudioStream
from app.routers.media import ProxiedAudioResponse
from tests.fakes import FakeNavidrome, api_client, assert_no_secrets, subsonic_error

AUDIO = bytes(range(256)) * 20  # 5120 bytes standing in for an MP3
LAST_MODIFIED = "Wed, 21 Oct 2026 23:58:32 GMT"


def streamed(status: int, headers: dict[str, str], body: bytes) -> httpx.Response:
    """A response whose body is still unread, like one off the network.

    (httpx.Response(content=...) reads itself into memory immediately, which
    a real Navidrome response never does.)
    """
    return httpx.Response(status, headers=headers, stream=httpx.ByteStream(body))


def audio_handler(request: httpx.Request) -> httpx.Response:
    """Behaves like Navidrome's /rest/stream for raw files, including Range."""
    common = {
        "Accept-Ranges": "bytes",
        "Content-Type": "audio/mpeg",
        "Last-Modified": LAST_MODIFIED,
        "X-Content-Duration": "95.03",
        "Set-Cookie": "nd-player-70616e6461=abc; Path=/; HttpOnly",
    }
    requested = request.headers.get("range")
    if requested is None:
        return streamed(200, common | {"Content-Length": str(len(AUDIO))}, AUDIO)

    start_text, end_text = requested.removeprefix("bytes=").split("-")
    start = int(start_text)
    if start >= len(AUDIO):
        message = b"416 Requested Range Not Satisfiable"
        return streamed(
            416,
            {
                "Content-Range": f"bytes */{len(AUDIO)}",
                "Content-Type": "text/plain",
                "Content-Length": str(len(message)),
            },
            message,
        )
    end = int(end_text) if end_text else len(AUDIO) - 1
    part = AUDIO[start : end + 1]
    return streamed(
        206,
        common | {"Content-Range": f"bytes {start}-{end}/{len(AUDIO)}", "Content-Length": str(len(part))},
        part,
    )


# ── /api/tracks/{id}/stream ──────────────────────────────────────────


def test_full_stream_passes_audio_and_safe_headers_only():
    fake = FakeNavidrome().handle("stream", audio_handler)
    with api_client(fake) as client:
        response = client.get("/api/tracks/t1/stream")

    assert response.status_code == 200
    assert response.content == AUDIO
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["content-length"] == str(len(AUDIO))
    assert response.headers["accept-ranges"] == "bytes"
    assert "set-cookie" not in response.headers  # Navidrome's player cookie stays server-side
    assert_no_secrets(fake, response)

    sent = fake.last("stream")
    assert sent.url.params["id"] == "t1"
    assert sent.url.params["format"] == "raw"  # original file, so byte ranges work
    assert sent.headers["accept-encoding"] == "identity"
    assert "range" not in sent.headers


def test_range_and_if_range_are_forwarded_and_partial_content_returned():
    fake = FakeNavidrome().handle("stream", audio_handler)
    with api_client(fake) as client:
        response = client.get(
            "/api/tracks/t1/stream",
            headers={"Range": "bytes=1000-1999", "If-Range": LAST_MODIFIED},
        )

    sent = fake.last("stream")
    assert sent.headers["range"] == "bytes=1000-1999"
    assert sent.headers["if-range"] == LAST_MODIFIED

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 1000-1999/{len(AUDIO)}"
    assert response.headers["content-length"] == "1000"
    assert response.content == AUDIO[1000:2000]


def test_open_ended_range_used_when_seeking():
    fake = FakeNavidrome().handle("stream", audio_handler)
    with api_client(fake) as client:
        response = client.get("/api/tracks/t1/stream", headers={"Range": "bytes=5000-"})

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 5000-5119/{len(AUDIO)}"
    assert response.content == AUDIO[5000:]


def test_unsatisfiable_range_is_passed_through():
    fake = FakeNavidrome().handle("stream", audio_handler)
    with api_client(fake) as client:
        response = client.get("/api/tracks/t1/stream", headers={"Range": "bytes=999999-"})

    assert response.status_code == 416
    assert response.headers["content-range"] == f"bytes */{len(AUDIO)}"


def test_missing_track_stream_is_404_json():
    # Navidrome answers a missing song with HTTP 200 and a JSON error envelope.
    fake = FakeNavidrome().json("stream", subsonic_error(70, "data not found"))
    with api_client(fake) as client:
        response = client.get("/api/tracks/nope/stream")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_failed_upstream_stream_is_503():
    fake = FakeNavidrome().handle("stream", lambda request: httpx.Response(500, text="boom"))
    with api_client(fake) as client:
        response = client.get("/api/tracks/t1/stream")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "navidrome_unavailable"


# ── streaming behaviour: incremental, and always cleaned up ──────────


class TrackedStream(httpx.AsyncByteStream):
    """An upstream body that yields one chunk, then waits on a gate."""

    def __init__(self, gate: anyio.Event) -> None:
        self.gate = gate
        self.closed = False

    async def __aiter__(self):
        yield b"first-chunk"
        await self.gate.wait()
        yield b"second-chunk"

    async def aclose(self) -> None:
        self.closed = True


def gated_navidrome(upstream: TrackedStream) -> FakeNavidrome:
    return FakeNavidrome().handle(
        "stream",
        lambda request: httpx.Response(200, headers={"Content-Type": "audio/mpeg"}, stream=upstream),
    )


@pytest.mark.anyio
async def test_stream_is_forwarded_incrementally_not_buffered():
    gate = anyio.Event()
    upstream = TrackedStream(gate)
    client = gated_navidrome(upstream).client()

    with anyio.fail_after(2):  # would hang here if the whole body were read first
        stream = await client.open_stream("t1")
        chunks = stream.iter_bytes()
        assert await chunks.__anext__() == b"first-chunk"

    gate.set()
    assert await chunks.__anext__() == b"second-chunk"
    with pytest.raises(StopAsyncIteration):
        await chunks.__anext__()
    assert upstream.closed


async def _run_response(upstream: TrackedStream, spec_version: str, send, receive) -> None:
    client = gated_navidrome(upstream).client()
    stream: AudioStream = await client.open_stream("t1")
    response = ProxiedAudioResponse(stream)
    scope = {"type": "http", "asgi": {"spec_version": spec_version}}
    await response(scope, receive, send)


@pytest.mark.anyio
async def test_client_disconnect_closes_upstream_asgi_2_4():
    # ASGI 2.4 servers report a vanished client as OSError from send().
    upstream = TrackedStream(anyio.Event())

    async def send(message):
        if message["type"] == "http.response.body" and message.get("body"):
            raise OSError("client went away")

    async def receive():
        await anyio.sleep_forever()

    with pytest.raises(ClientDisconnect):
        await _run_response(upstream, "2.4", send, receive)
    assert upstream.closed


@pytest.mark.anyio
async def test_client_disconnect_closes_upstream_asgi_2_3():
    # Older servers (uvicorn today) send an http.disconnect message instead.
    upstream = TrackedStream(anyio.Event())  # gate never opens: song "still playing"
    first_body_sent = anyio.Event()

    async def send(message):
        if message["type"] == "http.response.body" and message.get("body"):
            first_body_sent.set()

    async def receive():
        await first_body_sent.wait()
        return {"type": "http.disconnect"}

    with anyio.fail_after(2):
        await _run_response(upstream, "2.3", send, receive)
    assert upstream.closed


# ── /api/covers/{id} ─────────────────────────────────────────────────

JPEG = b"\xff\xd8\xff\xe0fake-jpeg-bytes"
ETAG = '"38eab189e80e9ca3.200.false.q75"'


def cover_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        headers={"Content-Type": "image/jpeg", "ETag": ETAG, "Cache-Control": "public, no-cache"},
        content=JPEG,
    )


def test_cover_art_is_proxied_with_caching_headers():
    fake = FakeNavidrome().handle("getCoverArt", cover_handler)
    with api_client(fake) as client:
        response = client.get("/api/covers/al-1_abc", params={"size": 300})

    assert response.status_code == 200
    assert response.content == JPEG
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "private, max-age=604800"
    assert response.headers["etag"] == ETAG
    assert fake.last("getCoverArt").url.params["size"] == "300"
    assert_no_secrets(fake, response)


def test_cover_art_revalidation_returns_304():
    fake = FakeNavidrome().handle("getCoverArt", cover_handler)
    with api_client(fake) as client:
        response = client.get("/api/covers/al-1_abc", headers={"If-None-Match": ETAG})

    assert response.status_code == 304
    assert response.content == b""


def test_missing_cover_art_is_404():
    fake = FakeNavidrome().json("getCoverArt", subsonic_error(70, "Artwork not found"))
    with api_client(fake) as client:
        response = client.get("/api/covers/al-missing")
    assert response.status_code == 404


def test_non_image_cover_response_is_503():
    fake = FakeNavidrome().handle(
        "getCoverArt", lambda request: httpx.Response(200, headers={"Content-Type": "text/html"}, text="<html>")
    )
    with api_client(fake) as client:
        response = client.get("/api/covers/al-1")
    assert response.status_code == 503


def test_cover_size_is_validated():
    fake = FakeNavidrome()
    with api_client(fake) as client:
        response = client.get("/api/covers/al-1", params={"size": 5000})
    assert response.status_code == 422
    assert fake.requests == []
