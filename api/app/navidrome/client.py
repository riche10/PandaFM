"""Client for Navidrome's Subsonic / OpenSubsonic API.

This is the only module in PandaFM that knows Subsonic wire details: the
salted-token authentication, the JSON envelope and the error codes. The
rest of the application calls typed methods on NavidromeClient and catches
the exceptions defined here.

Stage 1 implements the transport and ping(). Stage 2 adds the library
calls (search, albums, artists, songs, streaming, cover art).
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from typing import Any

import httpx

from app import __version__

SUBSONIC_API_VERSION = "1.16.1"
CLIENT_NAME = "pandafm"

# Subsonic error codes meaning the credentials or the auth method are wrong.
_AUTH_ERROR_CODES = frozenset({40, 41, 42, 43, 44})
_NOT_FOUND_CODE = 70


class NavidromeError(Exception):
    """Navidrome answered with a Subsonic error (base class for all errors here)."""

    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.code = code


class NavidromeUnavailable(NavidromeError):
    """Navidrome could not be reached, timed out, or did not answer like a Subsonic server."""


class NavidromeAuthError(NavidromeError):
    """Navidrome rejected PandaFM's username/password."""


class NavidromeNotFound(NavidromeError):
    """The requested song, album or artist does not exist in Navidrome."""


@dataclass(frozen=True, slots=True)
class ServerInfo:
    api_version: str
    server_type: str | None
    server_version: str | None
    open_subsonic: bool


class NavidromeClient:
    """One long-lived instance per API process (created in app.main)."""

    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        *,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._username = username
        self._password = password
        self._timeout = timeout
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/rest/",
            timeout=timeout,
            transport=transport,  # tests inject httpx.MockTransport here
            headers={"User-Agent": f"PandaFM/{__version__}"},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    # ── Public API ────────────────────────────────────────────────────

    async def ping(self) -> ServerInfo:
        """Check connectivity and credentials in one call."""
        body = await self._call("ping")
        return ServerInfo(
            api_version=str(body.get("version", "unknown")),
            server_type=body.get("type"),
            server_version=body.get("serverVersion"),
            open_subsonic=bool(body.get("openSubsonic", False)),
        )

    # ── Transport ─────────────────────────────────────────────────────

    def _auth_params(self) -> dict[str, str]:
        """Fresh credentials for a single request.

        Subsonic token auth sends t = md5(password + salt) with a new random
        salt each time, so the password itself never travels over the wire.
        """
        salt = secrets.token_hex(8)
        token = hashlib.md5(
            (self._password + salt).encode("utf-8"), usedforsecurity=False
        ).hexdigest()
        return {
            "u": self._username,
            "t": token,
            "s": salt,
            "v": SUBSONIC_API_VERSION,
            "c": CLIENT_NAME,
        }

    async def _call(self, endpoint: str, **params: Any) -> dict[str, Any]:
        """GET /rest/<endpoint> and return the unwrapped subsonic-response body."""
        query = self._auth_params() | {"f": "json"}
        query |= {key: value for key, value in params.items() if value is not None}

        try:
            response = await self._http.get(endpoint, params=query)
        except httpx.TimeoutException as exc:
            raise NavidromeUnavailable(
                f"Navidrome did not answer within {self._timeout:g}s"
            ) from exc
        except httpx.HTTPError as exc:
            # Deliberately not including the request URL: it carries the token.
            raise NavidromeUnavailable(
                f"Cannot reach Navidrome ({type(exc).__name__}: {exc})"
            ) from exc

        if response.status_code != 200:
            raise NavidromeUnavailable(
                f"Navidrome returned HTTP {response.status_code} for {endpoint}"
            )

        try:
            body = response.json()["subsonic-response"]
        except (ValueError, KeyError, TypeError) as exc:
            raise NavidromeUnavailable(
                f"Navidrome sent a non-Subsonic response for {endpoint}"
            ) from exc

        # Subsonic reports errors inside an HTTP 200 response.
        if body.get("status") == "ok":
            return body

        error = body.get("error") or {}
        code = error.get("code")
        message = error.get("message") or "Unknown Navidrome error"
        if code in _AUTH_ERROR_CODES:
            raise NavidromeAuthError(message, code)
        if code == _NOT_FOUND_CODE:
            raise NavidromeNotFound(message, code)
        raise NavidromeError(message, code)
