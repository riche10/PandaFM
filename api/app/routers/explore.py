"""Explore your own library: genres, decades, smart collections, related albums.

Everything here is derived from your Navidrome library and PandaFM's own
listening history; nothing is fetched from outside services.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query

from app.deps import ItemId, NavidromeDep, SessionDep, UserId
from app.errors import error_response
from app.schemas.explore import (
    AlbumPage, ArtistInGenre, BrowseTrackPage, DecadeSummary, GenreDetail, RelatedAlbum, SmartCollection, TopGenres,
)
from app.schemas.library import GenreSummary
from app.services import explore

router = APIRouter(tags=["explore"])
GenreKey = Annotated[str, Path(min_length=1, max_length=120)]
Decade = Annotated[int | None, Query(ge=1000, le=2990, multiple_of=10)]

COLLECTIONS = {
    "unplayed": ("Unplayed", "Songs with no PandaFM play history yet"),
    "lossless": ("Lossless", "Songs PandaFM knows are lossless (FLAC, ALAC, WAV…)"),
    "hires": ("Hi-Res", "Lossless songs above 16-bit or 48 kHz"),
    "rediscover": ("Rediscover", "Songs you used to finish and haven’t heard in a while"),
}


@router.get("/genres", response_model=list[GenreSummary])
async def list_genres(db: SessionDep, sort: Literal["songs", "name"] = "songs") -> list[GenreSummary]:
    genres = list((await explore.index(db)).values())
    genres.sort(key=(lambda g: (-g.songs, g.name.lower())) if sort == "songs" else (lambda g: g.name.lower()))
    return [explore.summary(g) for g in genres]


@router.get("/genres/top", response_model=TopGenres)
async def top_genres(db: SessionDep, user_id: UserId, limit: Annotated[int, Query(ge=1, le=24)] = 8) -> TopGenres:
    source, genres = await explore.top_genres(db, user_id, limit)
    return TopGenres(source=source, genres=[explore.summary(g) for g in genres])


@router.get("/genres/{key}", response_model=GenreDetail)
async def genre(key: GenreKey, db: SessionDep):
    found = await explore.genre_detail(db, key)
    if found is None:
        return error_response(404, "genre_not_found", "There’s no music with that genre in your library.")
    g, artists, related = found
    return GenreDetail(genre=explore.summary(g), tags=sorted(g.raws), artists=[ArtistInGenre(**a) for a in artists], related=[explore.summary(o) for o in related])


@router.get("/browse/albums", response_model=AlbumPage)
async def browse_albums(db: SessionDep, user_id: UserId, navidrome: NavidromeDep, genre: str | None = None, decade: Decade = None,
                        favorites: bool = False, order: Literal["name", "year", "artist", "random"] = "name",
                        offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=100)] = 40) -> AlbumPage:
    favorite_albums = [a.id for a in (await navidrome.get_favorites()).albums] if favorites else None
    albums, total = await explore.browse_albums(db, user_id, genre=genre, decade=decade, favorite_albums=favorite_albums, order=order, offset=offset, limit=limit)
    return AlbumPage(albums=albums, offset=offset, total=total)


@router.get("/browse/tracks", response_model=BrowseTrackPage)
async def browse_tracks(db: SessionDep, user_id: UserId, genre: str | None = None, decade: Decade = None, favorites: bool = False,
                        lossless: bool = False, hires: bool = False, unplayed: bool = False,
                        order: Literal["artist", "title", "recent", "random"] = "artist",
                        offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 50) -> BrowseTrackPage:
    tracks, total = await explore.browse_tracks(db, user_id, genre=genre, decade=decade, favorites=favorites, lossless=lossless, hires=hires,
                                                unplayed=unplayed, order=order, offset=offset, limit=limit)
    return BrowseTrackPage(tracks=tracks, offset=offset, total=total)


@router.get("/library/decades", response_model=list[DecadeSummary])
async def decades(db: SessionDep) -> list[DecadeSummary]:
    return [DecadeSummary(**d) for d in await explore.decades(db)]


@router.get("/albums/{album_id}/related", response_model=list[RelatedAlbum])
async def related_albums(album_id: ItemId, db: SessionDep, user_id: UserId, limit: Annotated[int, Query(ge=1, le=30)] = 12) -> list[RelatedAlbum]:
    return [RelatedAlbum(album=a, score=s, reason=r) for a, s, r in await explore.related(db, user_id, album_id, limit)]


@router.get("/collections", response_model=list[SmartCollection])
async def collections(db: SessionDep, user_id: UserId) -> list[SmartCollection]:
    counts = await explore.collection_counts(db, user_id)
    return [
        SmartCollection(id="recent", name="Recently Added", description="The newest albums in your library", link="/library/albums?sort=newest"),
        SmartCollection(id="unplayed", name=COLLECTIONS["unplayed"][0], description=COLLECTIONS["unplayed"][1], count=counts["unplayed"]),
        SmartCollection(id="favorites", name="Favorites", description="Songs, albums and artists you starred", link="/favorites"),
        SmartCollection(id="rediscover", name=COLLECTIONS["rediscover"][0], description=COLLECTIONS["rediscover"][1]),
        SmartCollection(id="lossless", name=COLLECTIONS["lossless"][0], description=COLLECTIONS["lossless"][1], count=counts["lossless"]),
        SmartCollection(id="hires", name=COLLECTIONS["hires"][0], description=COLLECTIONS["hires"][1], count=counts["hires"]),
    ]


@router.get("/collections/{collection_id}/tracks", response_model=BrowseTrackPage)
async def collection_tracks(collection_id: Annotated[str, Path(pattern="^(unplayed|lossless|hires|rediscover)$")], db: SessionDep, user_id: UserId,
                            order: Literal["artist", "title", "recent", "random"] = "artist",
                            offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 50) -> BrowseTrackPage:
    if collection_id == "rediscover":
        tracks = await explore.rediscover(db, user_id, limit)
        return BrowseTrackPage(tracks=tracks, offset=0, total=len(tracks))
    tracks, total = await explore.browse_tracks(db, user_id, unplayed=collection_id == "unplayed", lossless=collection_id == "lossless",
                                                hires=collection_id == "hires", order=order, offset=offset, limit=limit)
    return BrowseTrackPage(tracks=tracks, offset=offset, total=total)
