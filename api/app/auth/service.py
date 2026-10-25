"""Owner account, browser sessions and device sessions (PostgreSQL).

Tokens are random and opaque; only their SHA-256 hashes are stored, so a
database leak doesn't hand out sessions, and revoking a row is immediate.
- browser: one session token in an HttpOnly cookie, plus a CSRF token.
- device (Android): a long-lived refresh token (rotated on every use) and a
  15-minute access token sent as 'Authorization: Bearer'.
"""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.passwords import hash_password, needs_rehash, verify_password
from app.models import AuthSession, User

BROWSER_IDLE = timedelta(days=30)
BROWSER_MAX_AGE = timedelta(days=180)
DEVICE_IDLE = timedelta(days=90)
ACCESS_TTL = timedelta(minutes=15)
TOUCH_EVERY = timedelta(seconds=60)


def now() -> datetime:
    return datetime.now(UTC)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def owner(db: AsyncSession) -> User | None:
    return await db.scalar(select(User).where(User.password_hash.is_not(None)).order_by(User.id).limit(1))


async def setup_owner(db: AsyncSession, username: str, password: str) -> User:
    """Turn the existing default user into the owner, so all listening history, stations and presets stay theirs."""
    user = await db.scalar(select(User).order_by(User.id).limit(1))
    if user is None:
        user = User(username=username)
        db.add(user)
    user.username = username
    user.password_hash = hash_password(password)
    user.password_changed_at = now()
    await db.commit()
    await db.refresh(user)
    return user


async def authenticate(db: AsyncSession, username: str, password: str) -> User | None:
    user = await db.scalar(select(User).where(User.username.ilike(username.strip()), User.password_hash.is_not(None)))
    if not verify_password(user.password_hash if user else None, password):
        return None
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
        await db.commit()
    return user


@dataclass
class Issued:
    session: AuthSession
    token: str  # browser: cookie value; device: refresh token
    csrf: str | None = None
    access: str | None = None
    access_expires: datetime | None = None


async def start_session(db: AsyncSession, user: User, kind: str, device_name: str, platform: str, user_agent: str) -> Issued:
    token, t = new_token(), now()
    s = AuthSession(id=uuid4(), user_id=user.id, kind=kind, token_hash=digest(token), device_name=device_name[:80] or "Unknown device",
                    platform=platform[:24] or "web", user_agent=user_agent[:120], created_at=t, last_seen_at=t,
                    expires_at=t + (BROWSER_MAX_AGE if kind == "browser" else DEVICE_IDLE))
    issued = Issued(s, token)
    if kind == "browser":
        issued.csrf = s.csrf_token = new_token()
    else:
        issued.access, issued.access_expires = new_token(), t + ACCESS_TTL
        s.access_hash, s.access_expires_at = digest(issued.access), issued.access_expires
    db.add(s)
    await db.commit()
    return issued


def _live(s: AuthSession | None, t: datetime) -> bool:
    if s is None or s.revoked_at is not None or s.expires_at <= t:
        return False
    idle = BROWSER_IDLE if s.kind == "browser" else DEVICE_IDLE
    return t - s.last_seen_at < idle


async def resolve(db: AsyncSession, *, cookie: str | None = None, bearer: str | None = None) -> AuthSession | None:
    t = now()
    if bearer:
        s = await db.scalar(select(AuthSession).where(AuthSession.access_hash == digest(bearer), AuthSession.kind == "device"))
        if not _live(s, t) or s.access_expires_at is None or s.access_expires_at <= t:
            return None
    elif cookie:
        s = await db.scalar(select(AuthSession).where(AuthSession.token_hash == digest(cookie), AuthSession.kind == "browser"))
        if not _live(s, t):
            return None
    else:
        return None
    if t - s.last_seen_at > TOUCH_EVERY:  # activity, without a write per request
        s.last_seen_at = t
        if s.kind == "device":
            s.expires_at = t + DEVICE_IDLE
        await db.commit()
    return s


async def refresh(db: AsyncSession, refresh_token: str) -> Issued | None:
    """A device trades its refresh token for a new pair; the old refresh token stops working."""
    t = now()
    s = await db.scalar(select(AuthSession).where(AuthSession.token_hash == digest(refresh_token), AuthSession.kind == "device"))
    if not _live(s, t):
        return None
    issued = Issued(s, new_token(), access=new_token(), access_expires=t + ACCESS_TTL)
    # Atomic rotation: only the request still holding the current refresh token wins; a
    # simultaneous second refresh with the same token finds nothing to update (5.0.1).
    won = await db.execute(
        update(AuthSession)
        .where(AuthSession.id == s.id, AuthSession.token_hash == digest(refresh_token), AuthSession.revoked_at.is_(None))
        .values(token_hash=digest(issued.token), access_hash=digest(issued.access), access_expires_at=issued.access_expires,
                last_seen_at=t, expires_at=t + DEVICE_IDLE)
        .returning(AuthSession.id)
    )
    if won.first() is None:
        await db.rollback()
        return None
    await db.commit()
    await db.refresh(s)
    return issued


async def revoke(db: AsyncSession, user_id: int, session_id: UUID) -> bool:
    result = await db.execute(update(AuthSession).where(AuthSession.id == session_id, AuthSession.user_id == user_id,
                                                        AuthSession.revoked_at.is_(None)).values(revoked_at=now()))
    await db.commit()
    return result.rowcount > 0


async def revoke_others(db: AsyncSession, user_id: int, keep: UUID | None) -> int:
    q = update(AuthSession).where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
    if keep is not None:
        q = q.where(AuthSession.id != keep)
    result = await db.execute(q.values(revoked_at=now()))
    await db.commit()
    return result.rowcount


async def devices(db: AsyncSession, user_id: int) -> list[AuthSession]:
    t = now()
    rows = (await db.execute(select(AuthSession).where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
                             .order_by(AuthSession.last_seen_at.desc()))).scalars()
    return [s for s in rows if _live(s, t)]


async def change_password(db: AsyncSession, user_id: int, current: str, new: str, keep: UUID) -> bool:
    user = await db.get(User, user_id)
    if user is None or not verify_password(user.password_hash, current):
        return False
    user.password_hash = hash_password(new)
    user.password_changed_at = now()
    await db.commit()
    await revoke_others(db, user_id, keep)  # every other device must sign in again
    return True
