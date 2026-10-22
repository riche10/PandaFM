"""Library calls on NavidromeClient, against real (trimmed) Navidrome responses."""

import httpx
import pytest

from app.navidrome import parse
from app.navidrome.client import NavidromeNotFound, NavidromeUnavailable
from app.schemas.library import AlbumListKind
from tests.fakes import FakeNavidrome, fixture, subsonic_error


@pytest.mark.anyio
async def test_search_groups_tracks_albums_and_artists():
    fake = FakeNavidrome().json("search3", fixture("search3"))
    results = await fake.client().search("neon")

    assert results.query == "neon"
    assert [t.title for t in results.tracks] == ["Afterglow", "Coastline"]
    first = results.tracks[0]
    assert first.artist == "Neon Panda"
    assert first.album == "Midnight Drive"
    assert first.cover_art_id and first.cover_art_id.startswith("al-")
    assert first.duration_seconds == 95
    assert {a.name for a in results.albums} == {"Midnight Drive", "Bamboo Grid"}
    assert [a.name for a in results.artists] == ["Neon Panda"]

    request = fake.last("search3")
    assert request.url.params["query"] == "neon"
    assert request.url.params["songCount"] == "20"


@pytest.mark.anyio
async def test_search_with_no_matches_is_empty_not_an_error():
    empty = {"subsonic-response": {"status": "ok", "version": "1.16.1", "searchResult3": {}}}
    results = await FakeNavidrome().json("search3", empty).client().search("zzz")
    assert results.tracks == [] and results.albums == [] and results.artists == []


@pytest.mark.anyio
async def test_get_track_reads_song_metadata():
    track = await FakeNavidrome().json("getSong", fixture("getSong")).client().get_track("x")

    assert track.title == "Night Run"
    assert track.artist == "Neon Panda"
    assert track.album == "Midnight Drive"
    assert track.year == 1986
    assert track.genres == ["Synthwave"]
    assert track.suffix == "mp3"
    assert track.content_type == "audio/mpeg"
    assert track.bitrate_kbps == 192
    assert track.track_number == 1


@pytest.mark.anyio
async def test_get_album_includes_tracks_in_order():
    album = await FakeNavidrome().json("getAlbum", fixture("getAlbum")).client().get_album("x")

    assert album.name == "Midnight Drive"
    assert album.track_count == 4
    assert [t.track_number for t in album.tracks] == [1, 2, 3, 4]
    assert album.tracks[0].title == "Night Run"


@pytest.mark.anyio
async def test_get_artist_lists_albums_oldest_first_and_hides_navidrome_urls():
    artist = await FakeNavidrome().json("getArtist", fixture("getArtist")).client().get_artist("x")

    assert artist.name == "Neon Panda"
    assert [(a.name, a.year) for a in artist.albums] == [("Midnight Drive", 1986), ("Bamboo Grid", 1989)]
    # Navidrome's artistImageUrl embeds its own access token; it must never be exposed.
    assert "http" not in artist.model_dump_json()


@pytest.mark.anyio
async def test_get_artists_flattens_the_letter_index():
    artists = await FakeNavidrome().json("getArtists", fixture("getArtists")).client().get_artists()
    assert {a.name for a in artists} == {"Neon Panda", "Mist Valley", "The Static Hours"}
    assert all(a.album_count for a in artists)


@pytest.mark.anyio
async def test_album_list_maps_kind_to_subsonic_type():
    fake = FakeNavidrome().json("getAlbumList2", fixture("getAlbumList2"))
    albums = await fake.client().get_album_list(AlbumListKind.alphabetical, size=2, offset=4)

    assert len(albums) == 2
    params = fake.last("getAlbumList2").url.params
    assert (params["type"], params["size"], params["offset"]) == ("alphabeticalByName", "2", "4")


@pytest.mark.anyio
async def test_missing_track_raises_not_found():
    fake = FakeNavidrome().json("getSong", subsonic_error(70, "Song not found"))
    with pytest.raises(NavidromeNotFound):
        await fake.client().get_track("nope")


@pytest.mark.anyio
async def test_response_missing_required_fields_is_unavailable():
    broken = {"subsonic-response": {"status": "ok", "song": {"title": "No id"}}}
    with pytest.raises(NavidromeUnavailable, match="couldn't read"):
        await FakeNavidrome().json("getSong", broken).client().get_track("x")


def test_parsing_is_lenient_about_poor_tags():
    track = parse.track({"id": "1", "year": 0, "track": "0", "duration": "abc", "genre": "Jazz"})

    assert track.title == "Untitled"
    assert track.artist == "Unknown artist"
    assert track.year is None and track.track_number is None and track.duration_seconds is None
    assert track.genres == ["Jazz"]  # falls back to the single legacy genre field


@pytest.mark.anyio
async def test_navidrome_unreachable_during_library_call():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    with pytest.raises(NavidromeUnavailable):
        await FakeNavidrome().handle("getArtists", refuse).client().get_artists()
