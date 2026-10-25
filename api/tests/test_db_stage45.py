"""Library explorer endpoints against PostgreSQL: genres, browsing, filters, collections, related, Genre Radio."""

import pytest
from sqlalchemy import text

from app.audio.quality import AudioFacts, describe
from app.radio.genres import STATION_MIN, affinity, canonical
from tests.test_db_stage3 import TEST_DB, Library, client, event, songs
from tests.test_db_stage3 import db as stage3_db  # noqa: F401  (fixture)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")

FLAC_HIRES = {"suffix": "flac", "contentType": "audio/flac", "bitRate": 3000, "samplingRate": 96000, "bitDepth": 24}
FLAC_CD = {"suffix": "flac", "contentType": "audio/flac", "bitRate": 900, "samplingRate": 44100, "bitDepth": 16}
ALAC = {"suffix": "m4a", "contentType": "audio/mp4", "bitRate": 1000, "samplingRate": 44100, "bitDepth": 16}
AAC = {"suffix": "m4a", "contentType": "audio/mp4", "bitRate": 256, "samplingRate": 44100, "bitDepth": 0}
MP3 = {"suffix": "mp3", "contentType": "audio/mpeg", "bitRate": 320, "samplingRate": 44100, "bitDepth": 0}
# (artist, album, genre tag, year, quality, songs)
ALBUMS = [("Magnolia Park", "Halloween Mixtape", "Pop-Punk", 2021, FLAC_HIRES, 3), ("Magnolia Park", "Moonchild", "pop punk", 2022, FLAC_CD, 3),
          ("Paramore", "Riot!", "Pop Punk", 2007, MP3, 4), ("Linkin Park", "Meteora", "Alternative Rock", 2003, ALAC, 3),
          ("Foo Fighters", "Wasting Light", "Rock", 2011, AAC, 3), ("Hans Zimmer", "Interstellar", "Film Score", 2014, FLAC_HIRES, 3),
          ("J. S. Bach", "Cello Suites", "Classical", None, FLAC_CD, 2), ("Unknown Band", "Demos", "", 2019, MP3, 2)]


class ExplorerLibrary(Library):
    def __init__(self) -> None:
        super().__init__()
        template = songs(set())[0]
        self.songs = [
            {**template, **quality, "id": f"x{a}-{i}", "title": f"{name} {i}", "artist": artist, "artistId": f"ar-{artist}",
             "album": name, "albumId": f"al{a}", "genres": [{"name": genre}] if genre else [], "year": year, "starred": None, "size": 1000 + i}
            for a, (artist, name, genre, year, quality, count) in enumerate(ALBUMS) for i in range(count)
        ]
        for s in self.songs:
            if s["year"] is None:
                s.pop("year")


@pytest.fixture
def lib(stage3_db):  # noqa: F811
    with stage3_db.begin() as conn:
        conn.execute(text("TRUNCATE radio_stations, radio_presets CASCADE"))
    library = ExplorerLibrary()
    c = client(library)
    c.post("/api/library/sync")
    return c, library, stage3_db


def test_genres_merge_spellings_and_keep_related_genres_apart(lib):
    c, _, _ = lib
    genres = {g["key"]: g for g in c.get("/api/genres").json()}
    assert set(genres) == {"pop punk", "alternative rock", "rock", "film score", "classical"}  # no empty genre
    pp = genres["pop punk"]
    assert (pp["name"], pp["songs"], pp["albums"], pp["artists"]) == ("Pop Punk", 10, 3, 2)
    detail = c.get("/api/genres/pop%20punk").json()
    assert [a["name"] for a in detail["artists"]] == ["Magnolia Park", "Paramore"]
    assert {g["key"] for g in detail["related"]} >= {"alternative rock", "rock"}
    assert "film score" not in {g["key"] for g in detail["related"]}
    assert c.get("/api/genres/polka").status_code == 404


def test_browsing_by_genre_decade_and_paging(lib):
    c, _, _ = lib
    page = c.get("/api/browse/tracks", params={"genre": "pop punk", "limit": 4}).json()
    assert page["total"] == 10 and len(page["tracks"]) == 4
    assert all(any(g.lower().replace("-", " ") == "pop punk" for g in t["genres"]) for t in page["tracks"])
    albums = c.get("/api/browse/albums", params={"genre": "pop punk"}).json()
    assert sorted(a["name"] for a in albums["albums"]) == ["Halloween Mixtape", "Moonchild", "Riot!"]
    assert c.get("/api/browse/albums", params={"decade": 2000}).json()["total"] == 2  # Riot!, Meteora
    assert c.get("/api/browse/tracks", params={"decade": 2020, "genre": "pop punk"}).json()["total"] == 6
    assert c.get("/api/browse/tracks", params={"decade": 2005}).status_code == 422  # decades only


def test_decades_skip_songs_without_a_year(lib):
    c, _, _ = lib
    decades = c.get("/api/library/decades").json()
    assert [(d["label"], d["albums"], d["songs"]) for d in decades] == [("2020s", 2, 6), ("2010s", 3, 8), ("2000s", 2, 7)]


def test_lossless_and_hi_res_match_pandafm_quality_rules(lib):
    c, library, _ = lib
    expect = {}
    for s in library.songs:
        q = describe(AudioFacts(s["suffix"], None, s["bitRate"], s["samplingRate"], s["bitDepth"] or None, None, s["size"], None))
        expect[s["id"]] = (q["lossless"] is True, q["hi_res"])
    lossless = {t["id"] for t in c.get("/api/browse/tracks", params={"lossless": True, "limit": 500}).json()["tracks"]}
    hires = {t["id"] for t in c.get("/api/browse/tracks", params={"hires": True, "limit": 500}).json()["tracks"]}
    assert lossless == {i for i, (l, _) in expect.items() if l} and len(lossless) == 14  # FLAC + ALAC, never AAC/MP3
    assert hires == {i for i, (_, h) in expect.items() if h} and len(hires) == 6
    counts = {col["id"]: col.get("count") for col in c.get("/api/collections").json()}
    assert (counts["lossless"], counts["hires"]) == (14, 6)


def test_unplayed_collection_and_rediscover(lib):
    c, library, _ = lib
    first = library.songs[0]
    c.post("/api/events", json={"events": [event("play_started", first), event("play_completed", first, position=200)]})
    unplayed = c.get("/api/collections/unplayed/tracks", params={"limit": 500}).json()
    assert unplayed["total"] == len(library.songs) - 1 and first["id"] not in {t["id"] for t in unplayed["tracks"]}
    assert c.get("/api/collections/rediscover/tracks").status_code == 200
    assert c.get("/api/collections/everything/tracks").status_code == 422


def test_related_albums_from_the_library_only(lib):
    c, _, _ = lib
    related = c.get("/api/albums/al0/related").json()  # Halloween Mixtape (Magnolia Park, Pop Punk)
    names = [r["album"]["name"] for r in related]
    assert names[0] == "Riot!" and "Moonchild" not in names  # same artist: that's "More by"
    assert not {"Interstellar", "Cello Suites", "Demos"} & set(names)  # unrelated or no genre
    assert c.get("/api/albums/al7/related").json() == []  # the zero-genre album: no shelf


def test_search_finds_the_genre_and_genre_radio_stays_in_it(lib):
    c, library, _ = lib
    found = c.get("/api/search", params={"q": "pop punk"}).json()
    assert found["genres"][0]["key"] == "pop punk"
    out = c.post("/api/radio/sessions", json={"seed": {"kind": "genre", "id": "rock"}}).json()
    session = out["session"]
    assert (session["mode_label"], session["seed_kind"], session["station_id"]) == ("Rock Radio", "genre", None)
    picks = list(out["picks"])
    by_id = {s["id"]: s for s in library.songs}
    for p in picks[:3]:  # skips raise exploration; the genre anchor holds
        s = by_id[p["track"]["id"]]
        c.post("/api/events", json={"events": [event("play_started", s, radio=(session["id"], p["selection_id"])),
                                               event("skip", s, position=3, radio=(session["id"], p["selection_id"]))]})
    picks += c.post(f"/api/radio/sessions/{session['id']}/extend", json={"upcoming": [], "target": 8}).json()["picks"]
    found_genres = {g for p in picks for g in p["track"]["genres"]}
    assert not found_genres & {"Film Score", "Classical"}, found_genres
    assert all(affinity(p["track"]["genres"], canonical(["Rock"])) >= STATION_MIN for p in picks)
    familiar = c.post("/api/radio/sessions", json={"preset": "familiar", "seed": {"kind": "genre", "id": "rock"}}).json()["session"]
    assert familiar["mode_label"] == "Rock · Familiar"
    assert c.post("/api/radio/sessions", json={"seed": {"kind": "genre", "id": "polka"}}).status_code == 409
