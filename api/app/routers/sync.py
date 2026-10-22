"""Library cache sync: GET for status, POST to start one now."""

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Request

router = APIRouter(tags=["library sync"])


@router.get("/library/sync")
async def sync_status(request: Request) -> dict[str, Any]:
    return await request.app.state.syncer.status()


@router.post("/library/sync", status_code=202)
async def start_sync(request: Request, background: BackgroundTasks) -> dict[str, Any]:
    syncer = request.app.state.syncer
    if not syncer.running:
        background.add_task(syncer.run, "manual")
    return {**(await syncer.status()), "running": True}
