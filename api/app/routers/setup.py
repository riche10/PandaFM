"""First-run setup state and the owner's music server settings (5.3).

/api/setup/state is public and says only what the app needs to choose a
screen (booleans). Everything else is owner-only (session + CSRF, or a device
token), and never returns the music server password.
"""

import asyncio

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.config import get_settings
from app.deps import SessionDep
from app.errors import error_response
from app.auth import service as auth_service
from app.services import music_server as ms
from app.auth.limits import client_ip, parse_networks, private_address
from app.vault import VaultError


def _visitor_ip(request: Request) -> str:
    nets = getattr(request.app.state, "trusted_networks", None)
    if nets is None:
        cfg = getattr(request.app.state, "settings", None) or get_settings()
        nets = request.app.state.trusted_networks = parse_networks(cfg.trusted_proxies)
    return client_ip(request.client.host if request.client else None, request.headers.get("x-forwarded-for"), nets)

public = APIRouter(prefix="/setup", tags=["setup"])
router = APIRouter(prefix="/music-server", tags=["setup"])


@public.get("/state")
async def setup_state(request: Request, db: SessionDep):
    owner = await auth_service.owner(db)
    configured = request.app.state.navidrome.configured
    cfg = getattr(request.app.state, "settings", None) or get_settings()
    return {
        "owner_configured": owner is not None,
        "music_server_configured": configured,
        "ready": owner is not None and configured,
        # Whether this visitor must enter the setup token (always if one is set; else only from the internet).
        "setup_token_required": owner is None and (bool(cfg.setup_token) or not private_address(_visitor_ip(request))),
    }


class MusicServerIn(BaseModel):
    url: str = Field(min_length=1, max_length=500)
    username: str = Field(min_length=1, max_length=200)
    password: str | None = Field(default=None, max_length=500)  # blank: keep the saved password


def _manager(request: Request) -> ms.MusicServerManager:
    return request.app.state.music_server


async def _password_for(manager: ms.MusicServerManager, body: MusicServerIn) -> str | None:
    if body.password:
        return body.password
    try:
        return await manager.stored_password()
    except VaultError:
        return None


@router.get("")
async def get_music_server(request: Request, db: SessionDep):
    info = await _manager(request).describe(db)
    info["sync"] = await request.app.state.syncer.status()
    return info


@router.post("/test")
async def test_music_server(body: MusicServerIn, request: Request):
    manager = _manager(request)
    password = await _password_for(manager, body)
    if password is None:
        return {"ok": False, "kind": "bad_credentials", "message": "Enter the music server password."}
    return ms.result_dict(await ms.test_connection(body.url, body.username, password, manager.transport))


@router.put("")
async def save_music_server(body: MusicServerIn, request: Request, db: SessionDep):
    """Test, then save (encrypted) and use it at once. The first save starts the library import."""
    manager = _manager(request)
    password = await _password_for(manager, body)
    if password is None:
        return error_response(400, "password_required", "Enter the music server password.")
    result = await ms.test_connection(body.url, body.username, password, manager.transport)
    if not result.ok:
        return error_response(400, f"music_server_{result.kind}", result.message)
    first = not await ms.configured(db)
    try:
        await manager.save(result.url, body.username, password, result, source="setup" if first else "settings")
    except VaultError as exc:
        return error_response(500, "config_key", str(exc))
    syncer = request.app.state.syncer
    if not syncer.running:
        asyncio.get_running_loop().create_task(syncer.run("setup" if first else "music-server-changed"))
    return {**(await manager.describe(db)), "result": ms.result_dict(result), "sync_started": True}
