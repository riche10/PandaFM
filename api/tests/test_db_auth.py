"""PandaFM 5.0 authentication against PostgreSQL, with the real guard (no test sign-in)."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.deps import get_navidrome
from app.main import create_app
from tests.test_db_stage3 import TEST_DB, Library, event, settings
from tests.test_db_stage3 import db as stage3_db  # noqa: F401  (fixture)
from tests.test_db_stage3 import migrated  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not TEST_DB, reason="set PANDAFM_TEST_DATABASE_URL to run database tests")

SETUP_TOKEN = "setup-token-0123456789-abcdef"
PASSWORD = "bamboo forest 42"


def real_client(library: Library, setup_token: str | None = SETUP_TOKEN, peer: str = "testclient") -> TestClient:
    app = create_app(settings().model_copy(update={"setup_token": setup_token}))
    fake = library.fake().client()
    app.dependency_overrides[get_navidrome] = lambda: fake
    client = TestClient(app, client=(peer, 50000))
    client.__enter__()
    app.state.navidrome = fake
    app.state.syncer._navidrome = fake
    return client


def _reset(engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE auth_sessions, radio_stations, radio_presets CASCADE"))
        conn.execute(text("UPDATE users SET username = 'default', password_hash = NULL, password_changed_at = NULL"))


@pytest.fixture
def fresh(stage3_db):  # noqa: F811
    _reset(stage3_db)
    library = Library()
    yield real_client(library), library, stage3_db
    _reset(stage3_db)  # leave the pre-5.0 default user for the other database tests


def setup(c: TestClient, **extra) -> dict:
    r = c.post("/api/auth/setup", json={"setup_token": SETUP_TOKEN, "username": "panda", "password": PASSWORD, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def device(c: TestClient, name="Sony NW-A306") -> dict:
    r = c.post("/api/auth/login", json={"username": "panda", "password": PASSWORD, "client": "device", "device_name": name, "platform": "android"})
    assert r.status_code == 200, r.text
    return r.json()


def anon(library) -> TestClient:
    return real_client(library)


PROTECTED = [("GET", "/api/albums"), ("GET", "/api/search?q=x"), ("GET", "/api/tracks/s1/stream"), ("GET", "/api/covers/c1"),
             ("POST", "/api/downloads/prepare"), ("GET", "/api/downloads/files/s1/original"), ("GET", "/api/radio/presets"),
             ("POST", "/api/radio/sessions"), ("GET", "/api/genres"), ("GET", "/api/me/home"), ("POST", "/api/events"),
             ("POST", "/api/library/sync"), ("GET", "/api/favorites"), ("GET", "/api/playlists")]


def test_nothing_works_anonymously_before_setup(fresh):
    c, _, _ = fresh
    for method, path in PROTECTED:
        r = c.request(method, path, json={} if method == "POST" else None)
        assert r.status_code == 401 and r.json()["error"]["code"] == "setup_required", (path, r.status_code)
    assert c.get("/api/auth/status").json() == {"setup_required": True, "signed_in": False, "username": None, "https": False}


def test_setup_token_creates_the_owner_once_and_keeps_the_default_users_history(fresh):
    c, library, engine = fresh
    with engine.begin() as conn:
        default_id = conn.execute(text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        controls = '{"familiarity": 50, "discovery": 50, "continuity": 50, "artist_variety": 50, "genre_variety": 50, "wildcards": 35}'
        conn.execute(text("""INSERT INTO radio_presets (id, user_id, name, base_mode, controls, created_at, updated_at)
                             VALUES (gen_random_uuid(), :u, 'Night Drive', 'panda', CAST(:c AS jsonb), now(), now())"""), {"u": default_id, "c": controls})
    bad = c.post("/api/auth/setup", json={"setup_token": "nope", "username": "panda", "password": PASSWORD})
    assert bad.status_code == 403 and bad.json()["error"]["code"] == "bad_setup_token"
    weak = c.post("/api/auth/setup", json={"setup_token": SETUP_TOKEN, "username": "panda", "password": "short"})
    assert weak.status_code == 422
    body = setup(c)
    cookie = c.cookies.get("pandafm_session")
    set_cookie = " ".join(v for k, v in c.get("/api/auth/status").headers.items() if k == "set-cookie")
    assert cookie and body["csrf_token"] and "refresh_token" not in body or body["refresh_token"] is None
    assert c.get("/api/auth/status").json()["signed_in"] is True
    assert [p["name"] for p in c.get("/api/radio/presets").json() if p["kind"] == "custom"] == ["Night Drive"]  # history kept
    with engine.begin() as conn:
        assert conn.execute(text("SELECT id, username FROM users WHERE password_hash IS NOT NULL")).one() == (default_id, "panda")
        assert conn.execute(text("SELECT password_hash FROM users WHERE id = :u"), {"u": default_id}).scalar().startswith("$argon2id$")
    again = anon(library).post("/api/auth/setup", json={"setup_token": SETUP_TOKEN, "username": "evil", "password": PASSWORD})
    assert again.status_code == 409  # can't claim a configured server, even with the token
    assert anon(library).get("/api/albums", headers={"Authorization": f"Bearer {SETUP_TOKEN}"}).status_code == 401
    assert set_cookie == ""  # status never re-issues cookies


def test_setup_is_impossible_without_a_configured_token(fresh):
    _, library, _ = fresh
    c = real_client(library, setup_token=None)
    r = c.post("/api/auth/setup", json={"setup_token": "anything", "username": "panda", "password": PASSWORD})
    assert r.status_code == 403 and r.json()["error"]["code"] == "setup_disabled"


def test_session_cookie_is_httponly_and_samesite(fresh):
    c, _, _ = fresh
    r = c.post("/api/auth/setup", json={"setup_token": SETUP_TOKEN, "username": "panda", "password": PASSWORD})
    cookies = r.headers.get_list("set-cookie")
    session = next(h for h in cookies if h.startswith("pandafm_session="))
    csrf = next(h for h in cookies if h.startswith("pandafm_csrf="))
    assert "HttpOnly" in session and "samesite=lax" in session.lower() and "Path=/" in session
    assert "HttpOnly" not in csrf  # the page reads it to send X-PandaFM-CSRF
    behind_proxy = real_client(Library(), peer="172.18.0.3")  # pandafm-web, behind the HTTPS reverse proxy
    https = behind_proxy.post("/api/auth/login", json={"username": "panda", "password": PASSWORD}, headers={"X-Forwarded-Proto": "https"})
    assert https.status_code == 200 and all("Secure" in h for h in https.headers.get_list("set-cookie"))
    spoofed = real_client(Library(), peer="203.0.113.9").post("/api/auth/login", json={"username": "panda", "password": PASSWORD},
                                                               headers={"X-Forwarded-Proto": "https"})
    assert not any("Secure" in h for h in spoofed.headers.get_list("set-cookie"))  # a client can't claim HTTPS


def test_login_is_generic_and_rate_limited(fresh):
    c, library, _ = fresh
    setup(c)
    a = anon(library)
    unknown = a.post("/api/auth/login", json={"username": "nobody", "password": PASSWORD})
    wrong = a.post("/api/auth/login", json={"username": "panda", "password": "not the password"})
    assert unknown.status_code == wrong.status_code == 401 and unknown.json() == wrong.json()  # no username enumeration
    for _ in range(5):
        a.post("/api/auth/login", json={"username": "panda", "password": "guess guess guess"})
    locked = a.post("/api/auth/login", json={"username": "panda", "password": PASSWORD})
    assert locked.status_code == 429 and int(locked.headers["Retry-After"]) > 0  # even the right password waits


def test_csrf_protects_cookie_writes_but_not_bearer_writes(fresh):
    c, library, _ = fresh
    body = setup(c)
    preset = {"name": "Commute", "base_mode": "panda", "controls": {"familiarity": 50, "discovery": 50, "continuity": 50, "artist_variety": 50, "genre_variety": 50, "wildcards": 35}}
    no_header = c.post("/api/radio/presets", json=preset)
    assert no_header.status_code == 403 and no_header.json()["error"]["code"] == "csrf_failed"
    assert c.post("/api/radio/presets", json=preset, headers={"X-PandaFM-CSRF": "forged"}).status_code == 403
    assert c.post("/api/radio/presets", json=preset, headers={"X-PandaFM-CSRF": body["csrf_token"]}).status_code == 201
    assert c.get("/api/radio/presets").status_code == 200  # reads need no CSRF token
    token = device(c)["access_token"]
    a = anon(library)
    assert a.post("/api/radio/presets", json={**preset, "name": "Phone"}, headers={"Authorization": f"Bearer {token}"}).status_code == 201


def test_device_tokens_refresh_and_rotate(fresh):
    c, library, _ = fresh
    setup(c)
    d = device(c)
    a = anon(library)
    bearer = {"Authorization": f"Bearer {d['access_token']}"}
    assert a.get("/api/radio/presets", headers=bearer).status_code == 200
    fresh_pair = a.post("/api/auth/refresh", json={"refresh_token": d["refresh_token"]}).json()
    assert fresh_pair["refresh_token"] != d["refresh_token"] and fresh_pair["access_token"] != d["access_token"]
    assert a.get("/api/radio/presets", headers=bearer).status_code == 401  # the old access token is gone
    assert a.post("/api/auth/refresh", json={"refresh_token": d["refresh_token"]}).status_code == 401  # and the old refresh token
    assert a.get("/api/radio/presets", headers={"Authorization": f"Bearer {fresh_pair['access_token']}"}).status_code == 200


def test_logout_revoke_and_sign_out_others_really_end_sessions(fresh):
    c, library, _ = fresh
    body = setup(c)
    csrf = {"X-PandaFM-CSRF": body["csrf_token"]}
    phone, walkman = device(c, "Pixel 9"), device(c, "Sony NW-A306")
    a = anon(library)
    devices = {d["device_name"]: d for d in c.get("/api/auth/devices").json()}
    assert set(devices) >= {"Pixel 9", "Sony NW-A306"} and sum(d["current"] for d in devices.values()) == 1
    assert c.delete(f"/api/auth/devices/{devices['Sony NW-A306']['id']}", headers=csrf).status_code == 204
    assert a.get("/api/albums", headers={"Authorization": f"Bearer {walkman['access_token']}"}).status_code == 401
    assert a.post("/api/auth/refresh", json={"refresh_token": walkman["refresh_token"]}).status_code == 401
    assert c.post("/api/auth/devices/revoke-others", headers=csrf).json() == {"revoked": 1}
    assert a.get("/api/albums", headers={"Authorization": f"Bearer {phone['access_token']}"}).status_code == 401
    assert c.post("/api/auth/logout", headers=csrf).status_code == 204
    assert c.get("/api/radio/presets").status_code == 401


def test_password_change_signs_out_other_devices(fresh):
    c, library, _ = fresh
    body = setup(c)
    csrf = {"X-PandaFM-CSRF": body["csrf_token"]}
    phone = device(c)
    a = anon(library)
    assert c.post("/api/auth/password", json={"current_password": "wrong one!!", "new_password": "a new long password"}, headers=csrf).status_code == 403
    assert c.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "a new long password"}, headers=csrf).status_code == 204
    assert a.get("/api/albums", headers={"Authorization": f"Bearer {phone['access_token']}"}).status_code == 401
    assert c.get("/api/radio/presets").status_code == 200  # this browser stays signed in
    assert a.post("/api/auth/login", json={"username": "panda", "password": PASSWORD}).status_code == 401
    assert a.post("/api/auth/login", json={"username": "panda", "password": "a new long password"}).status_code == 200


def test_expired_sessions_and_access_tokens_stop_working(fresh):
    c, library, engine = fresh
    setup(c)
    d = device(c)
    with engine.begin() as conn:
        conn.execute(text("UPDATE auth_sessions SET access_expires_at = :t WHERE kind = 'device'"), {"t": datetime.now(UTC) - timedelta(seconds=1)})
    expired = anon(library).get("/api/albums", headers={"Authorization": f"Bearer {d['access_token']}"})
    assert expired.status_code == 401 and expired.json()["error"]["code"] == "token_expired"  # the app refreshes
    with engine.begin() as conn:
        conn.execute(text("UPDATE auth_sessions SET last_seen_at = :t WHERE kind = 'browser'"), {"t": datetime.now(UTC) - timedelta(days=31)})
    stale = c.get("/api/radio/presets")
    assert stale.status_code == 401 and stale.json()["error"]["code"] == "session_expired"


def test_tokens_never_appear_in_urls(fresh):
    c, library, _ = fresh
    body = setup(c)
    d = device(c)
    library.songs[0]["suffix"] = "mp3"
    c.post("/api/library/sync", headers={"X-PandaFM-CSRF": body["csrf_token"]})
    manifest = anon(library).post("/api/downloads/prepare", json={"kind": "tracks", "track_ids": ["s1"], "profile": "original"},
                                  headers={"Authorization": f"Bearer {d['access_token']}"})
    text_out = manifest.text
    for secret in (d["access_token"], d["refresh_token"], body["csrf_token"], c.cookies.get("pandafm_session")):
        assert secret not in text_out
    assert all("token" not in item["url"] for item in manifest.json()["items"])
    assert event  # (fixture helper import kept for parity with other DB tests)
