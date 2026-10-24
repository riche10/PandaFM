"""Turn Subsonic / OpenSubsonic JSON into PandaFM library models.

Only this module and client.py know Subsonic field names. Parsing is
lenient: tag quality across a real library varies wildly, so a missing or
odd optional field becomes None instead of an error. A missing id, however,
is a broken response and raises (KeyError), which the client reports as
NavidromeUnavailable.

Some Navidrome fields are deliberately ignored. In particular
`artistImageUrl` is a direct Navidrome URL carrying its own access token;
artist pictures go through PandaFM's cover proxy using `coverArt` instead.
"""

from typing import Any

from app.audio.quality import AudioFacts, describe

from app.schemas.library import (
    Album,
    AlbumSummary,
    Artist,
    ArtistSummary,
    Favorites,
    Playlist,
    PlaylistSummary,
    SearchResults,
    Track,
)

Raw = dict[str, Any]

UNKNOWN_ARTIST = "Unknown artist"
UNTITLED = "Untitled"


def track(raw: Raw) -> Track:
    return Track(
        id=str(raw["id"]),
        title=_text(raw.get("title")) or UNTITLED,
        artist=_text(raw.get("displayArtist")) or _text(raw.get("artist")) or UNKNOWN_ARTIST,
        artist_id=_text(raw.get("artistId")),
        album=_text(raw.get("album")),
        album_id=_text(raw.get("albumId")),
        cover_art_id=_text(raw.get("coverArt")),
        duration_seconds=_positive_int(raw.get("duration")),
        track_number=_positive_int(raw.get("track")),
        disc_number=_positive_int(raw.get("discNumber")),
        year=_positive_int(raw.get("year")),
        genres=_genres(raw),
        content_type=_text(raw.get("contentType")),
        suffix=_text(raw.get("suffix")),
        bitrate_kbps=_positive_int(raw.get("bitRate")),
        favorite=_starred(raw),
        album_artist=_text(raw.get("displayAlbumArtist")) or _text(raw.get("albumArtist")),
        sample_rate=_positive_int(raw.get("samplingRate")),
        bit_depth=_positive_int(raw.get("bitDepth")),
        channels=_positive_int(raw.get("channelCount")),
        size_bytes=_positive_int(raw.get("size")),
        quality=_quality(raw),
    )


def facts_of(t: Track) -> AudioFacts:
    return AudioFacts(t.suffix, t.content_type, t.bitrate_kbps, t.sample_rate, t.bit_depth, t.channels, t.size_bytes, t.duration_seconds)


def _quality(raw: Raw) -> dict | None:
    suffix = _text(raw.get("suffix"))
    if not suffix:
        return None
    return describe(
        AudioFacts(suffix, _text(raw.get("contentType")), _positive_int(raw.get("bitRate")), _positive_int(raw.get("samplingRate")),
                   _positive_int(raw.get("bitDepth")), _positive_int(raw.get("channelCount")), _positive_int(raw.get("size")),
                   _positive_int(raw.get("duration")))
    )


def album_summary(raw: Raw) -> AlbumSummary:
    return AlbumSummary(**_album_fields(raw))


def album(raw: Raw) -> Album:
    return Album(**_album_fields(raw), tracks=[track(song) for song in raw.get("song") or []])


def artist_summary(raw: Raw) -> ArtistSummary:
    return ArtistSummary(
        id=str(raw["id"]),
        name=_text(raw.get("name")) or UNKNOWN_ARTIST,
        album_count=_non_negative_int(raw.get("albumCount")),
        cover_art_id=_text(raw.get("coverArt")),
        favorite=_starred(raw),
    )


def artist(raw: Raw) -> Artist:
    albums = [album_summary(item) for item in raw.get("album") or []]
    # Oldest first reads like a discography; undated albums go last.
    albums.sort(key=lambda a: (a.year is None, a.year or 0, a.name.casefold()))
    return Artist(**artist_summary(raw).model_dump(), albums=albums)


def artist_index(body: Raw) -> list[ArtistSummary]:
    """getArtists groups artists under letters; PandaFM wants one flat list."""
    groups = (body.get("artists") or {}).get("index") or []
    return [artist_summary(entry) for group in groups for entry in group.get("artist") or []]


def search_results(query: str, body: Raw) -> SearchResults:
    # Navidrome omits empty sections entirely: {"searchResult3": {}}.
    result = body.get("searchResult3") or {}
    return SearchResults(
        query=query,
        tracks=[track(item) for item in result.get("song") or []],
        albums=[album_summary(item) for item in result.get("album") or []],
        artists=[artist_summary(item) for item in result.get("artist") or []],
    )


def favorites(body: Raw) -> Favorites:
    starred = body.get("starred2") or {}
    return Favorites(
        tracks=[track(item) for item in starred.get("song") or []],
        albums=[album_summary(item) for item in starred.get("album") or []],
        artists=[artist_summary(item) for item in starred.get("artist") or []],
    )


def playlist_summary(raw: Raw) -> PlaylistSummary:
    return PlaylistSummary(**_playlist_fields(raw))


def playlist(raw: Raw) -> Playlist:
    return Playlist(**_playlist_fields(raw), tracks=[track(entry) for entry in raw.get("entry") or []])


def playlist_list(body: Raw) -> list[PlaylistSummary]:
    return [playlist_summary(item) for item in (body.get("playlists") or {}).get("playlist") or []]


# ── helpers ───────────────────────────────────────────────────────────


def _album_fields(raw: Raw) -> dict[str, Any]:
    return {
        "id": str(raw["id"]),
        # ID3 endpoints call it "name"; folder-based ones call it "title".
        "name": _text(raw.get("name")) or _text(raw.get("title")) or UNTITLED,
        "artist": _text(raw.get("displayArtist")) or _text(raw.get("artist")) or UNKNOWN_ARTIST,
        "artist_id": _text(raw.get("artistId")),
        "cover_art_id": _text(raw.get("coverArt")),
        "year": _positive_int(raw.get("year")),
        "track_count": _non_negative_int(raw.get("songCount")),
        "duration_seconds": _positive_int(raw.get("duration")),
        "genres": _genres(raw),
        "favorite": _starred(raw),
    }


def _playlist_fields(raw: Raw) -> dict[str, Any]:
    return {
        "id": str(raw["id"]),
        "name": _text(raw.get("name")) or UNTITLED,
        "track_count": _non_negative_int(raw.get("songCount")) or 0,
        "duration_seconds": _positive_int(raw.get("duration")),
        "cover_art_id": _text(raw.get("coverArt")),
        "owner": _text(raw.get("owner")),
        "readonly": bool(raw.get("readonly", False)),
    }


def _starred(raw: Raw) -> bool:
    """Navidrome marks favorites with a "starred" timestamp; absent means not starred."""
    return bool(raw.get("starred"))


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _non_negative_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _positive_int(value: Any) -> int | None:
    """Zero means "unknown" for years, track numbers and durations."""
    number = _non_negative_int(value)
    return number or None


def _genres(raw: Raw) -> list[str]:
    names = [
        name
        for item in raw.get("genres") or []
        if isinstance(item, dict) and (name := _text(item.get("name")))
    ]
    if not names and (single := _text(raw.get("genre"))):
        names = [single]
    return names
