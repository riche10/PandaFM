"""Radio presets and built-in names through the API, with real sessions (PostgreSQL)."""

import pytest
from sqlalchemy import text

from tests.test_db_stage3 import TEST_DB, Library, client, event, start
from tests.test_db_stage3 import db as stage3_db  # noqa: F401  (fixture)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")


@pytest.fixture
def db(stage3_db):  # noqa: F811
    with stage3_db.begin() as conn:
        conn.execute(text("TRUNCATE radio_presets CASCADE"))
        conn.execute(text("UPDATE users SET preferences = '{}'::jsonb"))
    return stage3_db


NIGHT = {"familiarity": 90, "discovery": 30, "continuity": 85, "artist_variety": 60, "genre_variety": 30, "wildcards": 20}


def test_built_in_modes_always_listed_and_can_be_renamed_and_reset(db):
    c = client(Library())
    listed = c.get("/api/radio/presets").json()
    assert [p["id"] for p in listed] == ["panda", "familiar", "discovery", "study", "chaos"]
    renamed = c.patch("/api/radio/modes/study", json={"name": "Lock In"}).json()
    assert (renamed["id"], renamed["name"], renamed["default_name"], renamed["base_mode"]) == ("study", "Lock In", "Study", "study")
    assert {m["id"]: m["label"] for m in c.get("/api/radio/modes").json()}["study"] == "Lock In"
    session = start(c, mode="study")["session"]
    assert (session["mode"], session["mode_label"], session["preset_id"]) == ("study", "Lock In", "study")
    with db.connect() as conn:  # a renamed built-in plays the untouched built-in profile
        assert conn.execute(text("SELECT profile IS NULL FROM radio_sessions WHERE mode = 'study'")).scalar() is True  # SQL NULL, not JSON null
    assert c.patch("/api/radio/modes/study", json={"name": None}).json()["name"] == "Study"
    assert c.patch("/api/radio/modes/jazz", json={"name": "x"}).status_code == 422
    assert c.delete("/api/radio/presets/study").status_code == 422
    assert c.patch("/api/radio/presets/panda", json={"name": "x"}).status_code == 422


def test_create_edit_duplicate_and_validate_presets(db):
    c = client(Library())
    made = c.post("/api/radio/presets", json={"name": "Night Drive", "base_mode": "familiar", "controls": NIGHT})
    assert made.status_code == 201
    preset = made.json()
    assert (preset["kind"], preset["base_mode"], preset["base_name"], preset["controls"]) == ("custom", "familiar", "Familiar", NIGHT)
    from_study = c.post("/api/radio/presets", json={"name": "Deep Work", "base_mode": "study"}).json()
    assert from_study["controls"]["continuity"] == 90  # starts from Study's own settings
    edited = c.patch(f"/api/radio/presets/{preset['id']}", json={"name": "Night Drive 2", "controls": {**NIGHT, "wildcards": 70}}).json()
    assert edited["name"] == "Night Drive 2" and edited["controls"]["wildcards"] == 70
    assert c.post(f"/api/radio/presets/{preset['id']}/duplicate").json()["name"] == "Night Drive 2 Copy"
    c.patch("/api/radio/modes/study", json={"name": "Lock In"})
    copy = c.post("/api/radio/presets/study/duplicate").json()
    assert copy["name"] == "Lock In Copy" and copy["base_mode"] == "study" and copy["kind"] == "custom"
    assert len(c.get("/api/radio/presets").json()) == 5 + 4
    for bad in ({"name": "x", "controls": {**NIGHT, "discovery": 150}}, {"name": "x", "controls": {**NIGHT, "weights": 1}},
                {"name": ""}, {"name": "x", "base_mode": "jazz"}, {"name": "x", "raw_score": "1+1"}):
        assert c.post("/api/radio/presets", json=bad).status_code == 422, bad
    assert c.get("/api/radio/presets/not-a-uuid").status_code == 404


def test_custom_preset_sessions_use_the_engine_steer_and_explain(db):
    library = Library()
    c = client(library)
    preset = c.post("/api/radio/presets", json={"name": "Night Drive", "base_mode": "familiar", "controls": NIGHT}).json()
    started = c.post("/api/radio/sessions", json={"preset": preset["id"], "seed": {"kind": "track", "id": "s1"}})
    assert started.status_code == 201, started.text
    out = started.json()
    session = out["session"]
    assert (session["mode"], session["mode_label"], session["preset_id"]) == ("familiar", "Night Drive", preset["id"])
    assert all("Night Drive favors songs you already love" in p["reasons"] for p in out["picks"])  # Why this song?
    # Steering: two skips re-plan the queued picks, exactly as for built-ins.
    by_id = {s["id"]: s for s in library.songs}
    first, second = out["picks"][0], out["picks"][1]
    sid = session["id"]
    c.post("/api/events", json={"events": [
        event("play_started", by_id[first["track"]["id"]], radio=(sid, first["selection_id"])),
        event("skip", by_id[first["track"]["id"]], position=5, radio=(sid, first["selection_id"])),
        event("play_started", by_id[second["track"]["id"]], radio=(sid, second["selection_id"])),
        event("skip", by_id[second["track"]["id"]], position=4, radio=(sid, second["selection_id"])),
    ]})
    upcoming = [p["selection_id"] for p in out["picks"][2:]]
    steered = c.post(f"/api/radio/sessions/{sid}/extend", json={"upcoming": upcoming, "target": 8}).json()
    assert sorted(steered["replaced"]) == sorted(upcoming) and steered["session"]["skips"] == 2
    ids = [p["track"]["id"] for p in out["picks"][:2] + steered["picks"]]
    assert len(ids) == len(set(ids))  # repeat protection still holds


def test_sessions_survive_editing_and_deleting_their_preset(db):
    c = client(Library())
    preset = c.post("/api/radio/presets", json={"name": "Gym", "base_mode": "chaos"}).json()
    out = c.post("/api/radio/sessions", json={"preset": preset["id"], "seed": None}).json()
    sid = out["session"]["id"]
    c.patch(f"/api/radio/presets/{preset['id']}", json={"name": "Gym Renamed", "controls": dict.fromkeys(NIGHT, 0)})
    assert c.get(f"/api/radio/sessions/{sid}").json()["mode_label"] == "Gym"  # the session keeps what it started with
    assert c.delete(f"/api/radio/presets/{preset['id']}").status_code == 204
    assert c.delete(f"/api/radio/presets/{preset['id']}").status_code == 404
    session = c.get(f"/api/radio/sessions/{sid}").json()
    assert session["mode_label"] == "Gym" and session["mode"] == "chaos"
    more = c.post(f"/api/radio/sessions/{sid}/extend", json={"upcoming": [], "target": 4})
    assert more.status_code == 200 and more.json()["picks"]
    with db.connect() as conn:
        row = conn.execute(text("SELECT preset_id, display_name, profile->>'base' FROM radio_sessions WHERE id = :id"), {"id": sid}).one()
        assert row == (None, "Gym", "chaos")
        assert conn.execute(text("SELECT count(*) FROM listening_events")).scalar() >= 0  # history untouched
    assert c.post("/api/radio/sessions", json={"preset": preset["id"]}).status_code == 404
