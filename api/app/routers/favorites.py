"""Favorites (5.5.2): PandaFM owns song likes (see services/favorites.py); album and artist favorites
still follow the music server's stars."""

import logging

from fastapi import APIRouter, Request, Response

from app.deps import ItemId, NavidromeDep, SessionDep, UserId
from app.services import favorites
from app.navidrome.client import NavidromeError
from app.schemas.events import TrackSnapshot
from app.schemas.library import FavoriteKind, Favorites
from app.services.events import record_favorite

log = logging.getLogger(__name__)

router = APIRouter(tags=["favorites"])


@router.get("/favorites", response_model=Favorites)
async def list_favorites(db: SessionDep, user_id: UserId, navidrome: NavidromeDep) -> Favorites:
    """Liked Songs come from PandaFM (5.5.2): a music server with no stars can't empty them. Album and
    artist favorites still come from the music server; if it doesn't answer, the songs still do."""
    tracks = await favorites.liked_tracks(db, user_id)
    try:
        starred = await navidrome.get_favorites()
        albums, artists = starred.albums, starred.artists
    except NavidromeError as exc:
        log.warning("Album/artist favorites unavailable (%s); Liked Songs come from PandaFM", type(exc).__name__)
        albums, artists = [], []
    return Favorites(tracks=tracks, albums=albums, artists=artists)


@router.put("/tracks/{item_id}/favorite", status_code=204, name="favorite_track", summary="Like a song")
async def favorite_track(item_id: ItemId, db: SessionDep, user_id: UserId, navidrome: NavidromeDep) -> Response:
    await favorites.set_track_like(db, user_id, navidrome, item_id, True)
    return Response(status_code=204)


@router.delete("/tracks/{item_id}/favorite", status_code=204, name="unfavorite_track", summary="Unlike a song")
async def unfavorite_track(item_id: ItemId, db: SessionDep, user_id: UserId, navidrome: NavidromeDep) -> Response:
    await favorites.set_track_like(db, user_id, navidrome, item_id, False)
    return Response(status_code=204)


def _register(kind: FavoriteKind, collection: str) -> None:
    path = f"/{collection}/{{item_id}}/favorite"

    @router.put(path, status_code=204, name=f"favorite_{kind}", summary=f"Favorite a {kind}")
    async def favorite(item_id: ItemId, navidrome: NavidromeDep, request: Request) -> Response:
        await navidrome.set_favorite(kind, item_id, True)
        await _remember(kind, item_id, True, navidrome, request)
        return Response(status_code=204)

    @router.delete(path, status_code=204, name=f"unfavorite_{kind}", summary=f"Unfavorite a {kind}")
    async def unfavorite(item_id: ItemId, navidrome: NavidromeDep, request: Request) -> Response:
        await navidrome.set_favorite(kind, item_id, False)
        await _remember(kind, item_id, False, navidrome, request)
        return Response(status_code=204)


async def _remember(kind: FavoriteKind, item_id: str, favorite: bool, navidrome, request: Request) -> None:
    """Navidrome has the favorite now; also record it as a listening signal for radio.

    Best effort: a database problem must never break favoriting itself.
    """
    if kind is not FavoriteKind.track:
        return
    try:
        t = await navidrome.get_track(item_id)
        snapshot = TrackSnapshot(
            id=t.id, title=t.title, artist=t.artist, artist_id=t.artist_id, album=t.album, album_id=t.album_id,
            genres=t.genres, year=t.year, duration_seconds=t.duration_seconds, cover_art_id=t.cover_art_id,
        )
        from app.main import _default_user_id  # resolved here so a database outage can't block favoriting

        user_id = await _default_user_id(request.app)
        async with request.app.state.session_factory() as db:
            await record_favorite(db, user_id, snapshot, favorite)
    except (NavidromeError, OSError, RuntimeError) as exc:
        log.warning("Couldn't record the favorite as a listening signal: %s", exc)
    except Exception:  # noqa: BLE001 - never fail the user's favorite over bookkeeping
        log.exception("Couldn't record the favorite as a listening signal")


# PUT /api/tracks/{id}/favorite, DELETE /api/tracks/{id}/favorite, and the same
# for albums and artists. PUT/DELETE are idempotent, so retries are harmless.
_register(FavoriteKind.album, "albums")
_register(FavoriteKind.artist, "artists")
