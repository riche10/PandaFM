"""The request guard: who is calling, and is this write really from PandaFM's own page?"""

import hmac
import logging
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service

log = logging.getLogger("pandafm.auth")

SESSION_COOKIE = "pandafm_session"
CSRF_COOKIE = "pandafm_csrf"
CSRF_HEADER = "x-pandafm-csrf"
UNSAFE = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class AuthError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status, self.code, self.retry_after = status, code, retry_after


@dataclass(frozen=True)
class AuthContext:
    user_id: int
    session_id: UUID
    via: Literal["cookie", "bearer"]


def bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() or None if scheme.lower() == "bearer" else None


async def authenticate_request(request: Request, db: AsyncSession, required: bool = True) -> AuthContext | None:
    cached = getattr(request.state, "auth", None)
    if cached is not None:
        return cached
    bearer = bearer_token(request)
    cookie = None if bearer else request.cookies.get(SESSION_COOKIE)
    if not bearer and not cookie:
        if not required:
            return None
        try:
            unset = await service.owner(db) is None
        except Exception:  # noqa: BLE001  (database down: still just "not signed in")
            unset = False
        if unset:
            raise AuthError(401, "setup_required", "PandaFM needs to be set up first.")
        raise AuthError(401, "not_signed_in", "Sign in to PandaFM.")
    session = await service.resolve(db, cookie=cookie, bearer=bearer)
    if session is None:
        if not required:
            return None
        raise AuthError(401, "token_expired" if bearer else "session_expired", "Your PandaFM session has ended. Sign in again.")
    if cookie and request.method in UNSAFE:
        # Cookies ride along with any request; a write must also prove it came from PandaFM's page.
        sent = request.headers.get(CSRF_HEADER, "")
        if not session.csrf_token or not hmac.compare_digest(sent, session.csrf_token):
            log.warning("Rejected a write without a valid CSRF token (%s %s)", request.method, request.url.path)
            raise AuthError(403, "csrf_failed", "This request didn’t come from PandaFM. Reload the page and try again.")
    ctx = AuthContext(session.user_id, session.id, "bearer" if bearer else "cookie")
    request.state.auth = ctx
    return ctx


async def optional_context(request: Request) -> AuthContext | None:
    """For public routes that show more to the owner: never raises, opens no session without a credential."""
    if not bearer_token(request) and not request.cookies.get(SESSION_COOKIE):
        return None
    try:
        async with request.app.state.session_factory() as db:
            return await authenticate_request(request, db, required=False)
    except Exception:  # noqa: BLE001
        return None
