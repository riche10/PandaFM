"""Owner passwords, hashed with Argon2id (argon2-cffi defaults, RFC 9106). Never stored in plain text."""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_hasher = PasswordHasher()  # Argon2id
_TIMING = _hasher.hash("pandafm: equal work when the user doesn't exist")
MIN_LENGTH = 10
MAX_LENGTH = 256


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored: str | None, attempt: str) -> bool:
    """Constant-ish work whether or not the account exists (no username enumeration by timing)."""
    try:
        return _hasher.verify(stored or _TIMING, attempt) and stored is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored: str) -> bool:
    return _hasher.check_needs_rehash(stored)


def weakness(password: str) -> str | None:
    if len(password) < MIN_LENGTH:
        return f"Use at least {MIN_LENGTH} characters."
    if len(password) > MAX_LENGTH:
        return "That password is too long."
    return None
