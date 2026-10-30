"""Favorites (Navidrome stars), playlists, and the extra library views."""

import httpx
import pytest

from tests.fakes import FakeNavidrome, api_client, fixture, subsonic_error

OK = {"subsonic-response": {"status": "ok", "version": "1.16.1"}}

# ── Favorites ────────────────────────────────────────────────────────


# 5.5.2: Liked Songs come from PandaFM's database: see tests/test_db_likes.py.


def test_unstarred_items_are_not_favorites():
    fake = FakeNavidrome().json("getSong", fixture("getSong"))
    with api_client(fake) as client:
        assert client.get("/api/tracks/t1").json()["favorite"] is False


@pytest.mark.parametrize(
    ("collection", "param"),
    [("albums", "albumId"), ("artists", "artistId")],  # song likes are PandaFM's own (tests/test_db_likes.py)
)
def test_favorite_and_unfavorite_use_star_and_unstar(collection: str, param: str):
    fake = FakeNavidrome().json("star", OK).json("unstar", OK)
    with api_client(fake) as client:
        put = client.put(f"/api/{collection}/x1/favorite")
        delete = client.delete(f"/api/{collection}/x1/favorite")

    assert put.status_code == delete.status_code == 204
    assert fake.last("star").url.params[param] == "x1"
    assert fake.last("unstar").url.params[param] == "x1"


# ── Playlists ────────────────────────────────────────────────────────


def test_list_playlists():
    fake = FakeNavidrome().json("getPlaylists", fixture("getPlaylists"))
    with api_client(fake) as client:
        playlists = client.get("/api/playlists").json()["playlists"]

    assert playlists[0]["name"] == "Renamed Mix"
    assert playlists[0]["track_count"] == 3
    assert playlists[0]["readonly"] is False
    assert playlists[0]["cover_art_id"].startswith("pl-")


def test_create_playlist_with_songs():
    fake = FakeNavidrome().json("createPlaylist", fixture("createPlaylist"))
    with api_client(fake) as client:
        response = client.post("/api/playlists", json={"name": "  Test Mix ", "track_ids": ["a", "b"]})

    assert response.status_code == 201
    assert [t["title"] for t in response.json()["tracks"]] == ["Grid Lock", "Slow Lane"]
    sent = fake.last("createPlaylist").url.params
    assert sent["name"] == "Test Mix"  # trimmed
    assert sent.get_list("songId") == ["a", "b"]


def test_blank_playlist_name_is_rejected_before_navidrome():
    fake = FakeNavidrome()
    with api_client(fake) as client:
        response = client.post("/api/playlists", json={"name": "   "})
    assert response.status_code == 422
    assert fake.requests == []


def test_rename_and_add_tracks_return_the_updated_playlist():
    fake = FakeNavidrome().json("updatePlaylist", OK).json("getPlaylist", fixture("getPlaylist"))
    with api_client(fake) as client:
        renamed = client.patch("/api/playlists/p1", json={"name": "Renamed Mix"})
        added = client.post("/api/playlists/p1/tracks", json={"track_ids": ["c", "d"]})

    assert renamed.json()["name"] == "Renamed Mix" and added.status_code == 200
    updates = [r.url.params for r in fake.requests if r.url.path == "/rest/updatePlaylist"]
    assert updates[0]["name"] == "Renamed Mix" and updates[0]["playlistId"] == "p1"
    assert updates[1].get_list("songIdToAdd") == ["c", "d"]


def test_adding_nothing_is_rejected():
    with api_client(FakeNavidrome()) as client:
        assert client.post("/api/playlists/p1/tracks", json={"track_ids": []}).status_code == 422


def test_remove_track_checks_the_song_at_that_position():
    playlist = fixture("getPlaylist")
    first_id = playlist["subsonic-response"]["playlist"]["entry"][0]["id"]
    fake = FakeNavidrome().json("getPlaylist", playlist).json("updatePlaylist", OK)

    with api_client(fake) as client:
        ok = client.delete("/api/playlists/p1/tracks/0", params={"track_id": first_id})
    assert ok.status_code == 200
    assert fake.last("updatePlaylist").url.params["songIndexToRemove"] == "0"


def test_remove_track_refuses_when_the_playlist_changed():
    fake = FakeNavidrome().json("getPlaylist", fixture("getPlaylist")).json("updatePlaylist", OK)
    with api_client(fake) as client:
        response = client.delete("/api/playlists/p1/tracks/0", params={"track_id": "someone-else"})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "playlist_changed"
    assert not [r for r in fake.requests if r.url.path == "/rest/updatePlaylist"]


def test_delete_playlist_and_missing_playlist():
    fake = FakeNavidrome().json("deletePlaylist", OK)
    with api_client(fake) as client:
        assert client.delete("/api/playlists/p1").status_code == 204

    missing = FakeNavidrome().json("getPlaylist", subsonic_error(70, "playlist not found"))
    with api_client(missing) as client:
        assert client.get("/api/playlists/nope").status_code == 404


def test_navidrome_refusing_a_change_is_403():
    fake = FakeNavidrome().json("updatePlaylist", subsonic_error(50, "not authorized"))
    with api_client(fake) as client:
        response = client.patch("/api/playlists/p1", json={"name": "Mine now"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


# ── Library views: all songs, random songs, an artist's songs ─────────


def test_all_songs_pages_through_the_library():
    fake = FakeNavidrome().json("search3", fixture("search3"))
    with api_client(fake) as client:
        body = client.get("/api/tracks", params={"size": 3, "offset": 6}).json()

    assert body["order"] == "all" and body["offset"] == 6 and body["tracks"]
    sent = fake.last("search3").url.params
    assert (sent["query"], sent["songCount"], sent["songOffset"]) == ("", "3", "6")


def test_random_songs():
    random_body = {"subsonic-response": {"status": "ok", "randomSongs": {"song": [fixture("getSong")["subsonic-response"]["song"]]}}}
    fake = FakeNavidrome().json("getRandomSongs", random_body)
    with api_client(fake) as client:
        body = client.get("/api/tracks", params={"order": "random", "size": 5}).json()

    assert [t["title"] for t in body["tracks"]] == ["Night Run"]
    assert fake.last("getRandomSongs").url.params["size"] == "5"


def test_artist_tracks_come_from_their_albums():
    fake = FakeNavidrome().json("getArtist", fixture("getArtist")).json("getAlbum", fixture("getAlbum"))
    with api_client(fake) as client:
        tracks = client.get("/api/artists/ar1/tracks").json()["tracks"]

    album_calls = [r for r in fake.requests if r.url.path == "/rest/getAlbum"]
    assert len(album_calls) == 2  # one per album on the artist page
    assert len(tracks) == 8 and tracks[0]["title"] == "Night Run"
