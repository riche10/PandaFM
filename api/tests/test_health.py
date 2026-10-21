"""Health endpoint tests: real app, fake Navidrome, unreachable database."""

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.db import create_engine
from app.deps import get_db_engine, get_navidrome
from app.main import create_app
from app.navidrome.client import NavidromeClient
from tests.test_navidrome_client import PING_OK, failed

# Port 1 on localhost refuses connections immediately: a "database is down" stand-in.
SETTINGS = Settings(
    navidrome_user="panda",
    navidrome_password=SecretStr("bamboo-test"),
    db_host="127.0.0.1",
    db_port=1,
)


def client_with_navidrome(body: dict) -> TestClient:
    app = create_app(SETTINGS)
    fake = NavidromeClient(
        "http://navidrome:4533",
        "panda",
        "bamboo-test",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body)),
    )
    app.dependency_overrides[get_navidrome] = lambda: fake
    app.dependency_overrides[get_db_engine] = lambda: create_engine(SETTINGS)
    return TestClient(app)


def test_health_reports_each_dependency_separately():
    with client_with_navidrome(PING_OK) as client:
        response = client.get("/api/health")

    assert response.status_code == 200  # alive even when degraded
    body = response.json()
    assert body["status"] == "degraded"
    assert body["navidrome"]["ok"] is True
    assert body["navidrome"]["server_type"] == "navidrome"
    assert body["database"]["ok"] is False
    assert body["database"]["detail"]


def test_health_explains_bad_navidrome_credentials():
    with client_with_navidrome(failed(40, "Wrong username or password")) as client:
        body = client.get("/api/health").json()

    assert body["navidrome"]["ok"] is False
    assert "NAVIDROME_USER" in body["navidrome"]["detail"]
