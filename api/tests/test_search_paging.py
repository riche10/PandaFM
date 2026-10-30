"""5.5.2: search pages through every matching song (it used to stop at 20)."""

import httpx

from tests.fakes import FakeNavidrome, api_client


def library(n_match: int, n_other: int = 12) -> list[dict]:
    songs = [{"id": f"cs{k}", "title": f"Cyber Space {k // 7 + 1}-{k % 7 + 1}", "artist": "Sonic Team", "artistId": "ar1",
              "album": "Sonic Frontiers", "albumId": "al1", "duration": 120} for k in range(n_match)]
    songs += [{"id": f"o{k}", "title": f"Other {k}", "artist": "Someone", "artistId": "ar2", "album": "Else", "albumId": "al2", "duration": 120}
              for k in range(n_other)]
    return songs


def fake(songs: list[dict]) -> tuple[FakeNavidrome, list[dict]]:
    calls: list[dict] = []

    def search3(request: httpx.Request) -> httpx.Response:
        p = request.url.params
        calls.append(dict(p))
        words = p["query"].lower().split()
        hits = [s for s in songs if all(w in s["title"].lower() for w in words)]
        off, count = int(p.get("songOffset", 0)), int(p["songCount"])
        artists = [{"id": "ar1", "name": "Sonic Team"}] if hits and int(p.get("artistCount", 0)) else []
        albums = [{"id": "al1", "name": "Sonic Frontiers", "artist": "Sonic Team", "artistId": "ar1"}] if hits and int(p.get("albumCount", 0)) else []
        return httpx.Response(200, json={"subsonic-response": {"status": "ok", "searchResult3": {
            "song": hits[off:off + count], "artist": artists, "album": albums}}})

    return FakeNavidrome().handle("search3", search3), calls


def all_pages(client, q: str, limit: int) -> tuple[list[str], list[dict]]:
    ids, pages, offset = [], [], 0
    while True:
        body = client.get("/api/search", params={"q": q, "limit": limit, "offset": offset}).json()
        pages.append(body)
        ids += [t["id"] for t in body["tracks"]]
        if not body["tracks_has_more"]:
            return ids, pages
        offset += limit


def test_all_28_cyber_space_songs_are_reachable_in_order_without_duplicates():
    nav, _ = fake(library(28))
    with api_client(nav) as client:
        ids, pages = all_pages(client, "Cyber Space", 10)
    assert ids == [f"cs{k}" for k in range(28)]  # every one, in the server's order, no duplicates
    assert [len(p["tracks"]) for p in pages] == [10, 10, 8] and pages[-1]["tracks_has_more"] is False
    assert [p["track_offset"] for p in pages] == [0, 10, 20]


def test_a_page_that_ends_exactly_on_the_last_song_says_there_is_no_more():
    nav, _ = fake(library(28))
    with api_client(nav) as client:
        body = client.get("/api/search", params={"q": "Cyber Space", "limit": 28}).json()
    assert len(body["tracks"]) == 28 and body["tracks_has_more"] is False


def test_more_than_50_matches_page_completely():
    nav, _ = fake(library(75))
    with api_client(nav) as client:
        ids, pages = all_pages(client, "Cyber Space", 50)
    assert len(ids) == 75 and len(set(ids)) == 75 and "cs50" in ids and "cs74" in ids
    assert len(pages) == 2


def test_later_pages_bring_songs_only():
    nav, calls = fake(library(30))
    with api_client(nav) as client:
        first = client.get("/api/search", params={"q": "Cyber Space", "limit": 20}).json()
        second = client.get("/api/search", params={"q": "Cyber Space", "limit": 20, "offset": 20}).json()
    assert first["artists"] and first["albums"]
    assert second["artists"] == [] and second["albums"] == []  # not repeated on every page
    assert calls[-1]["songOffset"] == "20" and calls[-1]["songCount"] == "21"  # one extra: an exact 'has more'
