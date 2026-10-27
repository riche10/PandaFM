"""Settings › Music server (5.3): the external Navidrome / OpenSubsonic server PandaFM uses.

Signed-in owner only (the same sign-in as every route). The password is write-
only: it is never returned, logged or sent anywhere but the music server.
"""

import asyncio

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.deps import SessionDep
from app.errors import error_response
from app.musicserver import save, stored_password, test_connection

router = APIRouter(prefix="/settings", tags=["settings"])


class MusicServerIn(BaseModel):
    url: str = Field(min_length=8, max_length=500, pattern=r"^https?://")
    username: str = Field(min_length=1, max_length=200)
    password: str | None = Field(default=None, max_length=500)  # omitted: keep the stored one


@router.get("/music-server")
async def music_server(request: Request):
    holder = request.app.state.navidrome
    return {"configured": holder.configured, "url": holder.url, "username": holder.username, "managed_by_env": holder.managed_by_env}


@router.put("/music-server")
async def set_music_server(body: MusicServerIn, request: Request, db: SessionDep):
    holder = request.app.state.navidrome
    if holder.managed_by_env:
        return error_response(409, "managed_by_env", "The music server is set by PANDAFM_NAVIDROME_* environment variables. Remove them to manage it here.")
    url = body.url.rstrip("/")
    password = body.password or await stored_password(db, request.app.state.secret_box)
    if not password:
        return error_response(400, "password_required", "Enter the music server’s password.")
    problem = await test_connection(url, body.username, password, holder.timeout)
    if problem:
        return error_response(400, "music_server_unreachable", f"PandaFM couldn’t connect: {problem}")
    await save(holder, db, request.app.state.secret_box, url, body.username, password)
    syncer = getattr(request.app.state, "syncer", None)
    if syncer is not None:  # read the (new) library in the background
        request.app.state.music_sync = asyncio.get_running_loop().create_task(syncer.run("music-server"))
    return {"configured": True, "url": url, "username": body.username, "managed_by_env": False}
