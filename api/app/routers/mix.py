"""Panda Mix (5.2): prepare a playlist's transitions, inspect analyses, adjust a transition.

Same sign-in as every other PandaFM API. Panda DJ decides HOW one song becomes
the next; it never chooses songs.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from app.config import get_settings
from app.deps import SessionDep, UserId
from app.errors import error_response
from app.services import mix as mix_service

router = APIRouter(prefix="/mix", tags=["mix"])
Mode = Literal["auto", "gentle", "flow", "energetic"]


class MixTrack(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    duration_seconds: float | None = None
    album_id: str | None = None
    track_number: int | None = None
    disc_number: int | None = None
    genres: list[str] = Field(default_factory=list, max_length=20)


class PrepareIn(BaseModel):
    tracks: list[MixTrack] = Field(min_length=1, max_length=500)  # the order that will play (shuffled already, if shuffled)
    current_index: int = Field(default=0, ge=0)
    playlist_id: str | None = Field(default=None, max_length=200)
    mode: Mode = "auto"
    all_pairs: bool = False  # the playlist view's bridges: plan every pair from what's analysed (schedules only the lookahead)
    offline: bool = False  # "Prepare Panda Mix": analyse the whole (downloaded) playlist, at low priority


class OverrideIn(BaseModel):
    from_track: str = Field(min_length=1, max_length=200)
    to_track: str = Field(min_length=1, max_length=200)
    playlist_id: str | None = Field(default=None, max_length=200)
    type: str = "smooth_blend"
    outgoing_start_ms: int = Field(ge=0)
    incoming_start_ms: int = Field(default=0, ge=0)
    overlap_ms: int = Field(default=6000, ge=0, le=60000)
    curve: Literal["equal_power", "linear"] = "equal_power"
    filter: Literal["bass_swap", "highpass_out", "lowpass_in"] | None = None
    a_duration_ms: int = Field(gt=0)
    b_duration_ms: int = Field(gt=0)


def _analyzer(request: Request):
    return getattr(request.app.state, "mix", None)


def _enabled(request: Request) -> bool:
    cfg = getattr(request.app.state, "settings", None) or get_settings()
    return cfg.mix_enabled


@router.post("/prepare")
async def prepare(body: PrepareIn, request: Request, db: SessionDep, user_id: UserId):
    if not _enabled(request):
        return error_response(404, "mix_disabled", "Panda Mix is turned off on this server.")
    cfg = getattr(request.app.state, "settings", None) or get_settings()
    tracks = [t.model_dump() for t in body.tracks]
    current = min(body.current_index, len(tracks) - 1)
    lookahead = len(tracks) if body.offline else cfg.mix_lookahead
    return await mix_service.prepare(db, _analyzer(request), user_id, tracks, current, lookahead, body.mode, body.playlist_id,
                                     body.all_pairs or body.offline, priority_base=100 if body.offline else 0)


@router.get("/analysis/{track_id}")
async def analysis(track_id: str, request: Request, db: SessionDep):
    found = (await mix_service.usable_analyses(db, [track_id])).get(track_id)
    if not found:
        a = _analyzer(request)
        if a is not None and _enabled(request):
            a.schedule(track_id, 0)
        return {"track_id": track_id, "status": (a.state_of(track_id) if a else None) or "queued", "analysis": None}
    return {"track_id": track_id, "status": found["status"], "analysis": found["payload"]}


@router.put("/transition")
async def save_transition(body: OverrideIn, db: SessionDep, user_id: UserId):
    plan = await mix_service.save_override(db, user_id, body.playlist_id, body.from_track, body.to_track, body.model_dump(),
                                           body.a_duration_ms, body.b_duration_ms)
    return {"from": body.from_track, "to": body.to_track, "playlist_id": body.playlist_id, **plan}


@router.delete("/transition", status_code=204)
async def reset_transition(db: SessionDep, user_id: UserId, from_track: Annotated[str, Query(min_length=1)], to_track: Annotated[str, Query(min_length=1)],
                           playlist_id: str | None = None):
    await mix_service.reset_override(db, user_id, playlist_id, from_track, to_track)
