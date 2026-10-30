"""Client for Navidrome's Subsonic / OpenSubsonic API.

This is the only module in PandaFM that knows Subsonic wire details: the
salted-token authentication, the JSON envelope and the error codes. JSON
bodies are turned into PandaFM models by parse.py. The rest of the
application calls typed methods on NavidromeClient and catches the
exceptions defined here.

Navidrome credentials never leave this module: requests to Navidrome carry
the token, but nothing returned to PandaFM's callers does.
"""

from __future__ import annotations

import asyncio
import hashlib
import secrets
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, TypeVar

import httpx

from app import __version__
from app.navidrome import parse
from app.schemas.library import (
    Album,
    AlbumListKind,
    AlbumSummary,
    Artist,
    ArtistSummary,
    FavoriteKind,
    Favorites,
    Playlist,
    PlaylistSummary,
    SearchResults,
    Track,
    TrackListOrder,
)

SUBSONIC_API_VERSION = "1.16.1"
CLIENT_NAME = "pandafm"

# Subsonic error codes meaning the credentials or the auth method are wrong.
_AUTH_ERROR_CODES = frozenset({40, 41, 42, 43, 44})
_NOT_AUTHORIZED_CODE = 50
_NOT_FOUND_CODE = 70

# star/unstar take a differently named id parameter per kind.
_FAVORITE_PARAMS = {
    FavoriteKind.track: "id",
    FavoriteKind.album: "albumId",
    FavoriteKind.artist: "artistId",
}

# An artist page's song list is built from this many albums at most.
ARTIST_TRACKS_MAX_ALBUMS = 20

_ALBUM_LIST_TYPES = {
    AlbumListKind.newest: "newest",
    AlbumListKind.recent: "recent",
    AlbumListKind.frequent: "frequent",
    AlbumListKind.random: "random",
    AlbumListKind.alphabetical: "alphabeticalByName",
}

# Upstream audio headers worth passing to the browser. Everything else is
# dropped, including the nd-player cookie Navidrome sets on every stream.
_STREAM_HEADERS = (
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
    "x-content-duration",
)

MAX_COVER_BYTES = 20 * 1024 * 1024

T = TypeVar("T")


class NavidromeError(Exception):
    """Navidrome answered with a Subsonic error (base class for all errors here)."""

    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.code = code


class NavidromeUnavailable(NavidromeError):
    """Navidrome could not be reached, timed out, or did not answer like a Subsonic server."""


class NavidromeSlow(NavidromeUnavailable):
    """5.4.2: Navidrome didn't start an audio stream within the stream timeout (e.g. sleeping NAS disks)."""


class NavidromeAuthError(NavidromeError):
    """Navidrome rejected PandaFM's username/password."""


class NavidromeNotFound(NavidromeError):
    """The requested song, album, artist, playlist or artwork does not exist in Navidrome."""


class NavidromeForbidden(NavidromeError):
    """Navidrome refused the change (e.g. a read-only or someone else's playlist)."""


class PlaylistChanged(NavidromeError):
    """The playlist no longer has the expected song at the given position."""


@dataclass(frozen=True, slots=True)
class ServerInfo:
    api_version: str
    server_type: str | None
    server_version: str | None
    open_subsonic: bool


@dataclass(frozen=True, slots=True)
class ScanStatus:
    scanning: bool
    last_scan: datetime | None
    count: int | None


@dataclass(frozen=True, slots=True)
class CoverArt:
    content: bytes
    content_type: str
    etag: str | None


class AudioStream:
    """An open audio response from Navidrome, read incrementally.

    The caller must call aclose() when done (the API's stream response does
    this in a finally block), whether the song finished or the browser went
    away mid-stream.
    """

    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self.status_code = response.status_code
        self.headers = {
            name: response.headers[name] for name in _STREAM_HEADERS if name in response.headers
        }

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        try:
            # Raw bytes, forwarded as they arrive from the network and exactly
            # as Navidrome sent them, so Content-Length and Content-Range stay
            # true (we asked for no compression).
            async for chunk in self._response.aiter_raw():
                yield chunk
        finally:
            await self.aclose()

    async def aclose(self) -> None:
        await self._response.aclose()  # safe to call more than once


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
        stream_timeout: float | None = None,
    ) -> None:
        self._username = username
        self._password = password
        self._timeout = timeout
        self._stream_timeout = stream_timeout if stream_timeout is not None else max(timeout, 30.0)
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/rest/",
            timeout=timeout,
            transport=transport,  # tests inject httpx.MockTransport here
            headers={"User-Agent": f"PandaFM/{__version__}"},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    # ── Server ────────────────────────────────────────────────────────

    async def ping(self) -> ServerInfo:
        """Check connectivity and credentials in one call."""
        body = await self._call("ping")
        return ServerInfo(
            api_version=str(body.get("version", "unknown")),
            server_type=body.get("type"),
            server_version=body.get("serverVersion"),
            open_subsonic=bool(body.get("openSubsonic", False)),
        )

    async def get_scan_status(self) -> ScanStatus:
        """getScanStatus: whether Navidrome is scanning and when it last finished."""
        body = await self._call("getScanStatus")
        status = body.get("scanStatus") or {}
        last = status.get("lastScan")
        try:
            last_scan = datetime.fromisoformat(last) if isinstance(last, str) and last else None
        except ValueError:
            last_scan = None
        return ScanStatus(bool(status.get("scanning")), last_scan, status.get("count"))

    async def scrobble(self, track_id: str, played_at: datetime) -> None:
        """scrobble (submission): record a real listen in Navidrome's play history."""
        await self._call("scrobble", id=track_id, time=int(played_at.timestamp() * 1000), submission="true")

    # ── Library (JSON endpoints) ──────────────────────────────────────

    async def search(
        self, query: str, *, track_count: int = 20, album_count: int = 8, artist_count: int = 8, track_offset: int = 0
    ) -> SearchResults:
        """search3. Never call with an empty query: Navidrome returns everything. 5.5.2: songs page with
        songOffset, so every match is reachable."""
        body = await self._call(
            "search3",
            query=query,
            songCount=track_count,
            songOffset=track_offset,
            albumCount=album_count,
            artistCount=artist_count,
        )
        return _parsed(lambda: parse.search_results(query, body))

    async def get_track(self, track_id: str) -> Track:
        """getSong."""
        body = await self._call("getSong", id=track_id)
        return _parsed(lambda: parse.track(body["song"]))

    async def get_album(self, album_id: str) -> Album:
        """getAlbum (ID3), including its tracks."""
        body = await self._call("getAlbum", id=album_id)
        return _parsed(lambda: parse.album(body["album"]))

    async def get_artist(self, artist_id: str) -> Artist:
        """getArtist (ID3), including its albums."""
        body = await self._call("getArtist", id=artist_id)
        return _parsed(lambda: parse.artist(body["artist"]))

    async def get_artists(self) -> list[ArtistSummary]:
        """getArtists, flattened from Navidrome's A–Z groups."""
        body = await self._call("getArtists")
        return _parsed(lambda: parse.artist_index(body))

    async def get_album_list(
        self, kind: AlbumListKind, *, size: int = 30, offset: int = 0
    ) -> list[AlbumSummary]:
        """getAlbumList2."""
        body = await self._call(
            "getAlbumList2", type=_ALBUM_LIST_TYPES[kind], size=size, offset=offset
        )
        return _parsed(
            lambda: [
                parse.album_summary(item)
                for item in (body.get("albumList2") or {}).get("album") or []
            ]
        )

    async def list_tracks(
        self, order: TrackListOrder, *, size: int = 50, offset: int = 0
    ) -> list[Track]:
        """Every song, a page at a time (search3 with an empty query), or getRandomSongs."""
        if order is TrackListOrder.random:
            body = await self._call("getRandomSongs", size=size)
            return _parsed(
                lambda: [parse.track(item) for item in (body.get("randomSongs") or {}).get("song") or []]
            )
        # Navidrome documents empty-query search3 as "return everything";
        # it is how Subsonic clients page through a whole library.
        body = await self._call(
            "search3", query="", songCount=size, songOffset=offset, albumCount=0, artistCount=0
        )
        return _parsed(lambda: parse.search_results("", body).tracks)

    async def get_artist_tracks(self, artist_id: str) -> list[Track]:
        """Songs on an artist's albums (Subsonic has no direct "songs by artist" call)."""
        artist = await self.get_artist(artist_id)
        limit = asyncio.Semaphore(4)  # be gentle with Navidrome

        async def album_tracks(album_id: str) -> list[Track]:
            async with limit:
                return (await self.get_album(album_id)).tracks

        albums = artist.albums[:ARTIST_TRACKS_MAX_ALBUMS]
        per_album = await asyncio.gather(*(album_tracks(album.id) for album in albums))
        return [track for tracks in per_album for track in tracks]

    # ── Favorites (Navidrome's starred items) ─────────────────────────

    async def get_favorites(self) -> Favorites:
        """getStarred2."""
        body = await self._call("getStarred2")
        return _parsed(lambda: parse.favorites(body))

    async def set_favorite(self, kind: FavoriteKind, item_id: str, favorite: bool) -> None:
        """star / unstar."""
        await self._call("star" if favorite else "unstar", **{_FAVORITE_PARAMS[kind]: item_id})

    # ── Playlists ─────────────────────────────────────────────────────

    async def get_playlists(self) -> list[PlaylistSummary]:
        """getPlaylists."""
        body = await self._call("getPlaylists")
        return _parsed(lambda: parse.playlist_list(body))

    async def get_playlist(self, playlist_id: str) -> Playlist:
        """getPlaylist, with its songs in order."""
        body = await self._call("getPlaylist", id=playlist_id)
        return _parsed(lambda: parse.playlist(body["playlist"]))

    async def create_playlist(self, name: str, track_ids: list[str]) -> Playlist:
        """createPlaylist (Navidrome returns the new playlist)."""
        body = await self._call("createPlaylist", name=name, songId=track_ids or None)
        return _parsed(lambda: parse.playlist(body["playlist"]))

    async def rename_playlist(self, playlist_id: str, name: str) -> None:
        """updatePlaylist name=."""
        await self._call("updatePlaylist", playlistId=playlist_id, name=name)

    async def add_to_playlist(self, playlist_id: str, track_ids: list[str]) -> None:
        """updatePlaylist songIdToAdd=, appended in order."""
        await self._call("updatePlaylist", playlistId=playlist_id, songIdToAdd=track_ids)

    async def remove_from_playlist(self, playlist_id: str, index: int, expected_track_id: str) -> None:
        """updatePlaylist songIndexToRemove=, after checking the position still holds that song.

        Subsonic removes by position only, and Navidrome silently ignores an
        out-of-range one. If the playlist changed elsewhere since the caller
        loaded it, removing blindly could delete the wrong song.
        """
        current = await self.get_playlist(playlist_id)
        if index >= len(current.tracks) or current.tracks[index].id != expected_track_id:
            raise PlaylistChanged("The playlist changed since it was loaded")
        await self._call("updatePlaylist", playlistId=playlist_id, songIndexToRemove=index)

    async def delete_playlist(self, playlist_id: str) -> None:
        """deletePlaylist."""
        await self._call("deletePlaylist", id=playlist_id)

    # ── Media (binary endpoints) ──────────────────────────────────────

    async def get_cover_art(self, cover_art_id: str, *, size: int | None = None) -> CoverArt:
        """getCoverArt. Artwork is small, so it is read fully before returning."""
        response = await self._get("getCoverArt", {"id": cover_art_id, "size": size})
        content_type = response.headers.get("content-type", "")
        if response.status_code == 200 and content_type.startswith("image/"):
            if len(response.content) > MAX_COVER_BYTES:
                raise NavidromeUnavailable("Navidrome returned unexpectedly large artwork")
            return CoverArt(
                content=response.content,
                content_type=content_type,
                etag=response.headers.get("etag"),
            )
        # Missing artwork arrives as HTTP 200 with a JSON error envelope.
        self._envelope(response, "getCoverArt")
        raise NavidromeUnavailable("Navidrome returned artwork that isn't an image")

    async def open_stream(
        self, track_id: str, *, range_header: str | None = None, if_range: str | None = None
    ) -> AudioStream:
        """stream, opened incrementally with the browser's Range headers forwarded.

        Asks for the original file (format=raw) so byte ranges, and therefore
        seeking, always work. Returns 200, 206 or 416 responses as-is; anything
        else becomes one of this module's exceptions.
        """
        headers = {"Accept-Encoding": "identity"}
        if range_header:
            headers["Range"] = range_header
        if if_range:
            headers["If-Range"] = if_range

        response = await self._get(
            "stream", {"id": track_id, "format": "raw"}, headers=headers, stream=True,
            read_timeout=self._stream_timeout,  # 5.4.2: sleeping disks may need tens of seconds to open a file
        )
        content_type = response.headers.get("content-type", "")
        is_envelope = "json" in content_type or "xml" in content_type

        if response.status_code == 416 or (
            response.status_code in (200, 206) and not is_envelope
        ):
            return AudioStream(response)

        # Errors (e.g. a missing song) arrive as a small JSON envelope.
        try:
            await response.aread()
        finally:
            await response.aclose()
        self._envelope(response, "stream")
        raise NavidromeUnavailable("Navidrome returned an unexpected response for the audio stream")

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
        response = await self._get(endpoint, params)
        return self._envelope(response, endpoint)

    async def _get(
        self,
        endpoint: str,
        params: dict[str, Any],
        *,
        headers: dict[str, str] | None = None,
        stream: bool = False,
        read_timeout: float | None = None,
    ) -> httpx.Response:
        query = self._auth_params() | {"f": "json"}
        query |= {key: value for key, value in params.items() if value is not None}
        timeout = None if read_timeout is None else httpx.Timeout(self._timeout, read=read_timeout)
        request = self._http.build_request("GET", endpoint, params=query, headers=headers, **({"timeout": timeout} if timeout else {}))
        try:
            return await self._http.send(request, stream=stream)
        except httpx.TimeoutException as exc:
            if read_timeout is not None and isinstance(exc, httpx.ReadTimeout):
                raise NavidromeSlow(f"Navidrome didn't start the audio within {read_timeout:g}s") from exc
            raise NavidromeUnavailable(
                f"Navidrome did not answer within {self._timeout:g}s"
            ) from exc
        except httpx.HTTPError as exc:
            # Deliberately not including the request URL: it carries the token.
            raise NavidromeUnavailable(
                f"Cannot reach Navidrome ({type(exc).__name__}: {exc})"
            ) from exc

    def _envelope(self, response: httpx.Response, endpoint: str) -> dict[str, Any]:
        """Unwrap a Subsonic JSON response, raising the matching exception on errors."""
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
        if code == _NOT_AUTHORIZED_CODE:
            raise NavidromeForbidden(message, code)
        raise NavidromeError(message, code)


def _parsed(build: Callable[[], T]) -> T:
    """Run a parse step; a response missing required fields is a server problem."""
    try:
        return build()
    except (KeyError, TypeError, ValueError) as exc:  # pydantic errors are ValueErrors
        raise NavidromeUnavailable("Navidrome sent a response PandaFM couldn't read") from exc
