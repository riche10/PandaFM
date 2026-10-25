"""Stage 3 against a real PostgreSQL: migrations, library sync, events,
statistics, scrobbling, Panda Radio's API, steering and Home sections.

Set PANDAFM_TEST_DATABASE_URL (e.g. postgresql+psycopg://pandafm:pw@127.0.0.1/pandafm_test)
to run these; without it they are skipped. The database is wiped between tests.
"""

import os
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.config import Settings
from app.deps import get_navidrome
from app.main import create_app
from app.migrate import head, upgrade
from tests.fakes import sign_in_as_first_user, FakeNavidrome

TEST_DB = os.environ.get("PANDAFM_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")

OK = {"subsonic-response": {"status": "ok", "version": "1.16.1"}}
GENRES = {"synthwave": ["Neon", "Chrome", "Laser"], "electronic": ["Pulse", "Circuit"], "ambient": ["Mist", "Fog"], "indie": ["Static", "Lantern"], "jazz": ["Cat"]}


def settings() -> Settings:
    url = make_url(TEST_DB or "postgresql://x@localhost/x")
    return Settings(
        navidrome_user="panda", navidrome_password=SecretStr("bamboo-test"), db_host=url.host, db_port=url.port or 5432,
        db_name=url.database, db_user=url.username, db_password=SecretStr(url.password or ""), background_sync=False,
    )


def songs(starred: set[str] = frozenset()) -> list[dict]:
    out, n = [], 0
    for g_index, (genre, artists) in enumerate(GENRES.items()):
        for artist in artists:
            for album in range(2):
                for i in range(5):
                    n += 1
                    sid = f"s{n}"
                    song = {
                        "id": sid, "title": f"{artist} {album}-{i}", "artist": artist, "artistId": f"ar-{artist}",
                        "album": f"{artist} album {album}", "albumId": f"al-{artist}-{album}", "genres": [{"name": genre}],
                        "year": 1985 + g_index * 8 + album, "duration": 200, "coverArt": f"al-{artist}-{album}",
                    }
                    if sid in starred:
                        song["starred"] = "2026-10-01T00:00:00Z"
                    out.append(song)
    return out


class Library:
    """A fake Navidrome library that tests can change between syncs."""

    def __init__(self, starred: set[str] = frozenset()) -> None:
        self.songs = songs(starred)
        self.scrobbles: list[str] = []
        self.scrobble_fails = False

    def search3(self, request: httpx.Request) -> httpx.Response:
        offset, count = int(request.url.params.get("songOffset", 0)), int(request.url.params["songCount"])
        return httpx.Response(200, json={"subsonic-response": {"status": "ok", "searchResult3": {"song": self.songs[offset : offset + count]}}})

    def scrobble(self, request: httpx.Request) -> httpx.Response:
        if self.scrobble_fails:
            raise httpx.ConnectError("Navidrome is down", request=request)
        self.scrobbles.append(request.url.params["id"])
        return httpx.Response(200, json=OK)

    def song(self, request: httpx.Request) -> httpx.Response:
        song = next(s for s in self.songs if s["id"] == request.url.params["id"])
        return httpx.Response(200, json={"subsonic-response": {"status": "ok", "song": song}})

    def fake(self) -> FakeNavidrome:
        return (
            FakeNavidrome().handle("search3", self.search3).handle("scrobble", self.scrobble).handle("getSong", self.song)
            .json("star", OK).json("unstar", OK)
        )


@pytest.fixture(scope="module")
def migrated():
    upgrade(settings())


@pytest.fixture
def db(migrated):
    engine = create_engine(settings().database_url)
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE listening_events, track_preferences, radio_queue_items, radio_sessions, library_syncs, tracks RESTART IDENTITY CASCADE"))
    yield engine
    engine.dispose()


def client(library: Library) -> TestClient:
    app = create_app(settings())
    fake = library.fake().client()
    app.dependency_overrides[get_navidrome] = lambda: fake
    sign_in_as_first_user(app)  # not about sign-in (see test_db_auth.py)
    test_client = TestClient(app)
    test_client.__enter__()
    app.state.navidrome = fake  # the syncer uses the app's client
    app.state.syncer._navidrome = fake
    return test_client


def event(kind: str, song: dict, *, play_id=None, position=None, radio=None, minutes_ago: float = 0) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "type": kind,
        "track": {"id": song["id"], "title": song["title"], "artist": song["artist"], "artist_id": song["artistId"],
                  "album": song["album"], "album_id": song["albumId"], "genres": [g["name"] for g in song["genres"]],
                  "year": song["year"], "duration_seconds": song["duration"]},
        "play_id": str(play_id or uuid.uuid4()),
        "occurred_at": (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat(),
        "position_s": position,
        "duration_s": song["duration"],
        "source": "radio" if radio else "album",
        **({"radio_session_id": radio[0], "radio_selection_id": radio[1], "mode": "panda"} if radio else {}),
    }


def prefs(engine, navidrome_id: str) -> dict:
    with engine.connect() as conn:
        row = conn.execute(text("SELECT p.* FROM track_preferences p JOIN tracks t ON t.id = p.track_id WHERE t.navidrome_id = :n"), {"n": navidrome_id}).mappings().first()
    return dict(row) if row else {}


# ── Migrations ────────────────────────────────────────────────────────


def test_migrations_are_repeatable_and_create_the_default_user(db):
    assert upgrade(settings()) == head()  # second run: nothing to do
    with db.connect() as conn:
        tables = set(conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).scalars())
        users = conn.execute(text("SELECT username FROM users")).scalars().all()
    assert {"users", "tracks", "listening_events", "track_preferences", "radio_sessions", "radio_queue_items", "library_syncs"} <= tables
    assert users == ["default"]


# ── Library sync ──────────────────────────────────────────────────────


def test_sync_is_idempotent_mirrors_stars_and_never_deletes(db):
    library = Library(starred={"s1"})
    c = client(library)
    first = c.post("/api/library/sync")
    assert first.status_code == 202
    status = c.get("/api/library/sync").json()
    assert status["last_success"]["tracks_seen"] == 100 and status["last_success"]["tracks_added"] == 100
    assert prefs(db, "s1")["liked"] is True

    c.post("/api/library/sync")
    again = c.get("/api/library/sync").json()["last_success"]
    assert again["tracks_added"] == 0 and again["tracks_missing"] == 0

    library.songs = [s for s in library.songs if s["id"] != "s2"]  # removed from Navidrome
    c.post("/api/library/sync")
    with db.connect() as conn:
        row = conn.execute(text("SELECT is_available FROM tracks WHERE navidrome_id = 's2'")).scalar_one()
    assert row is False  # flagged, not deleted
    assert c.get("/api/library/sync").json()["tracks_total"] == 100


def test_sync_refuses_to_empty_the_cache(db):
    library = Library()
    c = client(library)
    c.post("/api/library/sync")
    library.songs = []  # e.g. the NAS isn't mounted
    c.post("/api/library/sync")
    status = c.get("/api/library/sync").json()
    assert status["last_run"]["status"] == "failed"
    assert status["tracks_available"] == 100


# ── Events, statistics, scrobbles ─────────────────────────────────────


def test_events_are_idempotent_and_build_statistics(db):
    library = Library()
    c = client(library)
    song = library.songs[0]
    play = uuid.uuid4()
    batch = {"events": [event("play_started", song, play_id=play), event("play_completed", song, play_id=play, position=200)]}
    assert c.post("/api/events", json=batch).json() == {"accepted": 2, "duplicates": 0}
    assert c.post("/api/events", json=batch).json() == {"accepted": 0, "duplicates": 2}  # a retried batch
    p = prefs(db, song["id"])
    assert (p["play_count"], p["completed_count"], p["listened_s"]) == (1, 1, 200)
    assert library.scrobbles == [song["id"]]  # a completed song is a real listen


def test_early_and_late_skips_are_told_apart(db):
    library = Library()
    c = client(library)
    early, late, brief = library.songs[0], library.songs[1], library.songs[2]
    c.post("/api/events", json={"events": [
        event("play_started", early), event("skip", early, position=8),
        event("play_started", late), event("skip", late, position=190),
        event("play_started", brief), event("skip", brief, position=2),
    ]})
    assert (prefs(db, early["id"])["early_skip_count"], prefs(db, early["id"])["late_skip_count"]) == (1, 0)
    assert (prefs(db, late["id"])["early_skip_count"], prefs(db, late["id"])["late_skip_count"]) == (0, 1)
    assert library.scrobbles == [late["id"]]  # 190 s of 200 counts; 2 s and 8 s don't


def test_rebuilt_statistics_match_the_live_projection(db):
    library = Library()
    c = client(library)
    s = library.songs[:3]
    c.post("/api/events", json={"events": [
        event("play_started", s[0]), event("play_completed", s[0], position=200),
        event("play_started", s[1]), event("skip", s[1], position=5),
        event("play_started", s[2]), event("skip", s[2], position=120), event("seek", s[2], position=60),
    ]})
    before = [prefs(db, x["id"]) for x in s]
    assert c.post("/api/stats/rebuild").status_code == 200
    after = [prefs(db, x["id"]) for x in s]
    fields = ["play_count", "completed_count", "skip_count", "early_skip_count", "late_skip_count", "listened_s"]
    assert [{f: p[f] for f in fields} for p in before] == [{f: p[f] for f in fields} for p in after]


def test_navidrome_outage_never_loses_listening_history(db):
    library = Library()
    library.scrobble_fails = True
    c = client(library)
    song = library.songs[0]
    response = c.post("/api/events", json={"events": [event("play_started", song), event("play_completed", song, position=200)]})
    assert response.status_code == 200 and response.json()["accepted"] == 2
    assert prefs(db, song["id"])["completed_count"] == 1


def test_unsynced_songs_are_cached_from_the_event(db):
    c = client(Library())
    stranger = {**songs()[0], "id": "new-song", "title": "Brand New"}
    assert c.post("/api/events", json={"events": [event("play_started", stranger)]}).json()["accepted"] == 1
    with db.connect() as conn:
        assert conn.execute(text("SELECT title FROM tracks WHERE navidrome_id = 'new-song'")).scalar_one() == "Brand New"


def test_favoriting_records_a_strong_signal(db):
    library = Library()
    c = client(library)
    c.post("/api/library/sync")
    assert c.put("/api/tracks/s5/favorite").status_code == 204
    assert prefs(db, "s5")["liked"] is True
    assert c.delete("/api/tracks/s5/favorite").status_code == 204
    p = prefs(db, "s5")
    assert p["liked"] is False and p["skip_count"] == 0  # unfavorite is not a dislike


# ── Panda Radio ───────────────────────────────────────────────────────


def start(c: TestClient, mode="panda", seed=("track", "s1")) -> dict:
    body = {"mode": mode, **({"seed": {"kind": seed[0], "id": seed[1]}} if seed else {})}
    response = c.post("/api/radio/sessions", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_radio_from_a_song_syncs_first_and_explains_itself(db):
    c = client(Library())
    started = start(c)  # no sync yet: radio syncs the library itself
    assert started["seed_track"]["id"] == "s1"
    picks = started["picks"]
    assert len(picks) == 10 and "s1" not in {p["track"]["id"] for p in picks}
    assert all(p["reasons"] and all(isinstance(r, str) for r in p["reasons"]) for p in picks)
    synth = sum(1 for p in picks if "synthwave" in p["track"]["genres"])
    assert synth >= 5  # related to the seed, not random
    assert started["session"]["seed_name"] == "Neon 0-0" and started["session"]["mode_label"] == "Panda Radio"


def test_radio_extends_without_repeats(db):
    c = client(Library())
    started = start(c)
    session = started["session"]["id"]
    held = [p["selection_id"] for p in started["picks"]][5:]  # five already played
    more = c.post(f"/api/radio/sessions/{session}/extend", json={"upcoming": held, "target": 8}).json()
    assert more["replaced"] == [] and len(more["picks"]) == 3
    ids = [p["track"]["id"] for p in started["picks"] + more["picks"]]
    assert len(ids) == len(set(ids))


def test_skipping_steers_and_replaces_queued_radio_picks(db):
    library = Library()
    c = client(library)
    started = start(c)
    session = started["session"]["id"]
    by_id = {s["id"]: s for s in library.songs}
    first, second = started["picks"][0], started["picks"][1]
    c.post("/api/events", json={"events": [
        event("play_started", by_id[first["track"]["id"]], radio=(session, first["selection_id"])),
        event("skip", by_id[first["track"]["id"]], position=5, radio=(session, first["selection_id"])),
        event("play_started", by_id[second["track"]["id"]], radio=(session, second["selection_id"])),
        event("skip", by_id[second["track"]["id"]], position=4, radio=(session, second["selection_id"])),
    ]})
    upcoming = [p["selection_id"] for p in started["picks"][2:]]
    steered = c.post(f"/api/radio/sessions/{session}/extend", json={"upcoming": upcoming, "target": 8}).json()
    assert sorted(steered["replaced"]) == sorted(upcoming)  # every queued pick re-planned
    assert len(steered["picks"]) == 8
    assert steered["session"]["skips"] == 2 and steered["session"]["exploration"] > 0.5
    with db.connect() as conn:
        statuses = dict(conn.execute(text("SELECT status, count(*) FROM radio_queue_items GROUP BY status")).all())
    assert statuses["skipped"] == 2 and statuses["replaced"] == 8


def test_a_steered_session_does_not_rewrite_long_term_taste(db):
    library = Library()
    c = client(library)
    started = start(c)
    session = started["session"]["id"]
    by_id = {s["id"]: s for s in library.songs}
    pick = started["picks"][0]
    c.post("/api/events", json={"events": [event("skip", by_id[pick["track"]["id"]], position=3, radio=(session, pick["selection_id"]))]})
    stats = c.get("/api/stats").json()
    assert stats["early_skip_rate"] is None or stats["plays"] == 0  # one skip, no plays: no strong conclusions
    from app.radio.signals import smoothed_affinity

    assert smoothed_affinity(0, 1, 1) > -0.2


def test_modes_cold_start_and_unavailable_songs(db):
    library = Library()
    c = client(library)
    c.post("/api/library/sync")
    with db.begin() as conn:
        conn.execute(text("UPDATE tracks SET is_available = false WHERE artist_id = 'ar-Neon'"))
    for mode in ("panda", "familiar", "discovery", "study", "chaos"):
        picks = start(c, mode=mode, seed=None)["picks"]  # a mode with no seed and no history
        assert len(picks) == 10, mode
        assert all(p["track"]["artist_id"] != "ar-Neon" for p in picks), mode
    assert {m["id"] for m in c.get("/api/radio/modes").json()} == {"panda", "familiar", "discovery", "study", "chaos"}


def test_ending_radio_stops_extensions(db):
    c = client(Library())
    session = start(c)["session"]["id"]
    assert c.post(f"/api/radio/sessions/{session}/end").json()["status"] == "ended"
    refused = c.post(f"/api/radio/sessions/{session}/extend", json={"upcoming": [], "target": 8})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "radio"


# ── Home sections and statistics ──────────────────────────────────────


def test_recently_played_and_rediscover_come_from_pandafm_history(db):
    library = Library(starred={"s9"})
    c = client(library)
    c.post("/api/library/sync")
    s = library.songs
    c.post("/api/events", json={"events": [event("play_started", s[3], minutes_ago=10), event("play_started", s[4], minutes_ago=5)]})
    home = c.get("/api/me/home").json()
    assert [t["id"] for t in home["recently_played"]][:2] == [s[4]["id"], s[3]["id"]]
    assert [t["id"] for t in home["rediscover"]] == ["s9"]  # a favorite never played in PandaFM
    stats = c.get("/api/stats").json()
    assert stats["plays"] == 2 and stats["tracks_available"] == 100
