"""A fake Navidrome for tests, built on httpx.MockTransport.

Fixtures in tests/fixtures/ are real Navidrome 0.64.2 responses (trimmed),
so parsing is tested against what the server actually sends.
"""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.deps import get_navidrome
from app.main import create_app
from app.navidrome.client import NavidromeClient

FIXTURES = Path(__file__).parent / "fixtures"
PASSWORD = "bamboo-test"

Handler = Callable[[httpx.Request], httpx.Response]


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def subsonic_error(code: int, message: str) -> dict[str, Any]:
    return {
        "subsonic-response": {
            "status": "failed",
            "version": "1.16.1",
            "type": "navidrome",
            "serverVersion": "0.64.2 (10114574)",
            "openSubsonic": True,
            "error": {"code": code, "message": message},
        }
    }


class FakeNavidrome:
    """Answers /rest/<endpoint> with whatever each test registers."""

    def __init__(self) -> None:
        self.routes: dict[str, Handler] = {}
        self.requests: list[httpx.Request] = []

    def json(self, endpoint: str, body: dict[str, Any]) -> "FakeNavidrome":
        self.routes[endpoint] = lambda request: httpx.Response(200, json=body)
        return self

    def handle(self, endpoint: str, handler: Handler) -> "FakeNavidrome":
        self.routes[endpoint] = handler
        return self

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        endpoint = request.url.path.removeprefix("/rest/")
        if endpoint not in self.routes:
            raise AssertionError(f"Unexpected Navidrome call: {endpoint}")
        return self.routes[endpoint](request)

    def client(self) -> NavidromeClient:
        return NavidromeClient(
            "http://navidrome:4533", "panda", PASSWORD, transport=httpx.MockTransport(self)
        )

    def last(self, endpoint: str) -> httpx.Request:
        matching = [r for r in self.requests if r.url.path == f"/rest/{endpoint}"]
        assert matching, f"Navidrome was never asked for {endpoint}"
        return matching[-1]

    def secrets_sent(self) -> set[str]:
        """Every credential value that went to Navidrome, for leak checks."""
        values = {PASSWORD}
        for request in self.requests:
            values.update({request.url.params["t"], request.url.params["s"]})
        return values


def api_client(fake: FakeNavidrome) -> TestClient:
    """The real PandaFM app with Navidrome replaced by the fake."""
    settings = Settings(
        navidrome_user="panda",
        navidrome_password=SecretStr(PASSWORD),
        db_host="127.0.0.1",
        db_port=1,
        background_sync=False,
    )
    app = create_app(settings)
    client = fake.client()
    app.dependency_overrides[get_navidrome] = lambda: client
    return TestClient(app)


def assert_no_secrets(fake: FakeNavidrome, response: httpx.Response) -> None:
    exposed = response.text + " " + " ".join(f"{k}: {v}" for k, v in response.headers.items())
    for secret in fake.secrets_sent():
        assert secret not in exposed, "a Navidrome credential leaked into an API response"
