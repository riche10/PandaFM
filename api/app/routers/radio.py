"""Panda Radio. The app's shared queue plays the picks; this API chooses them."""

from uuid import UUID

from fastapi import APIRouter, Request

from app.deps import SessionDep, UserId
from app.radio.config import MODES
from app.schemas.radio import RadioExtend, RadioExtendOut, RadioMode, RadioSessionOut, RadioStart, RadioStartOut
from app.services import radio
from app.services.radio import session_out, track_out

router = APIRouter(tags=["radio"])


@router.get("/radio/modes", response_model=list[RadioMode])
async def list_modes() -> list[RadioMode]:
    return [RadioMode(id=m.id, label=m.label, description=m.description) for m in MODES.values()]


@router.post("/radio/sessions", response_model=RadioStartOut, status_code=201)
async def start_radio(body: RadioStart, request: Request, db: SessionDep, user_id: UserId) -> RadioStartOut:
    await request.app.state.syncer.ensure_synced()
    seed = body.seed
    session, seed_track, picks = await radio.start(db, user_id, body.mode, seed.kind if seed else None, seed.id if seed else None, body.count)
    return RadioStartOut(session=session_out(session), seed_track=track_out(seed_track) if seed_track else None, picks=picks)


@router.get("/radio/sessions/{session_id}", response_model=RadioSessionOut)
async def get_radio(session_id: UUID, db: SessionDep, user_id: UserId) -> RadioSessionOut:
    return session_out(await radio.get_session(db, user_id, session_id))


@router.post("/radio/sessions/{session_id}/extend", response_model=RadioExtendOut)
async def extend_radio(session_id: UUID, body: RadioExtend, db: SessionDep, user_id: UserId) -> RadioExtendOut:
    session, replaced, picks = await radio.extend(db, user_id, session_id, body.upcoming, body.target)
    return RadioExtendOut(session=session_out(session), replaced=replaced, picks=picks)


@router.post("/radio/sessions/{session_id}/end", response_model=RadioSessionOut)
async def end_radio(session_id: UUID, db: SessionDep, user_id: UserId) -> RadioSessionOut:
    return session_out(await radio.end(db, user_id, session_id))
