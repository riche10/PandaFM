"""Sign-in, first-time setup and devices.

Public: status, setup (needs the administrator's setup token, only until an
owner exists), login and refresh. Everything else needs a signed-in session.
Passwords and tokens are never logged.
"""

import hmac
import logging
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from app.auth import service
from app.auth.limits import private_address
from app.auth.guard import CSRF_COOKIE, SESSION_COOKIE, AuthContext, AuthError, authenticate_request
from app.auth.limits import LoginLimiter, client_ip, is_https, parse_networks
from app.auth.passwords import weakness
from app.config import get_settings
from app.deps import SessionDep, require_auth

log = logging.getLogger("pandafm.auth")
router = APIRouter(prefix="/auth", tags=["auth"])
Auth = Annotated[AuthContext, Depends(require_auth)]
Username = Annotated[str, Field(min_length=2, max_length=64, pattern=r"^[A-Za-z0-9._@-]+$")]


class StatusOut(BaseModel):
    setup_required: bool
    signed_in: bool
    username: str | None = None
    https: bool


class Credentials(BaseModel):
    username: Annotated[str, Field(min_length=1, max_length=64)]
    password: Annotated[str, Field(min_length=1, max_length=256)]
    client: Literal["browser", "device"] = "browser"
    device_name: Annotated[str, Field(max_length=80)] = ""
    platform: Annotated[str, Field(max_length=24)] = ""


class SetupIn(BaseModel):
    setup_token: Annotated[str, Field(max_length=256)] = ""  # needed only when PANDAFM_SETUP_TOKEN is set (5.3)
    username: Username
    password: Annotated[str, Field(min_length=1, max_length=256)]
    client: Literal["browser", "device"] = "browser"
    device_name: Annotated[str, Field(max_length=80)] = ""
    platform: Annotated[str, Field(max_length=24)] = ""


class SignedIn(BaseModel):
    username: str
    session_id: UUID
    csrf_token: str | None = None  # browser: send it back as X-PandaFM-CSRF on writes
    access_token: str | None = None  # device: short-lived, Authorization: Bearer
    access_expires_in: int | None = None
    refresh_token: str | None = None  # device: keep it encrypted (Android Keystore)


class RefreshIn(BaseModel):
    refresh_token: Annotated[str, Field(min_length=10, max_length=256)]


class PasswordIn(BaseModel):
    current_password: Annotated[str, Field(min_length=1, max_length=256)]
    new_password: Annotated[str, Field(min_length=1, max_length=256)]


class Device(BaseModel):
    id: UUID
    device_name: str
    platform: str
    kind: str
    created_at: datetime
    last_seen_at: datetime
    current: bool


class Me(BaseModel):
    username: str
    session_id: UUID
    via: str


def _settings(request: Request):
    return getattr(request.app.state, "settings", None) or get_settings()


def _trusted(request: Request):
    nets = getattr(request.app.state, "trusted_networks", None)
    if nets is None:
        nets = request.app.state.trusted_networks = parse_networks(_settings(request).trusted_proxies)
    return nets


def _limiter(request: Request) -> LoginLimiter:
    if not hasattr(request.app.state, "login_limiter"):
        request.app.state.login_limiter = LoginLimiter()
    return request.app.state.login_limiter


def _ip(request: Request) -> str:
    return client_ip(request.client.host if request.client else None, request.headers.get("x-forwarded-for"), _trusted(request))


def _https(request: Request) -> bool:
    return is_https(request.url.scheme, request.headers.get("x-forwarded-proto"), request.client.host if request.client else None, _trusted(request))


def _browser_name(request: Request) -> str:
    ua = request.headers.get("user-agent", "")
    browser = next((b for b in ("Edg", "Firefox", "Chrome", "Safari") if b in ua), "Browser").replace("Edg", "Edge")
    system = next((s for s in ("Android", "iPhone", "iPad", "Windows", "Mac OS", "Linux", "CrOS") if s in ua), "")
    system = {"Mac OS": "macOS", "CrOS": "ChromeOS"}.get(system, system)
    return f"{browser} on {system}" if system else browser


async def _signed_in(request: Request, response: Response, db, user, client: str, device_name: str, platform: str) -> SignedIn:
    if client == "browser":
        issued = await service.start_session(db, user, "browser", device_name or _browser_name(request), platform or "web", request.headers.get("user-agent", ""))
        secure = _https(request)
        age = int(service.BROWSER_IDLE.total_seconds())
        response.set_cookie(SESSION_COOKIE, issued.token, max_age=age, httponly=True, secure=secure, samesite="lax", path="/")
        response.set_cookie(CSRF_COOKIE, issued.csrf, max_age=age, httponly=False, secure=secure, samesite="lax", path="/")
        return SignedIn(username=user.username, session_id=issued.session.id, csrf_token=issued.csrf)
    issued = await service.start_session(db, user, "device", device_name or "Android device", platform or "android", request.headers.get("user-agent", ""))
    return SignedIn(username=user.username, session_id=issued.session.id, access_token=issued.access,
                    access_expires_in=int(service.ACCESS_TTL.total_seconds()), refresh_token=issued.token)


def _forget_cookies(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


@router.get("/status", response_model=StatusOut)
async def status(request: Request, db: SessionDep) -> StatusOut:
    owner = await service.owner(db)
    ctx = await authenticate_request(request, db, required=False) if owner else None
    return StatusOut(setup_required=owner is None, signed_in=ctx is not None, username=owner.username if ctx and owner else None, https=_https(request))


@router.post("/setup", response_model=SignedIn)
async def setup(body: SetupIn, request: Request, response: Response, db: SessionDep) -> SignedIn:
    ip = _ip(request)
    limiter = _limiter(request)
    if wait := limiter.retry_after(ip, "setup"):
        raise AuthError(429, "too_many_attempts", "Too many attempts. Wait a moment and try again.", retry_after=wait)
    expected = _settings(request).setup_token
    if await service.owner(db) is not None:
        raise AuthError(409, "already_set_up", "PandaFM already has an owner. Sign in instead.")
    if not expected and not private_address(ip):
        # 5.3: without a setup token, the first owner can only be created from a private network
        # (your home network, a VPN). From the internet, a token is still required.
        raise AuthError(403, "setup_disabled", "To set up PandaFM from outside your home network, set PANDAFM_SETUP_TOKEN for the API container (or open PandaFM from your home network).")
    if expected and not hmac.compare_digest(body.setup_token.encode(), expected.encode()):
        limiter.failure(ip, "setup")
        log.warning("Setup attempt with a wrong setup token from %s", ip)
        raise AuthError(403, "bad_setup_token", "That setup token isn’t right.")
    if problem := weakness(body.password):
        raise AuthError(422, "weak_password", problem)
    user = await service.setup_owner(db, body.username, body.password)
    log.info("Owner account '%s' created from %s", user.username, ip)
    return await _signed_in(request, response, db, user, body.client, body.device_name, body.platform)


@router.post("/login", response_model=SignedIn)
async def login(body: Credentials, request: Request, response: Response, db: SessionDep) -> SignedIn:
    ip = _ip(request)
    limiter = _limiter(request)
    if wait := limiter.retry_after(ip, body.username):
        log.warning("Login throttled for %s", ip)
        raise AuthError(429, "too_many_attempts", "Too many sign-in attempts. Wait a moment and try again.", retry_after=wait)
    user = await service.authenticate(db, body.username, body.password)
    if user is None:
        limiter.failure(ip, body.username)
        log.warning("Failed sign-in from %s", ip)
        raise AuthError(401, "invalid_login", "That username and password don’t match.")  # same answer for unknown users
    limiter.success(ip, body.username)
    signed = await _signed_in(request, response, db, user, body.client, body.device_name, body.platform)
    log.info("Signed in: %s (%s) from %s", body.device_name or body.client, body.platform or body.client, ip)
    return signed


@router.post("/refresh", response_model=SignedIn)
async def refresh(body: RefreshIn, request: Request, db: SessionDep) -> SignedIn:
    issued = await service.refresh(db, body.refresh_token)
    if issued is None:
        raise AuthError(401, "session_expired", "This device has been signed out. Sign in again.")
    user = await db.get(service.User, issued.session.user_id)
    return SignedIn(username=user.username, session_id=issued.session.id, access_token=issued.access,
                    access_expires_in=int(service.ACCESS_TTL.total_seconds()), refresh_token=issued.token)


@router.post("/logout", status_code=204)
async def logout(auth: Auth, response: Response, db: SessionDep) -> Response:
    await service.revoke(db, auth.user_id, auth.session_id)
    log.info("Signed out session %s", str(auth.session_id)[:8])
    response.status_code = 204
    _forget_cookies(response)
    return response


@router.get("/me", response_model=Me)
async def me(auth: Auth, db: SessionDep) -> Me:
    user = await db.get(service.User, auth.user_id)
    return Me(username=user.username, session_id=auth.session_id, via=auth.via)


@router.get("/devices", response_model=list[Device])
async def devices(auth: Auth, db: SessionDep) -> list[Device]:
    return [Device(id=s.id, device_name=s.device_name, platform=s.platform, kind=s.kind, created_at=s.created_at,
                   last_seen_at=s.last_seen_at, current=s.id == auth.session_id) for s in await service.devices(db, auth.user_id)]


@router.delete("/devices/{session_id}", status_code=204)
async def revoke_device(session_id: UUID, auth: Auth, response: Response, db: SessionDep) -> Response:
    if not await service.revoke(db, auth.user_id, session_id):
        raise AuthError(404, "device_not_found", "That device isn’t signed in.")
    log.info("Revoked session %s", str(session_id)[:8])
    response.status_code = 204
    if session_id == auth.session_id:
        _forget_cookies(response)
    return response


@router.post("/devices/revoke-others")
async def revoke_others(auth: Auth, db: SessionDep) -> dict[str, int]:
    count = await service.revoke_others(db, auth.user_id, auth.session_id)
    log.info("Signed out %d other device(s)", count)
    return {"revoked": count}


@router.post("/password", status_code=204)
async def change_password(body: PasswordIn, auth: Auth, request: Request, response: Response, db: SessionDep) -> Response:
    ip = _ip(request)
    limiter = _limiter(request)
    if wait := limiter.retry_after(ip, f"password:{auth.user_id}"):
        raise AuthError(429, "too_many_attempts", "Too many attempts. Wait a moment and try again.", retry_after=wait)
    if problem := weakness(body.new_password):
        raise AuthError(422, "weak_password", problem)
    if not await service.change_password(db, auth.user_id, body.current_password, body.new_password, auth.session_id):
        limiter.failure(ip, f"password:{auth.user_id}")
        raise AuthError(403, "wrong_password", "Your current password isn’t right.")
    log.info("Password changed; other devices signed out")
    response.status_code = 204
    return response
