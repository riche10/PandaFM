"""The music server PandaFM reads from (5.3): an existing Navidrome/OpenSubsonic server.

Configured by the owner in the app (first-run setup or Settings › Music
server), stored with the password encrypted (app.vault). Legacy environment
variables (≤5.2) are imported once, only when nothing is saved yet; after that
the saved configuration always wins.
"""

import asyncio
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import MusicServerConfig
from app.navidrome.client import NavidromeAuthError, NavidromeClient, NavidromeError, NavidromeUnavailable
from app.navidrome.handle import NavidromeHandle
from app.vault import Vault, VaultError, load_key

log = logging.getLogger("pandafm.music_server")
PURPOSE = "music-server-password"


class BadUrl(ValueError):
    pass


def normalize_url(raw: str) -> str:
    """'music.example.com/' → 'https://music.example.com'. Keeps a sub-path; drops a pasted /rest."""
    text = (raw or "").strip()
    if not text:
        raise BadUrl("Enter your music server’s address.")
    if "://" not in text:
        text = "https://" + text
    parts = urlsplit(text)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise BadUrl("That doesn’t look like a web address (use https://… or http://…).")
    if parts.username or parts.password:
        raise BadUrl("Leave the username and password out of the address.")
    path = parts.path.rstrip("/")
    if path.endswith("/rest"):
        path = path[: -len("/rest")]
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{parts.hostname}{port}{path}"


@dataclass
class TestResult:
    ok: bool
    kind: str  # ok | bad_url | unreachable | bad_credentials | not_subsonic
    message: str
    url: str | None = None
    server_type: str | None = None
    server_version: str | None = None
    api_version: str | None = None
    open_subsonic: bool | None = None


MESSAGES = {
    "ok": "Connected.",
    "unreachable": "PandaFM couldn’t reach that server. Check the address, and that it’s reachable from the PandaFM server.",
    "bad_credentials": "The music server rejected that username or password.",
    "not_subsonic": "That server answered, but it doesn’t appear to provide the music API PandaFM needs (Navidrome or another OpenSubsonic server).",
}


async def test_connection(raw_url: str, username: str, password: str, transport: httpx.AsyncBaseTransport | None = None) -> TestResult:
    """Reachable? Credentials accepted? Does the library API PandaFM uses work? Never echoes the password."""
    try:
        url = normalize_url(raw_url)
    except BadUrl as exc:
        return TestResult(False, "bad_url", str(exc))
    # First, without credentials: is anything there, and does it speak the Subsonic API at all?
    # (A stranger's web server never sees the password.)
    async with httpx.AsyncClient(timeout=8.0, transport=transport, headers={"User-Agent": "PandaFM"}) as http:
        try:
            probe = await http.get(f"{url}/rest/ping", params={"f": "json", "v": "1.16.1", "c": "PandaFM"})
        except httpx.HTTPError:
            return TestResult(False, "unreachable", MESSAGES["unreachable"], url)
    try:
        envelope = probe.json()["subsonic-response"]
        if not isinstance(envelope, dict):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        return TestResult(False, "not_subsonic", MESSAGES["not_subsonic"], url)
    client = NavidromeClient(url, username, password, timeout=8.0, transport=transport)
    try:
        info = await client.ping()
        await client._call("getMusicFolders")  # a library call PandaFM relies on, not just ping
        name = (info.server_type or "OpenSubsonic server").replace("navidrome", "Navidrome")
        return TestResult(True, "ok", f"Connected to {name}{' ' + info.server_version if info.server_version else ''}.", url,
                          info.server_type, info.server_version, info.api_version, info.open_subsonic)
    except NavidromeAuthError:
        return TestResult(False, "bad_credentials", MESSAGES["bad_credentials"], url)
    except NavidromeUnavailable:
        return TestResult(False, "unreachable", MESSAGES["unreachable"], url)
    except (NavidromeError, ValueError, KeyError, TypeError, httpx.HTTPError):
        return TestResult(False, "not_subsonic", MESSAGES["not_subsonic"], url)
    finally:
        await client.aclose()


class MusicServerManager:
    def __init__(self, handle: NavidromeHandle, sessions: async_sessionmaker[AsyncSession], config_dir: str, config_key: str | None, timeout: float = 10.0, stream_timeout: float = 30.0) -> None:
        self.handle = handle
        self._sessions = sessions
        self._config_dir = config_dir
        self._config_key = config_key
        self._timeout = timeout
        self._stream_timeout = stream_timeout
        self._vault: Vault | None = None
        self.transport: httpx.AsyncBaseTransport | None = None  # tests inject a fake music server here
        self.url: str | None = None
        self.username: str | None = None
        self.problem: str | None = None  # why a saved configuration couldn't be used (never a secret)

    def vault(self) -> Vault:
        if self._vault is None:
            self._vault = Vault(load_key(self._config_dir, self._config_key))
        return self._vault

    def _use(self, url: str, username: str, password: str) -> None:
        old = self.handle.swap(NavidromeClient(url, username, password, timeout=self._timeout, transport=self.transport, stream_timeout=self._stream_timeout))
        self.url, self.username = url, username
        if old is not None:
            asyncio.get_running_loop().create_task(old.aclose())  # in-flight streams finish on the old client

    async def load(self, legacy_url: str | None, legacy_user: str | None, legacy_password: str | None) -> None:
        """At startup: the saved configuration, or (only if none) an import of the legacy environment variables."""
        try:
            async with self._sessions() as db:
                row = await db.get(MusicServerConfig, 1)
        except Exception as exc:  # noqa: BLE001  (e.g. migrations not applied yet: PandaFM still starts)
            log.warning("Couldn't read the saved music server configuration: %s", exc.__class__.__name__)
            return
        if row is not None:
            try:
                self._use(row.server_url, row.username, self.vault().decrypt(row.password_enc, PURPOSE))
                self.problem = None
                log.info("Music server: %s (as %s)", row.server_url, row.username)
            except VaultError as exc:
                self.problem = str(exc)
                self.url, self.username = row.server_url, row.username
                log.error("The saved music server password can't be used: %s", exc)
            return
        if legacy_user and legacy_password and legacy_url:
            await self.import_legacy(legacy_url, legacy_user, legacy_password)
        elif legacy_user or legacy_password:
            log.warning("Found PANDAFM_NAVIDROME_USER/PASSWORD but no PANDAFM_NAVIDROME_URL; connect the music server in PandaFM's setup instead.")

    async def import_legacy(self, url: str, user: str, password: str) -> None:
        """≤5.2 upgrade: keep working with the old environment variables and save them (encrypted), once."""
        try:
            url = normalize_url(url)
        except BadUrl:
            log.warning("PANDAFM_NAVIDROME_URL isn't a usable address; connect the music server in PandaFM instead.")
            return
        self._use(url, user, password)  # keep playing even if the check below can't reach the server right now
        result = await test_connection(url, user, password, self.transport)
        try:
            await self._store(url, user, password, result, source="environment")
            log.info("Imported the music server settings from the environment (%s). From now on, change them in PandaFM.", url)
        except VaultError as exc:
            log.error("Using the music server from the environment, but couldn't save it: %s", exc)

    async def save(self, url: str, username: str, password: str | None, result: TestResult, source: str) -> None:
        """Save a tested configuration. password=None keeps the stored one (only for the same server)."""
        if password is None:
            password = await self.stored_password()
            if password is None:
                raise VaultError("Enter the music server password.")
        await self._store(url, username, password, result, source)
        self._use(url, username, password)
        self.problem = None

    async def stored_password(self) -> str | None:
        async with self._sessions() as db:
            row = await db.get(MusicServerConfig, 1)
        return self.vault().decrypt(row.password_enc, PURPOSE) if row else None

    async def _store(self, url: str, username: str, password: str, result: TestResult, source: str) -> None:
        sealed = self.vault().encrypt(password, PURPOSE)
        now = datetime.now(timezone.utc)
        async with self._sessions() as db:
            row = await db.get(MusicServerConfig, 1)
            if row is None:
                row = MusicServerConfig(id=1)
                db.add(row)
            row.server_url, row.username, row.password_enc, row.key_id = url, username, sealed, self.vault().key_id
            row.server_type, row.server_version, row.api_version = result.server_type, result.server_version, result.api_version
            row.open_subsonic, row.source, row.updated_at = result.open_subsonic, source, now
            if result.ok:
                row.verified_at = now
            await db.commit()

    async def describe(self, db: AsyncSession) -> dict:
        """For the owner: what's configured (never the password)."""
        row = await db.get(MusicServerConfig, 1)
        if row is None:
            return {"configured": self.handle.configured, "url": self.url, "username": self.username, "source": "environment" if self.handle.configured else None}
        return {"configured": self.handle.configured, "url": row.server_url, "username": row.username, "server_type": row.server_type,
                "server_version": row.server_version, "api_version": row.api_version, "open_subsonic": row.open_subsonic, "source": row.source,
                "verified_at": row.verified_at.isoformat() if row.verified_at else None, "problem": self.problem}


async def configured(db: AsyncSession) -> bool:
    return (await db.execute(select(MusicServerConfig.id))).first() is not None


def result_dict(result: TestResult) -> dict:
    return asdict(result)
