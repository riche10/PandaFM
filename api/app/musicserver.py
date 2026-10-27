"""PandaFM's music server (5.3): an external Navidrome / OpenSubsonic server, set up at runtime.

PandaFM no longer bundles Navidrome. The owner enters the server during
first-run setup (or later in Settings); it is stored in PandaFM's database with
the password encrypted (AES-GCM). The key comes from PANDAFM_SECRET_KEY, or is
generated once into PANDAFM_DATA_DIR/secret.key (owner-only file permissions).

Legacy installs that still set PANDAFM_NAVIDROME_URL/USER/PASSWORD keep
working: while those are set they win, and they are copied (encrypted) into the
database, so removing them later hands management over to the app.
"""

import base64
import hashlib
import logging
import os
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import MusicServer
from app.navidrome.client import NavidromeClient, NavidromeError

log = logging.getLogger("pandafm.musicserver")


class SecretBox:
    """Encrypts the stored music-server password (never logged, never sent to clients)."""

    def __init__(self, secret: str | None, data_dir: str | Path) -> None:
        self.ephemeral = False
        if secret:
            self._key = hashlib.sha256(secret.encode()).digest()
            return
        try:
            self._key = self._key_file(Path(data_dir))
        except OSError as exc:  # never stop PandaFM from starting over this
            self._key = os.urandom(32)
            self.ephemeral = True
            log.warning("Can't keep a secret key in %s (%s): a stored music-server password won't survive a restart. "
                        "Set PANDAFM_SECRET_KEY or give PandaFM a writable PANDAFM_DATA_DIR.", data_dir, exc)

    @staticmethod
    def _key_file(data_dir: Path) -> bytes:
        if True:  # noqa: SIM108
            path = data_dir / "secret.key"
            if path.exists():
                return path.read_bytes()[:32]
            path.parent.mkdir(parents=True, exist_ok=True)
            key = os.urandom(32)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(key)
            log.info("Generated PandaFM's secret key at %s (keep this volume: it unlocks the stored music-server password)", path)
            return key

    def seal(self, text: str) -> str:
        nonce = os.urandom(12)
        return "v1:" + base64.urlsafe_b64encode(nonce + AESGCM(self._key).encrypt(nonce, text.encode(), b"pandafm-music-server")).decode()

    def open(self, sealed: str) -> str | None:
        try:
            raw = base64.urlsafe_b64decode(sealed.split(":", 1)[1])
            return AESGCM(self._key).decrypt(raw[:12], raw[12:], b"pandafm-music-server").decode()
        except (InvalidTag, ValueError, IndexError):
            return None  # a different key (e.g. the data volume was replaced): the owner re-enters the password


class _NotConfigured:
    """Stands in for the client until a music server is set up: every call says so plainly."""

    def __getattr__(self, name: str):
        async def missing(*args, **kwargs):
            raise NavidromeError("No music server is set up yet. Connect one in PandaFM’s setup or Settings.")
        return missing


class MusicServerHolder:
    """What every part of PandaFM uses as 'the Navidrome client': swappable at runtime."""

    def __init__(self, timeout: float) -> None:
        self.timeout = timeout
        self._client: NavidromeClient | _NotConfigured = _NotConfigured()
        self.url: str | None = None
        self.username: str | None = None
        self.managed_by_env = False

    @property
    def configured(self) -> bool:
        return isinstance(self._client, NavidromeClient)

    async def configure(self, url: str, username: str, password: str) -> None:
        old = self._client
        self._client = NavidromeClient(url, username, password, timeout=self.timeout)
        self.url, self.username = url, username
        if isinstance(old, NavidromeClient):
            await old.aclose()

    async def aclose(self) -> None:
        if isinstance(self._client, NavidromeClient):
            await self._client.aclose()

    def __getattr__(self, name: str):
        return getattr(self._client, name)


async def test_connection(url: str, username: str, password: str, timeout: float) -> str | None:
    """None when PandaFM can sign in to the server; otherwise a plain explanation."""
    client = NavidromeClient(url, username, password, timeout=timeout)
    try:
        await client.ping()
        return None
    except NavidromeError as exc:
        return str(exc) or "PandaFM couldn’t sign in to that server."
    finally:
        await client.aclose()


async def load(holder: MusicServerHolder, sessions: async_sessionmaker[AsyncSession], box: SecretBox, cfg) -> None:
    """At startup: legacy environment settings (copied into the database), else the stored server."""
    env_password = cfg.navidrome_password.get_secret_value() if cfg.navidrome_password else None
    async with sessions() as db:
        row = (await db.execute(select(MusicServer).where(MusicServer.id == 1))).scalar_one_or_none()
        if cfg.navidrome_user and env_password:  # legacy: the old default URL still applies
            url = (cfg.navidrome_url or "http://localhost:4533").rstrip("/")
            if row is None:
                db.add(MusicServer(id=1, url=url, username=cfg.navidrome_user, password_sealed=box.seal(env_password)))
                log.info("Copied the music server from PANDAFM_NAVIDROME_* into PandaFM's database (password encrypted)")
            else:
                row.url, row.username, row.password_sealed = url, cfg.navidrome_user, box.seal(env_password)
            await db.commit()
            holder.managed_by_env = True
            await holder.configure(url, cfg.navidrome_user, env_password)
            return
        if row is None:
            log.warning("No music server is set up yet: the owner connects one during setup or in Settings")
            return
        password = box.open(row.password_sealed)
        if password is None:
            log.warning("The stored music-server password can't be decrypted (was the secret key changed?); re-enter it in Settings")
            holder.url, holder.username = row.url, row.username
            return
        await holder.configure(row.url, row.username, password)


async def save(holder: MusicServerHolder, db: AsyncSession, box: SecretBox, url: str, username: str, password: str) -> None:
    row = (await db.execute(select(MusicServer).where(MusicServer.id == 1))).scalar_one_or_none()
    if row is None:
        db.add(MusicServer(id=1, url=url, username=username, password_sealed=box.seal(password)))
    else:
        row.url, row.username, row.password_sealed = url, username, box.seal(password)
    await db.commit()
    await holder.configure(url, username, password)


async def stored_password(db: AsyncSession, box: SecretBox) -> str | None:
    row = (await db.execute(select(MusicServer).where(MusicServer.id == 1))).scalar_one_or_none()
    return box.open(row.password_sealed) if row else None
