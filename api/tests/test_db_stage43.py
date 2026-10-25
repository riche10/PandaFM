"""Saved stations through the API with real radio sessions (PostgreSQL)."""

import pytest
from sqlalchemy import text

from app.radio.genres import STATION_MIN, affinity, canonical
from tests.test_db_stage3 import TEST_DB, Library, client, event, songs
from tests.test_db_stage3 import db as stage3_db  # noqa: F401  (fixture)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")

ARTISTS = [("Magnolia Park", "Rock"), ("Paramore", "Pop Punk"), ("Foo Fighters", "Rock"), ("Linkin Park", "Alternative Rock"),
           ("Bring Me the Horizon", "Metalcore"), ("Tommy heavenly6", "J-Rock"), ("Hans Zimmer", "Film Score"),
           ("John Williams", "Soundtrack"), ("J. S. Bach", "Classical"), ("Miles Davis", "Jazz"), ("Daft Punk", "Electronic")]
UNRELATED = {"Film Score", "Soundtrack", "Classical", "Jazz", "Electronic"}


class MixedLibrary(Library):
    def __init__(self) -> None:
        super().__init__()
        template = songs(set())[0]
        self.songs = [
            {**template, "id": f"g{a}-{i}", "title": f"{artist} song {i}", "artist": artist, "artistId": f"ar{a}",
             "album": f"{artist} album", "albumId": f"al{a}", "genres": [{"name": genre}], "year": 2010 + i, "starred": None}
            for a, (artist, genre) in enumerate(ARTISTS) for i in range(6)
        ]


@pytest.fixture
def db(stage3_db):  # noqa: F811
    with stage3_db.begin() as conn:
        conn.execute(text("TRUNCATE radio_stations, radio_presets CASCADE"))
        conn.execute(text("UPDATE users SET preferences = '{}'::jsonb"))
    return stage3_db


def genres_of(picks):
    return {g for p in picks for g in p["track"]["genres"]}


def test_genres_and_station_lifecycle(db):
    c = client(MixedLibrary())
    c.post("/api/library/sync")
    names = [g["name"] for g in c.get("/api/radio/genres").json()]
    assert {"Rock", "Pop Punk", "Film Score"} <= set(names)
    made = c.post("/api/radio/stations", json={"name": "Rock", "genres": ["Rock"]})
    assert made.status_code == 201, made.text
    rock = made.json()
    assert (rock["label"], rock["preset"], rock["families"], rock["preset_missing"]) == ("Rock", "panda", ["rock"], False)
    for bad in ({"name": "Polka", "genres": ["Polka"]}, {"name": "", "genres": ["Rock"]}, {"name": "x", "genres": []},
                {"name": "x", "genres": ["Rock"], "weights": 1}, {"name": "x", "genres": ["Rock"], "preset": "not-a-preset"}):
        assert c.post("/api/radio/stations", json=bad).status_code in (404, 422), bad
    edited = c.patch(f"/api/radio/stations/{rock['id']}", json={"name": "Rock Mix", "genres": ["Rock", "Pop Punk"], "preset": "familiar"}).json()
    assert (edited["name"], edited["genres"], edited["label"]) == ("Rock Mix", ["Rock", "Pop Punk"], "Rock Mix · Familiar")
    copy = c.post(f"/api/radio/stations/{rock['id']}/duplicate").json()
    assert copy["name"] == "Rock Mix Copy" and copy["genres"] == ["Rock", "Pop Punk"] and copy["preset"] == "familiar"
    assert c.delete(f"/api/radio/stations/{copy['id']}").status_code == 204
    assert c.get(f"/api/radio/stations/{copy['id']}").status_code == 404
    again = client(MixedLibrary())  # a restart: stations live on the server
    assert [s["name"] for s in again.get("/api/radio/stations").json()] == ["Rock Mix"]


def test_a_rock_station_stays_in_the_rock_neighbourhood(db):
    library = MixedLibrary()
    c = client(library)
    c.post("/api/library/sync")
    station = c.post("/api/radio/stations", json={"name": "Rock", "genres": ["Rock"]}).json()
    out = c.post(f"/api/radio/stations/{station['id']}/start").json()
    session = out["session"]
    assert (session["mode_label"], session["station_id"], session["seed_kind"]) == ("Rock", station["id"], "station")
    picks = list(out["picks"])
    # Skip early, repeatedly: exploration rises, but the station keeps its identity.
    by_id = {s["id"]: s for s in library.songs}
    for p in picks[:4]:
        s = by_id[p["track"]["id"]]
        c.post("/api/events", json={"events": [event("play_started", s, radio=(session["id"], p["selection_id"])),
                                               event("skip", s, position=3, radio=(session["id"], p["selection_id"]))]})
    for _ in range(3):
        more = c.post(f"/api/radio/sessions/{session['id']}/extend", json={"upcoming": [], "target": 8}).json()
        picks += more["picks"]
    assert more["session"]["exploration"] > 0
    found = genres_of(picks)
    assert not found & UNRELATED, found
    assert {"Pop Punk", "Alternative Rock"} & found  # normalized rock relatives take part
    assert all(affinity(p["track"]["genres"], canonical(["Rock"])) >= STATION_MIN for p in picks)


def test_custom_preset_powers_a_station_and_its_deletion_falls_back_to_panda(db):
    c = client(MixedLibrary())
    c.post("/api/library/sync")
    gym = c.post("/api/radio/presets", json={"name": "Gym", "base_mode": "chaos"}).json()
    station = c.post("/api/radio/stations", json={"name": "Rock", "genres": ["Rock"], "preset": gym["id"]}).json()
    assert station["label"] == "Rock · Gym"
    started = c.post("/api/radio/sessions", json={"seed": {"kind": "station", "id": station["id"]}}).json()["session"]
    assert (started["mode"], started["mode_label"], started["preset_id"]) == ("chaos", "Rock · Gym", gym["id"])
    c.delete(f"/api/radio/presets/{gym['id']}")
    after = c.get(f"/api/radio/stations/{station['id']}").json()
    assert (after["preset"], after["preset_missing"], after["label"]) == ("panda", True, "Rock")
    restarted = c.post(f"/api/radio/stations/{station['id']}/start").json()["session"]
    assert (restarted["mode"], restarted["mode_label"]) == ("panda", "Rock")


def test_deleting_a_station_does_not_stop_its_radio(db):
    c = client(MixedLibrary())
    c.post("/api/library/sync")
    station = c.post("/api/radio/stations", json={"name": "Rock", "genres": ["Rock"]}).json()
    sid = c.post(f"/api/radio/stations/{station['id']}/start").json()["session"]["id"]
    assert c.delete(f"/api/radio/stations/{station['id']}").status_code == 204
    more = c.post(f"/api/radio/sessions/{sid}/extend", json={"upcoming": [], "target": 6})
    assert more.status_code == 200 and more.json()["picks"]
    assert not genres_of(more.json()["picks"]) & UNRELATED  # the anchor lives in the session
    assert c.get(f"/api/radio/sessions/{sid}").json()["mode_label"] == "Rock"
    with db.connect() as conn:
        assert conn.execute(text("SELECT station_id FROM radio_sessions WHERE id = :id"), {"id": sid}).scalar() is None


def test_song_seeded_radio_starts_coherent_and_is_not_a_station(db):
    library = MixedLibrary()
    c = client(library)
    c.post("/api/library/sync")
    seed = next(s for s in library.songs if s["artist"] == "Foo Fighters")
    out = c.post("/api/radio/sessions", json={"seed": {"kind": "track", "id": seed["id"]}}).json()
    assert not genres_of(out["picks"]) & UNRELATED
    with db.connect() as conn:
        state = conn.execute(text("SELECT state->'_seed' FROM radio_sessions WHERE id = :id"), {"id": out["session"]["id"]}).scalar()
    assert state["strict"] is False and state["anchor"] == ["rock"]  # a song seed fades gently; it isn't locked


def test_a_skip_no_longer_makes_radio_forget_its_seed(db):
    """Regression (since Stage 3): steering events overwrote the session state and dropped its seed."""
    library = MixedLibrary()
    c = client(library)
    c.post("/api/library/sync")
    seed = next(s for s in library.songs if s["artist"] == "Paramore")
    out = c.post("/api/radio/sessions", json={"seed": {"kind": "track", "id": seed["id"]}}).json()
    sid, first = out["session"]["id"], out["picks"][0]
    song = next(s for s in library.songs if s["id"] == first["track"]["id"])
    c.post("/api/events", json={"events": [event("play_started", song, radio=(sid, first["selection_id"])),
                                           event("skip", song, position=3, radio=(sid, first["selection_id"]))]})
    with db.connect() as conn:
        kept = conn.execute(text("SELECT state->'_seed' FROM radio_sessions WHERE id = :id"), {"id": sid}).scalar()
    assert kept and kept["anchor"] == ["pop punk"] and kept["genres"] == ["Pop Punk"]
