"""The /api library endpoints, through the real FastAPI app with a fake Navidrome."""

import httpx

from tests.fakes import FakeNavidrome, api_client, assert_no_secrets, fixture, subsonic_error


def test_search_returns_grouped_results():
    fake = FakeNavidrome().json("search3", fixture("search3"))
    with api_client(fake) as client:
        response = client.get("/api/search", params={"q": "  neon  "})

    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "neon"
    assert body["tracks"][0]["title"] == "Afterglow"
    assert body["tracks"][0]["cover_art_id"].startswith("al-")
    assert body["albums"] and body["artists"]
    assert_no_secrets(fake, response)


def test_blank_search_returns_nothing_without_asking_navidrome():
    # Navidrome would answer an empty query with the entire library.
    fake = FakeNavidrome()
    with api_client(fake) as client:
        body = client.get("/api/search", params={"q": "   "}).json()

    assert body == {"query": "", "tracks": [], "albums": [], "artists": []}
    assert fake.requests == []


def test_album_list_endpoint_and_validation():
    fake = FakeNavidrome().json("getAlbumList2", fixture("getAlbumList2"))
    with api_client(fake) as client:
        ok = client.get("/api/albums", params={"list": "random", "size": 2})
        bad = client.get("/api/albums", params={"list": "loudest"})

    assert ok.status_code == 200
    assert ok.json()["kind"] == "random" and len(ok.json()["albums"]) == 2
    assert fake.last("getAlbumList2").url.params["type"] == "random"
    assert bad.status_code == 422


def test_album_artist_and_track_detail_endpoints():
    fake = (
        FakeNavidrome()
        .json("getAlbum", fixture("getAlbum"))
        .json("getArtist", fixture("getArtist"))
        .json("getArtists", fixture("getArtists"))
        .json("getSong", fixture("getSong"))
    )
    with api_client(fake) as client:
        album = client.get("/api/albums/al1").json()
        artist = client.get("/api/artists/ar1").json()
        artists = client.get("/api/artists").json()
        track = client.get("/api/tracks/t1").json()

    assert album["name"] == "Midnight Drive" and len(album["tracks"]) == 4
    assert [a["name"] for a in artist["albums"]] == ["Midnight Drive", "Bamboo Grid"]
    assert len(artists["artists"]) == 3
    assert track["title"] == "Night Run" and track["album"] == "Midnight Drive"
    assert fake.last("getSong").url.params["id"] == "t1"


def test_missing_track_is_a_404_with_a_readable_message():
    fake = FakeNavidrome().json("getSong", subsonic_error(70, "Song not found"))
    with api_client(fake) as client:
        response = client.get("/api/tracks/nope")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_bad_navidrome_credentials_are_a_503_without_leaking_them():
    fake = FakeNavidrome().json("search3", subsonic_error(40, "Wrong username or password"))
    with api_client(fake) as client:
        response = client.get("/api/search", params={"q": "neon"})

    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "navidrome_auth"
    assert "NAVIDROME_PASSWORD" in error["message"]
    assert_no_secrets(fake, response)


def test_navidrome_down_is_a_503():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    fake = FakeNavidrome().handle("getArtists", refuse)
    with api_client(fake) as client:
        response = client.get("/api/artists")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "navidrome_unavailable"
    assert "Connection refused" not in response.text  # detail stays in the server log


def test_overlong_ids_are_rejected_before_reaching_navidrome():
    fake = FakeNavidrome()
    with api_client(fake) as client:
        response = client.get("/api/tracks/" + "x" * 201)
    assert response.status_code == 422
    assert fake.requests == []
