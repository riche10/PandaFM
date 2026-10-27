"""PandaFM's installation key and authenticated encryption for stored secrets (5.3).

The key is 32 random bytes created on first start in the config volume
(`<config_dir>/installation.key`, mode 0600), or supplied as PANDAFM_CONFIG_KEY.
Secrets (the music server password) are stored in PostgreSQL only as
AES-256-GCM ciphertext: a fresh 96-bit nonce per value, and a purpose label
bound in as associated data so a value can't be replayed into another field.
The database alone doesn't reveal them; losing both the key and the database
loses the configuration (back up the config volume with the database).
"""

import base64
import binascii
import hashlib
import logging
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger("pandafm.vault")
KEY_FILE = "installation.key"
PREFIX = "v1"


class VaultError(Exception):
    """The key is missing, unwritable or different from the one that encrypted a value."""


def _decode_key(text: str) -> bytes:
    text = text.strip()
    for decode in (lambda t: base64.urlsafe_b64decode(t + "=" * (-len(t) % 4)), bytes.fromhex):
        try:
            key = decode(text)
        except (binascii.Error, ValueError):
            continue
        if len(key) == 32:
            return key
    raise VaultError("PANDAFM_CONFIG_KEY must be 32 bytes, as base64 or hex (e.g. `openssl rand -base64 32`).")


def load_key(config_dir: str | Path, override: str | None = None) -> bytes:
    """The installation key: from the override, the key file, or a new one written to the key file."""
    if override:
        return _decode_key(override)
    path = Path(config_dir) / KEY_FILE
    if path.exists():
        return _decode_key(path.read_text())
    key = os.urandom(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:  # another worker created it first: use theirs
        return _decode_key(path.read_text())
    except OSError as exc:
        raise VaultError(f"PandaFM can't write its installation key to {path.parent} ({exc.strerror}). Mount a writable config volume there.") from exc
    with os.fdopen(fd, "w") as out:
        out.write(base64.urlsafe_b64encode(key).decode())
    log.info("Created PandaFM's installation key in %s (back this up with the database)", path.parent)
    return key


class Vault:
    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise VaultError("The installation key must be 32 bytes.")
        self._aead = AESGCM(key)
        self.key_id = hashlib.sha256(b"pandafm-key-id:" + key).hexdigest()[:16]  # identifies the key, reveals nothing

    def encrypt(self, plaintext: str, purpose: str) -> str:
        nonce = os.urandom(12)
        sealed = self._aead.encrypt(nonce, plaintext.encode(), purpose.encode())
        return f"{PREFIX}:{self.key_id}:{base64.urlsafe_b64encode(nonce + sealed).decode()}"

    def decrypt(self, token: str, purpose: str) -> str:
        try:
            prefix, key_id, body = token.split(":", 2)
        except ValueError as exc:
            raise VaultError("That stored secret isn't in a format PandaFM understands.") from exc
        if prefix != PREFIX:
            raise VaultError("That stored secret isn't in a format PandaFM understands.")
        if key_id != self.key_id:
            raise VaultError("PandaFM's installation key changed since this was saved; enter the password again.")
        raw = base64.urlsafe_b64decode(body)
        try:
            return self._aead.decrypt(raw[:12], raw[12:], purpose.encode()).decode()
        except Exception as exc:  # InvalidTag: tampered, or the wrong purpose
            raise VaultError("A stored secret couldn't be decrypted (it was changed or belongs elsewhere).") from exc
