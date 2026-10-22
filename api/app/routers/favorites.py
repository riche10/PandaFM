"""Favorites: Navidrome's starred songs, albums and artists.

Navidrome stays the source of truth, so favorites set in PandaFM show up in
any other Subsonic app, and vice versa.
"""

import logging

from fastapi import APIRouter, Request, Response

from app.deps import ItemId, NavidromeDep
from app.navidrome.client import NavidromeError
from app.schemas.events import TrackSnapshot
from app.schemas.library import FavoriteKind, Favorites
from app.services.events import record_favorite

log = logging.getLogger(__name__)

router = APIRouter(tags=["favorites"])


@router.get("/favorites", response_model=Favorites)
async def list_favorites(navidrome: NavidromeDep) -> Favorites:
    return await navidrome.get_favorites()


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
_register(FavoriteKind.track, "tracks")
_register(FavoriteKind.album, "albums")
_register(FavoriteKind.artist, "artists")
