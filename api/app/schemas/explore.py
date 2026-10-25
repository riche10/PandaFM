"""Library explorer responses: genres, decades, browsing, related albums, smart collections."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.library import AlbumSummary, GenreSummary, Track


class TopGenres(BaseModel):
    source: Literal["history", "library"]  # your listening, or (no history yet) what your library holds most
    genres: list[GenreSummary]


class ArtistInGenre(BaseModel):
    id: str
    name: str
    songs: int
    cover_art_id: str | None = None


class GenreDetail(BaseModel):
    genre: GenreSummary
    artists: list[ArtistInGenre]
    related: list[GenreSummary]  # close genres in your library (same family)


class DecadeSummary(BaseModel):
    decade: int
    label: str
    albums: int
    songs: int


class AlbumPage(BaseModel):
    albums: list[AlbumSummary]
    offset: int
    total: int


class BrowseTrackPage(BaseModel):
    tracks: list[Track]
    offset: int
    total: int


class RelatedAlbum(BaseModel):
    album: AlbumSummary
    reason: str
    score: float


class SmartCollection(BaseModel):
    id: str
    name: str
    description: str
    count: int | None = None
    link: str | None = None  # an existing page that already shows it (Favorites, Recently added)
