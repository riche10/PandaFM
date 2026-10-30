"""Library browsing and search, wrapped from Navidrome.

Thin on purpose: validate input, call one NavidromeClient method, return a
PandaFM model. Navidrome failures are turned into HTTP errors by
app.errors, so no route needs its own try/except.
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import SessionDep, ItemId, NavidromeDep, UserId
from app.services.favorites import with_likes
from app.services import explore
from app.schemas.library import (
    Album,
    AlbumList,
    AlbumListKind,
    Artist,
    ArtistList,
    SearchResults,
    Track,
    TrackList,
    TrackListOrder,
    TrackPage,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["library"])


@router.get("/search", response_model=SearchResults)
async def search(
    navidrome: NavidromeDep,
    db: SessionDep,
    user_id: UserId,
    q: Annotated[str, Query(max_length=200, description="Words to search for")] = "",
    limit: Annotated[int, Query(ge=1, le=100, description="Songs per page")] = 20,
    offset: Annotated[int, Query(ge=0, le=100_000, description="Songs to skip (the next page)")] = 0,
) -> SearchResults:
    query = q.strip()
    if not query:
        # Navidrome treats an empty query as "everything". PandaFM treats it as nothing.
        return SearchResults(query="")
    # 5.5.2: songs page (limit/offset); one extra song tells exactly whether another page exists. Artists,
    # albums and genres come with the first page only.
    first = offset == 0
    results = await navidrome.search(query, track_count=limit + 1, track_offset=offset,
                                     **({} if first else {"album_count": 0, "artist_count": 0}))
    results.tracks_has_more = len(results.tracks) > limit
    results.tracks = results.tracks[:limit]
    results.track_offset, results.track_limit = offset, limit
    if first:
        try:  # "pop punk" finds the genre too; search itself never depends on the cache
            results.genres = [explore.summary(g) for g in await explore.find_genres(db, query)]
        except Exception:  # noqa: BLE001
            log.warning("Genre search unavailable (database)", exc_info=True)
    return await with_likes(db, user_id, results)


@router.get("/albums", response_model=AlbumList)
async def list_albums(
    navidrome: NavidromeDep,
    kind: Annotated[AlbumListKind, Query(alias="list")] = AlbumListKind.newest,
    size: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> AlbumList:
    albums = await navidrome.get_album_list(kind, size=size, offset=offset)
    return AlbumList(kind=kind, offset=offset, albums=albums)


@router.get("/albums/{album_id}", response_model=Album)
async def get_album(album_id: ItemId, navidrome: NavidromeDep, db: SessionDep, user_id: UserId) -> Album:
    return await with_likes(db, user_id, await navidrome.get_album(album_id))


@router.get("/artists", response_model=ArtistList)
async def list_artists(navidrome: NavidromeDep) -> ArtistList:
    return ArtistList(artists=await navidrome.get_artists())


@router.get("/artists/{artist_id}/tracks", response_model=TrackList)
async def get_artist_tracks(artist_id: ItemId, navidrome: NavidromeDep, db: SessionDep, user_id: UserId) -> TrackList:
    return await with_likes(db, user_id, TrackList(tracks=await navidrome.get_artist_tracks(artist_id)))


@router.get("/artists/{artist_id}", response_model=Artist)
async def get_artist(artist_id: ItemId, navidrome: NavidromeDep, db: SessionDep, user_id: UserId) -> Artist:
    artist = await navidrome.get_artist(artist_id)
    try:  # dominant genres, from the synced cache; the page works without them
        artist.genres = await explore.artist_genres(db, artist_id)
    except Exception:  # noqa: BLE001
        log.warning("Artist genres unavailable (database)", exc_info=True)
    return await with_likes(db, user_id, artist)


@router.get("/tracks", response_model=TrackPage)
async def list_tracks(
    navidrome: NavidromeDep,
    db: SessionDep,
    user_id: UserId,
    order: TrackListOrder = TrackListOrder.all,
    size: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
) -> TrackPage:
    tracks = await navidrome.list_tracks(order, size=size, offset=offset)
    return await with_likes(db, user_id, TrackPage(order=order, offset=offset, tracks=tracks))


@router.get("/tracks/{track_id}", response_model=Track)
async def get_track(track_id: ItemId, navidrome: NavidromeDep, db: SessionDep, user_id: UserId) -> Track:
    return await with_likes(db, user_id, await navidrome.get_track(track_id))
