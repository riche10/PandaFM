"""Library browsing and search, wrapped from Navidrome.

Thin on purpose: validate input, call one NavidromeClient method, return a
PandaFM model. Navidrome failures are turned into HTTP errors by
app.errors, so no route needs its own try/except.
"""

from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import ItemId, NavidromeDep
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

router = APIRouter(tags=["library"])


@router.get("/search", response_model=SearchResults)
async def search(
    navidrome: NavidromeDep,
    q: Annotated[str, Query(max_length=200, description="Words to search for")] = "",
    limit: Annotated[int, Query(ge=1, le=50, description="Maximum songs to return")] = 20,
) -> SearchResults:
    query = q.strip()
    if not query:
        # Navidrome treats an empty query as "everything". PandaFM treats it as nothing.
        return SearchResults(query="")
    return await navidrome.search(query, track_count=limit)


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
async def get_album(album_id: ItemId, navidrome: NavidromeDep) -> Album:
    return await navidrome.get_album(album_id)


@router.get("/artists", response_model=ArtistList)
async def list_artists(navidrome: NavidromeDep) -> ArtistList:
    return ArtistList(artists=await navidrome.get_artists())


@router.get("/artists/{artist_id}/tracks", response_model=TrackList)
async def get_artist_tracks(artist_id: ItemId, navidrome: NavidromeDep) -> TrackList:
    return TrackList(tracks=await navidrome.get_artist_tracks(artist_id))


@router.get("/artists/{artist_id}", response_model=Artist)
async def get_artist(artist_id: ItemId, navidrome: NavidromeDep) -> Artist:
    return await navidrome.get_artist(artist_id)


@router.get("/tracks", response_model=TrackPage)
async def list_tracks(
    navidrome: NavidromeDep,
    order: TrackListOrder = TrackListOrder.all,
    size: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
) -> TrackPage:
    tracks = await navidrome.list_tracks(order, size=size, offset=offset)
    return TrackPage(order=order, offset=offset, tracks=tracks)


@router.get("/tracks/{track_id}", response_model=Track)
async def get_track(track_id: ItemId, navidrome: NavidromeDep) -> Track:
    return await navidrome.get_track(track_id)
