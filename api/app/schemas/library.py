"""PandaFM's library vocabulary, as returned by the /api endpoints.

These models describe music in PandaFM terms (snake_case, seconds, plain
genre lists). They are filled from Navidrome by app/navidrome/parse.py and
know nothing about Subsonic. In Stage 2 every id is a Navidrome id.
"""

from enum import StrEnum

from pydantic import BaseModel, Field


class Track(BaseModel):
    id: str
    title: str
    artist: str
    artist_id: str | None = None
    album: str | None = None
    album_id: str | None = None
    cover_art_id: str | None = None
    duration_seconds: int | None = None
    track_number: int | None = None
    disc_number: int | None = None
    year: int | None = None
    genres: list[str] = Field(default_factory=list)
    content_type: str | None = None
    suffix: str | None = None
    bitrate_kbps: int | None = None


class AlbumSummary(BaseModel):
    id: str
    name: str
    artist: str
    artist_id: str | None = None
    cover_art_id: str | None = None
    year: int | None = None
    track_count: int | None = None
    duration_seconds: int | None = None
    genres: list[str] = Field(default_factory=list)


class Album(AlbumSummary):
    tracks: list[Track] = Field(default_factory=list)


class ArtistSummary(BaseModel):
    id: str
    name: str
    album_count: int | None = None
    cover_art_id: str | None = None


class Artist(ArtistSummary):
    albums: list[AlbumSummary] = Field(default_factory=list)


class ArtistList(BaseModel):
    artists: list[ArtistSummary]


class AlbumListKind(StrEnum):
    newest = "newest"
    recent = "recent"
    frequent = "frequent"
    random = "random"
    alphabetical = "alphabetical"


class AlbumList(BaseModel):
    kind: AlbumListKind
    offset: int
    albums: list[AlbumSummary]


class SearchResults(BaseModel):
    query: str
    tracks: list[Track] = Field(default_factory=list)
    albums: list[AlbumSummary] = Field(default_factory=list)
    artists: list[ArtistSummary] = Field(default_factory=list)
