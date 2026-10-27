"""A tiny fake Subsonic/Navidrome server for the music-server tests (an httpx transport)."""

import hashlib

import httpx

USER, PASSWORD = "omari", "navi-pass 42"


def transport(mode: str = "ok") -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        if mode == "unreachable":
            raise httpx.ConnectError("connection refused", request=request)
        if mode == "html":
            return httpx.Response(200, text="<html><body>Hello</body></html>", headers={"content-type": "text/html"})
        if mode == "404":
            return httpx.Response(404, text="not found")
        q = request.url.params
        if "u" not in q:  # an unauthenticated probe: a real Subsonic server answers with an error envelope
            return httpx.Response(200, json={"subsonic-response": {"status": "failed", "version": "1.16.1", "error": {"code": 10, "message": "Required parameter is missing"}}})
        ok = q.get("u") == USER and q.get("t") == hashlib.md5((PASSWORD + q.get("s", "")).encode()).hexdigest()
        if not ok:
            return httpx.Response(200, json={"subsonic-response": {"status": "failed", "version": "1.16.1", "error": {"code": 40, "message": "Wrong username or password"}}})
        body = {"status": "ok", "version": "1.16.1", "type": "navidrome", "serverVersion": "0.58.0", "openSubsonic": True}
        if request.url.path.endswith("/getMusicFolders"):
            body["musicFolders"] = {"musicFolder": [{"id": 1, "name": "Music"}]}
        return httpx.Response(200, json={"subsonic-response": body})

    return httpx.MockTransport(handle)
