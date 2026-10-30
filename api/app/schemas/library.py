"""PandaFM's library vocabulary, as returned by the /api endpoints.

These models describe music in PandaFM terms (snake_case, seconds, plain
genre lists). They are filled from Navidrome by app/navidrome/parse.py and
know nothing about Subsonic. In Stage 2 every id is a Navidrome id.
"""

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints


class AudioQuality(BaseModel):
    codec: str
    lossless: bool | None
    hi_res: bool
    badge: str | None  # "LOSSLESS" | "HI-RES" | None
    detail: str | None  # "24-bit / 96 kHz" or "44.1 kHz"
    short: str | None  # "24/96"
    bitrate_kbps: int | None


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
    favorite: bool = False
    album_artist: str | None = None
    sample_rate: int | None = None
    bit_depth: int | None = None
    channels: int | None = None
    size_bytes: int | None = None
    quality: AudioQuality | None = None


class GenreTag(BaseModel):
    key: str  # canonical genre (links to /genres/{key})
    name: str  # display spelling


class GenreSummary(GenreTag):
    songs: int
    albums: int = 0
    artists: int = 0
    cover_art_ids: list[str] = Field(default_factory=list)


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
    favorite: bool = False
    genre_tags: list[GenreTag] = Field(default_factory=list)  # deduplicated, for chips


class Album(AlbumSummary):
    tracks: list[Track] = Field(default_factory=list)


class ArtistSummary(BaseModel):
    id: str
    name: str
    album_count: int | None = None
    cover_art_id: str | None = None
    favorite: bool = False


class Artist(ArtistSummary):
    albums: list[AlbumSummary] = Field(default_factory=list)
    genres: list[GenreTag] = Field(default_factory=list)  # the artist's dominant genres


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
    # 5.5.2: songs come in pages; there is no reliable total from the music server, so none is invented
    track_offset: int = 0
    track_limit: int | None = None
    tracks_has_more: bool = False
    albums: list[AlbumSummary] = Field(default_factory=list)
    artists: list[ArtistSummary] = Field(default_factory=list)
    genres: list[GenreSummary] = Field(default_factory=list)


class TrackListOrder(StrEnum):
    all = "all"  # Navidrome's library order (not alphabetical)
    random = "random"


class TrackPage(BaseModel):
    order: TrackListOrder
    offset: int
    tracks: list[Track]


class TrackList(BaseModel):
    tracks: list[Track]


# ── Favorites (Navidrome "starred" items) ──


class Favorites(BaseModel):
    tracks: list[Track] = Field(default_factory=list)
    albums: list[AlbumSummary] = Field(default_factory=list)
    artists: list[ArtistSummary] = Field(default_factory=list)


class FavoriteKind(StrEnum):
    track = "track"
    album = "album"
    artist = "artist"


# ── Playlists (stored in Navidrome) ──


class PlaylistSummary(BaseModel):
    id: str
    name: str
    track_count: int = 0
    duration_seconds: int | None = None
    cover_art_id: str | None = None
    owner: str | None = None
    readonly: bool = False


class Playlist(PlaylistSummary):
    # Order matters: a track's index here is its position in the playlist.
    tracks: list[Track] = Field(default_factory=list)


class PlaylistList(BaseModel):
    playlists: list[PlaylistSummary]


PlaylistName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
TrackIds = Annotated[list[Annotated[str, StringConstraints(min_length=1, max_length=200)]], Field(max_length=500)]


class PlaylistCreate(BaseModel):
    name: PlaylistName
    track_ids: TrackIds = Field(default_factory=list)


class PlaylistRename(BaseModel):
    name: PlaylistName


class PlaylistAddTracks(BaseModel):
    track_ids: Annotated[TrackIds, Field(min_length=1)]
