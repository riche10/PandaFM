"""Favorites: Navidrome's starred songs, albums and artists.

Navidrome stays the source of truth, so favorites set in PandaFM show up in
any other Subsonic app, and vice versa.
"""

from fastapi import APIRouter, Response

from app.deps import ItemId, NavidromeDep
from app.schemas.library import FavoriteKind, Favorites

router = APIRouter(tags=["favorites"])


@router.get("/favorites", response_model=Favorites)
async def list_favorites(navidrome: NavidromeDep) -> Favorites:
    return await navidrome.get_favorites()


def _register(kind: FavoriteKind, collection: str) -> None:
    path = f"/{collection}/{{item_id}}/favorite"

    @router.put(path, status_code=204, name=f"favorite_{kind}", summary=f"Favorite a {kind}")
    async def favorite(item_id: ItemId, navidrome: NavidromeDep) -> Response:
        await navidrome.set_favorite(kind, item_id, True)
        return Response(status_code=204)

    @router.delete(path, status_code=204, name=f"unfavorite_{kind}", summary=f"Unfavorite a {kind}")
    async def unfavorite(item_id: ItemId, navidrome: NavidromeDep) -> Response:
        await navidrome.set_favorite(kind, item_id, False)
        return Response(status_code=204)


# PUT /api/tracks/{id}/favorite, DELETE /api/tracks/{id}/favorite, and the same
# for albums and artists. PUT/DELETE are idempotent, so retries are harmless.
_register(FavoriteKind.track, "tracks")
_register(FavoriteKind.album, "albums")
_register(FavoriteKind.artist, "artists")
