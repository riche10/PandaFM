"""Things computed from your own listening: Home sections and statistics."""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.deps import SessionDep, UserId
from app.schemas.library import Track
from app.services import events, insights

router = APIRouter(tags=["listening"])


class HomeSections(BaseModel):
    recently_played: list[Track]
    back_in_rotation: list[Track]
    rediscover: list[Track]


@router.get("/me/home", response_model=HomeSections)
async def home(db: SessionDep, user_id: UserId) -> HomeSections:
    return HomeSections(
        recently_played=await insights.recently_played(db, user_id),
        back_in_rotation=await insights.back_in_rotation(db, user_id),
        rediscover=await insights.rediscover(db, user_id),
    )


@router.get("/stats")
async def listening_stats(db: SessionDep, user_id: UserId) -> dict[str, Any]:
    return await insights.stats(db, user_id)


@router.post("/stats/rebuild")
async def rebuild_statistics(db: SessionDep, user_id: UserId) -> dict[str, int]:
    """Recompute per-song statistics from the full event history."""
    return {"tracks": await events.rebuild_preferences(db, user_id)}
