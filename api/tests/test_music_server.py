"""5.3: PandaFM's external music server: encrypted, runtime-configured, legacy settings migrated."""

import asyncio
import os
import stat

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import text

from app.main import create_app
from app.musicserver import MusicServerHolder, SecretBox
from app.navidrome.client import NavidromeError
from tests.fakes import sign_in_as_first_user
from tests.test_db_stage3 import TEST_DB, settings
from tests.test_db_stage3 import db as stage3_db  # noqa: F401  (fixture)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)


def test_the_password_is_sealed_and_only_this_key_opens_it(tmp_path):
    box = SecretBox(None, tmp_path)
    sealed = box.seal("bamboo-test")
    assert "bamboo" not in sealed and box.open(sealed) == "bamboo-test"
    assert stat.S_IMODE(os.stat(tmp_path / "secret.key").st_mode) == 0o600  # owner-only
    assert SecretBox(None, tmp_path).open(sealed) == "bamboo-test"  # the same key next time
    assert SecretBox("another key", tmp_path).open(sealed) is None  # a different key: re-enter, never crash
    assert SecretBox("k", tmp_path).open(SecretBox("k", tmp_path / "x").seal("p")) == "p"  # PANDAFM_SECRET_KEY works anywhere


def test_an_unwritable_data_dir_never_stops_pandafm(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    box = SecretBox(None, blocker / "sub")
    assert box.ephemeral and box.open(box.seal("x")) == "x"


def test_nothing_set_up_yet_says_so():
    holder = MusicServerHolder(5)
    assert not holder.configured
    with pytest.raises(NavidromeError, match="No music server"):
        asyncio.run(holder.get_albums())


DB = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")


def app_with(**changes):
    cfg = settings().model_copy(update={"data_dir": "/tmp/pandafm-test-data", "secret_key": SecretStr("test secret"), **changes})
    app = create_app(cfg)
    client = TestClient(app)
    client.__enter__()
    return app, client


@pytest.fixture
def clean(stage3_db):  # noqa: F811
    with stage3_db.begin() as conn:
        conn.execute(text("TRUNCATE music_server"))
    yield stage3_db
    with stage3_db.begin() as conn:
        conn.execute(text("TRUNCATE music_server"))


@DB
def test_legacy_environment_settings_are_copied_encrypted_and_still_win(clean):
    app, client = app_with(navidrome_url="http://nd.example:4533", navidrome_user="panda", navidrome_password=SecretStr("bamboo-test"))
    with clean.begin() as conn:
        row = conn.execute(text("SELECT url, username, password_sealed FROM music_server")).one()
    assert row[0] == "http://nd.example:4533" and row[1] == "panda" and "bamboo" not in row[2]
    sign_in_as_first_user(app)
    info = client.get("/api/settings/music-server").json()
    assert info == {"configured": True, "url": "http://nd.example:4533", "username": "panda", "managed_by_env": True}
    assert client.put("/api/settings/music-server", json={"url": "http://other:4533", "username": "x", "password": "y"}).status_code == 409
    client.__exit__(None, None, None)
    app2, client2 = app_with(navidrome_url=None, navidrome_user=None, navidrome_password=None)  # the variables were removed
    assert app2.state.navidrome.configured and app2.state.navidrome.url == "http://nd.example:4533"  # decrypted from the database
    assert not app2.state.navidrome.managed_by_env
    client2.__exit__(None, None, None)


@DB
def test_first_run_then_settings_connect_a_server(clean, monkeypatch):
    app, client = app_with(navidrome_url=None, navidrome_user=None, navidrome_password=None)
    health = client.get("/api/health").json()
    assert health["navidrome"]["configured"] is False and health["navidrome"]["ok"] is False  # the first-run screen asks for one
    sign_in_as_first_user(app)
    import app.routers.music_server as route

    async def unreachable(url, user, password, timeout):
        return "Connection refused"

    monkeypatch.setattr(route, "test_connection", unreachable)
    bad = client.put("/api/settings/music-server", json={"url": "http://nd.local:4533", "username": "panda", "password": "pw"})
    assert bad.status_code == 400 and "Connection refused" in bad.text

    async def fine(url, user, password, timeout):
        return None

    monkeypatch.setattr(route, "test_connection", fine)
    ok = client.put("/api/settings/music-server", json={"url": "http://nd.local:4533/", "username": "panda", "password": "pw-secret"})
    assert ok.status_code == 200 and ok.json()["url"] == "http://nd.local:4533"
    assert "pw-secret" not in client.get("/api/settings/music-server").text  # write-only
    assert app.state.navidrome.configured and app.state.navidrome.url == "http://nd.local:4533"
    keep = client.put("/api/settings/music-server", json={"url": "http://nd.local:4533", "username": "panda2"})  # no password: keep the stored one
    assert keep.status_code == 200
    client.__exit__(None, None, None)
