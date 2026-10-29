"""Panda Mix against PostgreSQL with real ffmpeg analysis of the Stage 4 test media."""

import time

import pytest
from sqlalchemy import text

from app.mix import analysis as mix_analysis
from tests.test_db_stage4 import TEST_DB
from tests.test_db_stage4 import media, server  # noqa: F401  (fixtures)
from tests.test_db_stage3 import db as stage3_db  # noqa: F401  (fixture)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")

T = lambda i, **k: {"id": i, "duration_seconds": 3, **k}  # noqa: E731


@pytest.fixture
def mixer(server, stage3_db):  # noqa: F811
    fake = server.app.state.conversions._navidrome  # the fake Navidrome with real audio
    server.app.state.mix._navidrome = fake
    with stage3_db.begin() as conn:
        conn.execute(text("TRUNCATE mix_track_analysis, mix_transition_overrides"))
    server.engine = stage3_db
    return server


def settle(server, ids, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        states = {i: server.client.get(f"/api/mix/analysis/{i}").json()["status"] for i in ids}
        if all(s in ("ready", "failed") for s in states.values()):
            return states
        time.sleep(0.25)
    raise AssertionError(f"analysis didn't finish: {states}")


def prepare(server, ids, **extra):
    r = server.client.post("/api/mix/prepare", json={"tracks": [T(i) for i in ids], **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_only_the_lookahead_is_analysed_and_results_are_reused(mixer):
    order = ["s1", "s2", "s3", "x4", "x5", "x6"]
    first = prepare(mixer, order)  # current 0, lookahead 3: s1..x4
    assert [t["id"] for t in first["tracks"]] == ["s1", "s2", "s3", "x4"] and first["preparing"]
    assert mixer.app.state.mix.state_of("x5") is None and mixer.app.state.mix.state_of("x6") is None
    assert settle(mixer, ["s1", "s2", "s3", "x4"]) == {"s1": "ready", "s2": "ready", "s3": "ready", "x4": "failed"}  # x4 doesn't exist
    with mixer.engine.begin() as conn:
        assert {r[0] for r in conn.execute(text("SELECT navidrome_id FROM mix_track_analysis"))} == {"s1", "s2", "s3", "x4"}  # never x5/x6
    done = mixer.app.state.mix.analysed
    again = prepare(mixer, order)
    assert not again["preparing"] and mixer.app.state.mix.analysed == done  # cached, not analysed again
    plans = {(p["from"], p["to"]): p for p in again["transitions"]}
    assert plans[("s1", "s2")]["ready"] and plans[("s2", "s3")]["ready"]
    assert plans[("s3", "x4")]["ready"] is False and plans[("s3", "x4")]["source"] == "fallback"  # failed analysis: the safe fallback
    a = mixer.client.get("/api/mix/analysis/s1").json()["analysis"]
    assert a["duration_ms"] > 0 and len(a["waveform"]) == 512 and "integrated_lufs" in a


def test_a_new_analysis_version_analyses_again(mixer, monkeypatch):
    prepare(mixer, ["s1", "s2"])
    settle(mixer, ["s1", "s2"])
    monkeypatch.setattr(mix_analysis, "ANALYSIS_VERSION", mix_analysis.ANALYSIS_VERSION + 1)
    out = prepare(mixer, ["s1", "s2"])
    assert {t["status"] for t in out["tracks"]} <= {"queued", "running", "missing"}  # the old results no longer count


def test_manual_transitions_are_kept_per_playlist_and_reset(mixer, monkeypatch):
    prepare(mixer, ["s1", "s2", "s3"])
    settle(mixer, ["s1", "s2", "s3"])
    edit = {"from_track": "s1", "to_track": "s2", "playlist_id": "p1", "type": "quick_switch", "outgoing_start_ms": 1000, "incoming_start_ms": 200,
            "overlap_ms": 800, "a_duration_ms": 3000, "b_duration_ms": 3000}
    saved = mixer.client.put("/api/mix/transition", json=edit).json()
    assert saved["manual"] and saved["type"] == "quick_switch"
    in_p1 = {(p["from"], p["to"]): p for p in prepare(mixer, ["s1", "s2", "s3"], playlist_id="p1", all_pairs=True)["transitions"]}
    assert in_p1[("s1", "s2")]["manual"] and in_p1[("s1", "s2")]["overlap_ms"] == 800 and not in_p1[("s2", "s3")]["manual"]
    in_p2 = {(p["from"], p["to"]): p for p in prepare(mixer, ["s1", "s2"], playlist_id="p2")["transitions"]}
    assert not in_p2[("s1", "s2")]["manual"]  # another playlist keeps Auto
    monkeypatch.setattr(mix_analysis, "ANALYSIS_VERSION", mix_analysis.ANALYSIS_VERSION + 1)
    still = {(p["from"], p["to"]): p for p in prepare(mixer, ["s1", "s2"], playlist_id="p1")["transitions"]}
    assert still[("s1", "s2")]["manual"]  # new analysis never overwrites a manual edit
    assert mixer.client.delete("/api/mix/transition", params={"from_track": "s1", "to_track": "s2", "playlist_id": "p1"}).status_code == 204
    reset = {(p["from"], p["to"]): p for p in prepare(mixer, ["s1", "s2"], playlist_id="p1")["transitions"]}
    assert not reset[("s1", "s2")]["manual"]  # Reset Auto


def test_panda_mix_needs_a_signed_in_owner(mixer):
    from app.deps import optional_auth, require_auth

    mixer.app.dependency_overrides.pop(require_auth, None)
    mixer.app.dependency_overrides.pop(optional_auth, None)
    assert mixer.client.post("/api/mix/prepare", json={"tracks": [T("s1")]}).status_code == 401
    assert mixer.client.get("/api/mix/analysis/s1").status_code == 401
    assert mixer.client.put("/api/mix/playlists/pl1", json={"mode": "auto"}).status_code == 401


def _playlist(fake, ids):
    from types import SimpleNamespace

    async def get_playlist(playlist_id):
        return SimpleNamespace(id=playlist_id, tracks=[SimpleNamespace(id=i, album_id=None, track_number=None) for i in ids])

    fake.get_playlist = get_playlist


def test_a_persistent_panda_mix_playlist(mixer):
    fake = mixer.app.state.mix._navidrome
    mixer.app.dependency_overrides  # (the router's Navidrome dependency is the same fake)
    _playlist(fake, ["s1", "s2", "s3", "x4", "x5"])
    on = mixer.client.put("/api/mix/playlists/pl1", json={"mode": "flow"}).json()
    assert on["enabled"] and on["status"] == "preparing" and on["order"] == ["s1", "s2", "s3", "x4", "x5"]  # the playlist's own order until analysed
    assert all(mixer.app.state.mix.state_of(i) in ("queued", "running") or i in ("s1",) for i in ["s2", "s3", "x4", "x5"])  # the WHOLE playlist
    settle(mixer, ["s1", "s2", "s3", "x4", "x5"])
    ready = mixer.client.get("/api/mix/playlists/pl1").json()
    assert ready["status"] == "ready" and sorted(ready["order"]) == ["s1", "s2", "s3", "x4", "x5"] and ready["analysed"] == 5
    assert mixer.client.get("/api/mix/playlists/pl1").json()["order"] == ready["order"]  # stable
    assert set(ready["facts"]) == {"s1", "s2", "s3", "x4", "x5"} and ready["facts"]["x4"]["status"] == "failed"
    assert ready["facts"]["s1"]["status"] == "ready" and "bpm" in ready["facts"]["s1"]  # only confident values (else None)
    assert len(ready["why"]) == 4 and all(w["reasons"] for w in ready["why"])
    _playlist(fake, ["s1", "s3", "x4", "x5", "s2b"])  # s2 removed, s2b added in Navidrome
    edited = mixer.client.get("/api/mix/playlists/pl1").json()["order"]
    assert "s2" not in edited and "s2b" in edited
    assert [i for i in edited if i != "s2b"] == [i for i in ready["order"] if i != "s2"]  # the rest keep their place
    assert mixer.client.get("/api/mix/playlists").json()["playlists"] == [{"playlist_id": "pl1", "mode": "flow", "status": "ready"}]
    remixed = mixer.client.post("/api/mix/playlists/pl1/remix").json()
    assert remixed["seed"] != ready["seed"]
    assert mixer.client.delete("/api/mix/playlists/pl1").status_code == 204
    assert mixer.client.get("/api/mix/playlists/pl1").json() == {"playlist_id": "pl1", "enabled": False}
    with mixer.engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM mix_track_analysis")).scalar() >= 5  # analyses are kept
