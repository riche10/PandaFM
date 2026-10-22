"""POST /api/events: listening behaviour from the app's player, in batches."""

import logging

from fastapi import APIRouter, BackgroundTasks

from app.deps import NavidromeDep, SessionDep, UserId
from app.navidrome.client import NavidromeClient, NavidromeError
from app.schemas.events import EventBatch, EventResult
from app.services import events
from app.services.events import Scrobble

log = logging.getLogger(__name__)
router = APIRouter(tags=["listening"])


async def _scrobble(navidrome: NavidromeClient, scrobbles: list[Scrobble]) -> None:
    """Tell Navidrome about real listens. Best effort: PandaFM's own history is already saved."""
    for item in scrobbles:
        try:
            await navidrome.scrobble(item.navidrome_id, item.played_at)
        except NavidromeError as exc:
            log.info("Navidrome scrobble skipped (%s); PandaFM history is unaffected", exc)


@router.post("/events", response_model=EventResult)
async def record_events(batch: EventBatch, db: SessionDep, user_id: UserId, navidrome: NavidromeDep, background: BackgroundTasks) -> EventResult:
    result, scrobbles = await events.ingest(db, user_id, batch)
    if scrobbles:
        background.add_task(_scrobble, navidrome, scrobbles)
    return result
