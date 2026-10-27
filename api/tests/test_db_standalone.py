"""5.3 standalone deployment against PostgreSQL, with the real sign-in guard and no bundled Navidrome."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import create_app
from tests import fake_music_server as fake
from tests.test_db_auth import PASSWORD, SETUP_TOKEN, _reset
from tests.test_db_stage3 import TEST_DB, settings
from tests.test_db_stage3 import db as stage3_db  # noqa: F401  (fixture)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")
NO_NAVIDROME = {"navidrome_url": None, "navidrome_user": None, "navidrome_password": None}


OPEN: list[TestClient] = []


@pytest.fixture
def blank(stage3_db):  # noqa: F811
    _reset(stage3_db)  # no owner, no sessions (the 5.0 auth tests' own reset)
    with stage3_db.begin() as conn:
        conn.execute(text("TRUNCATE music_server"))
    yield stage3_db
    while OPEN:  # each app has its own connection pool: close them all
        OPEN.pop().__exit__(None, None, None)


def app_client(tmp_path, token: str | None = SETUP_TOKEN, peer: str = "testclient", config: str = "config", **env) -> TestClient:
    cfg = settings().model_copy(update={"setup_token": token, "config_dir": str(tmp_path / config), "background_sync": False, **NO_NAVIDROME, **env})
    client = TestClient(create_app(cfg), client=(peer, 50000))
    client.__enter__()
    OPEN.append(client)
    return client


def owner(c: TestClient, token: str = SETUP_TOKEN) -> TestClient:
    r = c.post("/api/auth/setup", json={"setup_token": token, "username": "panda", "password": PASSWORD})
    assert r.status_code == 200, r.text
    c.headers["X-PandaFM-CSRF"] = c.cookies.get("pandafm_csrf")
    return c


def connect(c: TestClient, **body):
    c.app.state.music_server.transport = fake.transport(body.pop("mode", "ok"))
    return c.put("/api/music-server", json={"url": "https://music.example.com", "username": fake.USER, "password": fake.PASSWORD, **body})


def test_a_fresh_install_starts_without_a_music_server(blank, tmp_path):
    c = app_client(tmp_path)
    h = c.get("/api/health").json()
    assert h["service"] == "pandafm" and h["status"] == "degraded" and h["database"]["ok"]
    assert h["navidrome"] == {"ok": False, "configured": False, "detail": None, "server_type": None, "server_version": None, "open_subsonic": None, "url": None}
    assert c.get("/api/setup/state").json() == {"owner_configured": False, "music_server_configured": False, "ready": False, "setup_token_required": True}


def test_owner_then_music_server_then_ready(blank, tmp_path):
    c = owner(app_client(tmp_path))
    assert c.get("/api/setup/state").json()["music_server_configured"] is False
    assert c.get("/api/playlists").json()["error"]["code"] == "music_server_not_configured"  # a clear 503, not a crash
    for mode, password, code in [("ok", "wrong", "music_server_bad_credentials"), ("unreachable", fake.PASSWORD, "music_server_unreachable"),
                                 ("html", fake.PASSWORD, "music_server_not_subsonic")]:
        r = connect(c, mode=mode, password=password)
        assert (r.status_code, r.json()["error"]["code"]) == (400, code)
    assert connect(c, url="ftp://nope").json()["error"]["code"] == "music_server_bad_url"
    tested = c.post("/api/music-server/test", json={"url": "music.example.com", "username": fake.USER, "password": fake.PASSWORD}).json()
    assert tested["ok"] and tested["url"] == "https://music.example.com"
    saved = connect(c)
    assert saved.status_code == 200 and saved.json()["configured"] and saved.json()["sync_started"]
    assert "password" not in saved.text and "navi-pass" not in saved.text
    assert c.get("/api/setup/state").json()["ready"] is True
    info = c.get("/api/music-server").json()
    assert (info["url"], info["username"], info["server_type"], info["source"]) == ("https://music.example.com", fake.USER, "navidrome", "setup")
    assert "navi-pass" not in str(info) and "password_enc" not in info
    assert c.get("/api/health").json()["navidrome"]["url"] == "https://music.example.com"  # the owner sees it
    anon = app_client(tmp_path)
    assert anon.get("/api/health").json()["navidrome"]["url"] is None  # anonymous callers never do
    with blank.begin() as conn:
        stored = conn.execute(text("SELECT password_enc, source FROM music_server")).one()
    assert stored[0].startswith("v1:") and "navi-pass" not in stored[0]  # the database alone doesn't reveal it
    kept = c.put("/api/music-server", json={"url": "https://music.example.com", "username": fake.USER, "password": ""})
    assert kept.status_code == 200  # a blank password keeps the saved one


def test_a_restart_uses_the_saved_server_and_a_new_key_is_reported(blank, tmp_path):
    connect(owner(app_client(tmp_path)))
    again = app_client(tmp_path)
    assert again.app.state.navidrome.configured and again.app.state.music_server.url == "https://music.example.com"
    other_key = app_client(tmp_path, config="another-config")
    assert not other_key.app.state.navidrome.configured
    assert "installation key changed" in other_key.app.state.music_server.problem


def test_legacy_environment_settings_are_imported_once(blank, tmp_path):
    legacy = {"navidrome_url": "http://old-navidrome.invalid:4533/", "navidrome_user": "legacy", "navidrome_password": "legacy-pass"}
    first = app_client(tmp_path, **legacy)
    assert first.app.state.navidrome.configured and first.app.state.music_server.url == "http://old-navidrome.invalid:4533"
    with blank.begin() as conn:
        row = conn.execute(text("SELECT source, username, password_enc FROM music_server")).one()
    assert row[0] == "environment" and row[1] == "legacy" and "legacy-pass" not in row[2]
    c = owner(first)
    connect(c)  # the owner changes it in the app
    restarted = app_client(tmp_path, **legacy)  # the old variables are still set
    assert restarted.app.state.music_server.url == "https://music.example.com"  # the saved setting wins


def test_music_server_settings_are_owner_only(blank, tmp_path):
    c = owner(app_client(tmp_path))
    anon = app_client(tmp_path)
    assert anon.get("/api/music-server").status_code == 401
    assert anon.put("/api/music-server", json={"url": "https://evil.example", "username": "x", "password": "y"}).status_code == 401
    no_csrf = TestClient(c.app, cookies=dict(c.cookies), client=("testclient", 50000))
    assert no_csrf.put("/api/music-server", json={"url": "https://evil.example", "username": "x", "password": "y"}).status_code == 403


def test_without_a_token_setup_works_from_home_but_not_from_the_internet(blank, tmp_path):
    outside = app_client(tmp_path, token=None, peer="203.0.113.9")
    assert outside.get("/api/setup/state").json()["setup_token_required"] is True
    assert outside.post("/api/auth/setup", json={"username": "panda", "password": PASSWORD}).status_code == 403
    home = app_client(tmp_path, token=None, peer="192.168.1.20")
    assert home.get("/api/setup/state").json()["setup_token_required"] is False
    assert home.post("/api/auth/setup", json={"username": "panda", "password": PASSWORD}).status_code == 200
