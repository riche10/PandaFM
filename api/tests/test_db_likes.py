"""5.5.2: PandaFM owns song likes. A music server with no stars, an outage or new song ids can't take them."""

import copy
import importlib

import httpx
import pytest
from sqlalchemy import text

from tests.test_db_stage3 import TEST_DB, Library, client
from tests.test_db_stage3 import db  # noqa: F401  (fixture)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not TEST_DB, reason="needs PANDAFM_TEST_DATABASE_URL")


@pytest.fixture
def make(db):  # noqa: F811
    """Test apps, closed afterwards (each holds a connection pool and background workers)."""
    made = []

    def _make(library):
        c = client(library)
        made.append(c)
        return c

    yield _make
    for c in made:
        c.__exit__(None, None, None)


def liked_ids(c) -> list[str]:
    return [t["id"] for t in c.get("/api/favorites").json()["tracks"]]


def scalar(engine, sql: str, **params):
    with engine.begin() as conn:
        return conn.execute(text(sql), params).scalar()


def test_a_fresh_music_server_with_zero_stars_keeps_every_like(db, make):  # noqa: F811
    old = make(Library(starred={"s1", "s2", "s3"}))
    old.post("/api/library/sync")
    assert sorted(liked_ids(old)) == ["s1", "s2", "s3"]
    events = scalar(db, "SELECT count(*) FROM listening_events")
    fresh = make(Library())  # the same music on a new server: zero stars
    fresh.post("/api/library/sync")
    assert sorted(liked_ids(fresh)) == ["s1", "s2", "s3"]  # 5.5.1 wrote liked=False for every unstarred song
    assert scalar(db, "SELECT count(*) FROM listening_events") == events  # history untouched


def test_liking_and_unliking_work_while_the_music_server_is_down(db, make):  # noqa: F811
    library = Library()
    c = make(library)
    c.post("/api/library/sync")
    down = lambda request: (_ for _ in ()).throw(httpx.ConnectError("Navidrome is down", request=request))  # noqa: E731
    fake = library.fake().handle("star", down).handle("unstar", down).client()
    c.app.dependency_overrides[next(iter(c.app.dependency_overrides))] = lambda: fake
    assert c.put("/api/tracks/s5/favorite").status_code == 204
    assert "s5" in liked_ids(c)
    assert c.delete("/api/tracks/s5/favorite").status_code == 204
    assert "s5" not in liked_ids(c)


def test_likes_rebuild_from_events_alone_latest_wins(db, make):  # noqa: F811
    c = make(Library())
    c.post("/api/library/sync")
    for verb in ("put", "delete", "put"):
        getattr(c, verb)("/api/tracks/s1/favorite")
    for verb in ("put", "delete"):
        getattr(c, verb)("/api/tracks/s2/favorite")
    with db.begin() as conn:
        conn.execute(text("UPDATE track_preferences SET liked = NOT liked"))  # scramble the projection
    c.post("/api/stats/rebuild")
    assert "s1" in liked_ids(c) and "s2" not in liked_ids(c)


def test_stars_import_likes_but_never_override_an_explicit_unlike(db, make):  # noqa: F811
    library = Library(starred={"s1"})
    c = make(library)
    c.post("/api/library/sync")
    assert liked_ids(c) == ["s1"]
    c.delete("/api/tracks/s1/favorite")  # unliked in PandaFM (the server still shows a star)
    library.songs[1]["starred"] = "2026-10-01T00:00:00Z"  # s2 starred elsewhere
    c.post("/api/library/sync")
    assert liked_ids(c) == ["s2"]  # s2 imported; s1 stays unliked
    assert scalar(db, "SELECT source FROM listening_events e JOIN tracks t ON t.id = e.track_id WHERE t.navidrome_id = 's2' AND e.event_type = 'favorite'") == "navidrome-import"


def test_the_upgrade_backfill_makes_existing_likes_durable_and_is_idempotent(db, make, monkeypatch):  # noqa: F811
    c = make(Library())
    c.post("/api/library/sync")
    with db.begin() as conn:  # likes from before 5.5.2: mirrored stars, no event history
        conn.execute(text("""INSERT INTO track_preferences (user_id, track_id, liked)
                             SELECT (SELECT min(id) FROM users), id, true FROM tracks WHERE navidrome_id IN ('s7', 's8')"""))
    migration = importlib.import_module("app.migrations.versions.0009_durable_likes")
    with db.begin() as conn:
        class Op:
            @staticmethod
            def execute(sql):
                conn.execute(text(sql))
        monkeypatch.setattr(migration, "op", Op)  # restored afterwards: later tests run the real migrations
        migration.upgrade()
        migration.upgrade()  # again: adds nothing
    assert scalar(db, "SELECT count(*) FROM listening_events WHERE source = 'migration-0009'") == 2
    assert sorted(liked_ids(c)) == ["s7", "s8"]
    with db.begin() as conn:
        conn.execute(text("UPDATE track_preferences SET liked = false"))
    c.post("/api/stats/rebuild")
    assert sorted(liked_ids(c)) == ["s7", "s8"]  # rebuilt from PandaFM's own events


def test_new_ids_on_a_replaced_backend_keep_likes_only_when_unambiguous(db, make):  # noqa: F811
    old = Library(starred={"s1", "s2", "s3"})
    c = make(old)
    c.post("/api/library/sync")
    new = Library()
    new.songs = [dict(copy.deepcopy(s), id="n" + s["id"][1:]) for s in old.songs]  # the same songs, new ids, no stars
    for s in new.songs:
        s.pop("starred", None)
    twin = dict(copy.deepcopy(next(s for s in new.songs if s["id"] == "n3")), id="n3b")  # s3 now has two plausible matches
    new.songs.append(twin)
    c2 = make(new)
    c2.post("/api/library/sync")
    liked = sorted(liked_ids(c2))
    assert "n1" in liked and "n2" in liked  # one match each way: moved
    assert "n3" not in liked and "n3b" not in liked  # ambiguous: never guessed
    assert scalar(db, "SELECT count(*) FROM listening_events WHERE source = 'identity-transfer'") == 2


def test_every_track_list_shows_pandafms_likes(db, make):  # noqa: F811
    c = make(Library())  # the music server has no stars at all
    c.post("/api/library/sync")
    c.put("/api/tracks/s1/favorite")
    assert c.get("/api/tracks/s1").json()["favorite"] is True
    found = {t["id"]: t["favorite"] for t in c.get("/api/search?q=a&limit=5").json()["tracks"]}
    assert found.get("s1") is True and found.get("s2") is False
