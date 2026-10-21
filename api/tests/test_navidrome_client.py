"""NavidromeClient tests. No network: httpx.MockTransport fakes Navidrome.

The response bodies are copied from a real Navidrome 0.64.2 server.
"""

import hashlib

import httpx
import pytest

from app.navidrome.client import (
    NavidromeAuthError,
    NavidromeClient,
    NavidromeError,
    NavidromeNotFound,
    NavidromeUnavailable,
)

PASSWORD = "bamboo-test"

PING_OK = {
    "subsonic-response": {
        "status": "ok",
        "version": "1.16.1",
        "type": "navidrome",
        "serverVersion": "0.64.2 (10114574)",
        "openSubsonic": True,
    }
}


def failed(code: int, message: str) -> dict:
    body = dict(PING_OK["subsonic-response"], status="failed")
    body["error"] = {"code": code, "message": message}
    return {"subsonic-response": body}


def make_client(handler) -> NavidromeClient:
    return NavidromeClient(
        "http://navidrome:4533", "panda", PASSWORD, transport=httpx.MockTransport(handler)
    )


def test_token_auth_never_sends_password_and_uses_fresh_salt():
    client = make_client(lambda request: httpx.Response(200, json=PING_OK))
    first, second = client._auth_params(), client._auth_params()

    assert first["t"] == hashlib.md5((PASSWORD + first["s"]).encode()).hexdigest()
    assert first["s"] != second["s"]
    assert PASSWORD not in first.values()
    assert first["u"] == "panda" and first["c"] == "pandafm"


@pytest.mark.anyio
async def test_ping_parses_server_info_and_sends_expected_query():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=PING_OK)

    client = make_client(handler)
    info = await client.ping()
    await client.aclose()

    assert info.server_type == "navidrome"
    assert info.server_version == "0.64.2 (10114574)"
    assert info.open_subsonic is True
    request = seen[0]
    assert request.url.path == "/rest/ping"
    assert request.url.params["f"] == "json"
    assert request.url.params["v"] == "1.16.1"
    assert "p" not in request.url.params  # plaintext password parameter never used


@pytest.mark.anyio
async def test_wrong_password_is_an_auth_error_even_though_http_status_is_200():
    client = make_client(
        lambda request: httpx.Response(200, json=failed(40, "Wrong username or password"))
    )
    with pytest.raises(NavidromeAuthError) as caught:
        await client.ping()
    assert caught.value.code == 40


@pytest.mark.anyio
async def test_not_found_and_other_errors_are_distinguished():
    not_found = make_client(lambda r: httpx.Response(200, json=failed(70, "Song not found")))
    with pytest.raises(NavidromeNotFound):
        await not_found.ping()

    generic = make_client(lambda r: httpx.Response(200, json=failed(0, "Something broke")))
    with pytest.raises(NavidromeError) as caught:
        await generic.ping()
    assert type(caught.value) is NavidromeError


@pytest.mark.anyio
async def test_unreachable_server_is_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    with pytest.raises(NavidromeUnavailable, match="Cannot reach Navidrome"):
        await make_client(handler).ping()


@pytest.mark.anyio
async def test_non_subsonic_responses_are_unavailable():
    html = make_client(lambda r: httpx.Response(200, text="<html>Bad Gateway</html>"))
    with pytest.raises(NavidromeUnavailable, match="non-Subsonic"):
        await html.ping()

    server_error = make_client(lambda r: httpx.Response(502))
    with pytest.raises(NavidromeUnavailable, match="HTTP 502"):
        await server_error.ping()
