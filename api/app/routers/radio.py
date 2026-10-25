"""Panda Radio. The app's shared queue plays the picks; this API chooses them."""

from uuid import UUID

from fastapi import APIRouter, Request, Response

from app.deps import SessionDep, UserId
from app.radio.config import MODES
from app.schemas.radio import (
    ModeRename,
    RadioExtend,
    RadioExtendOut,
    RadioMode,
    RadioPresetCreate,
    RadioPresetOut,
    RadioPresetUpdate,
    RadioSessionOut,
    RadioStart,
    RadioStartOut,
    RadioStationIn,
    RadioStationOut,
    RadioStationUpdate,
    LibraryGenre,
)
from app.services import presets, stations
from app.services import radio
from app.services.radio import session_out, track_out

router = APIRouter(tags=["radio"])


@router.get("/radio/modes", response_model=list[RadioMode])
async def list_modes(db: SessionDep, user_id: UserId) -> list[RadioMode]:
    names = await presets.mode_names(db, user_id)
    return [RadioMode(id=m.id, label=presets.shown_name(m.id, names), description=m.description) for m in MODES.values()]


@router.patch("/radio/modes/{mode_id}", response_model=RadioPresetOut)
async def rename_mode(mode_id: str, body: ModeRename, db: SessionDep, user_id: UserId) -> RadioPresetOut:
    """Show a built-in mode under your own name (null = PandaFM's name). Behaviour never changes."""
    return await presets.rename_mode(db, user_id, mode_id, body.name)


@router.get("/radio/presets", response_model=list[RadioPresetOut])
async def list_presets(db: SessionDep, user_id: UserId) -> list[RadioPresetOut]:
    """Built-in modes (with your names) first, then your own presets."""
    return await presets.list_all(db, user_id)


@router.post("/radio/presets", response_model=RadioPresetOut, status_code=201)
async def create_preset(body: RadioPresetCreate, db: SessionDep, user_id: UserId) -> RadioPresetOut:
    preset = await presets.create(db, user_id, body.name, body.base_mode, body.controls.model_dump() if body.controls else None)
    return presets.custom_out(preset, await presets.mode_names(db, user_id))


@router.get("/radio/presets/{preset_ref}", response_model=RadioPresetOut)
async def get_preset(preset_ref: str, db: SessionDep, user_id: UserId) -> RadioPresetOut:
    names = await presets.mode_names(db, user_id)
    if preset_ref in MODES:
        return presets.builtin_out(preset_ref, names)
    return presets.custom_out(await presets.get_custom(db, user_id, preset_ref), names)


@router.patch("/radio/presets/{preset_ref}", response_model=RadioPresetOut)
async def update_preset(preset_ref: str, body: RadioPresetUpdate, db: SessionDep, user_id: UserId) -> RadioPresetOut:
    if preset_ref in MODES:
        raise presets.PresetError(422, "builtin_preset", "Built-in modes can’t be changed. Rename it, or duplicate it and edit the copy.")
    preset = await presets.update(db, user_id, preset_ref, body.name, body.base_mode, body.controls.model_dump() if body.controls else None)
    return presets.custom_out(preset, await presets.mode_names(db, user_id))


@router.delete("/radio/presets/{preset_ref}", status_code=204)
async def delete_preset(preset_ref: str, db: SessionDep, user_id: UserId) -> Response:
    if preset_ref in MODES:
        raise presets.PresetError(422, "builtin_preset", "Built-in modes are always kept.")
    await presets.delete(db, user_id, preset_ref)
    return Response(status_code=204)


@router.post("/radio/presets/{preset_ref}/duplicate", response_model=RadioPresetOut, status_code=201)
async def duplicate_preset(preset_ref: str, db: SessionDep, user_id: UserId) -> RadioPresetOut:
    preset = await presets.duplicate(db, user_id, preset_ref)
    return presets.custom_out(preset, await presets.mode_names(db, user_id))


@router.post("/radio/sessions", response_model=RadioStartOut, status_code=201)
async def start_radio(body: RadioStart, request: Request, db: SessionDep, user_id: UserId) -> RadioStartOut:
    await request.app.state.syncer.ensure_synced()
    seed = body.seed
    station_id = None
    if seed and seed.kind == "station":  # a saved station brings its own behaviour (Panda if its preset is gone)
        station = await stations.get(db, user_id, seed.id)
        chosen, _ = await stations.behaviour(db, user_id, station)
        chosen = presets.Resolved(chosen.base, stations.label(station, chosen), chosen.preset_id, chosen.controls)
        station_id = station.id
    else:
        chosen = await presets.resolve(db, user_id, body.preset or body.mode) if (body.preset or body.mode in MODES) else None
        if chosen and seed and seed.kind == "genre":  # "Rock Radio", or "Rock · Familiar" with another preset
            from app.services import explore

            entry = (await explore.index(db)).get(seed.id)
            if entry:
                label = f"{entry.name} Radio" if chosen.base == "panda" and chosen.preset_id is None else f"{entry.name} · {chosen.name}"
                chosen = presets.Resolved(chosen.base, label, chosen.preset_id, chosen.controls)
    if chosen is None:
        raise radio.RadioError(f"Unknown radio mode “{body.mode}”.")
    session, seed_track, picks = await radio.start(
        db, user_id, chosen.base, seed.kind if seed else None, seed.id if seed else None, body.count,
        display_name=chosen.name, preset_id=chosen.preset_id, controls=chosen.controls, station_id=station_id,
    )
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


# ── Saved stations: musical neighbourhoods (WHAT), played with a preset (HOW) ──


@router.get("/radio/genres", response_model=list[LibraryGenre])
async def library_genres(db: SessionDep) -> list[LibraryGenre]:
    """Genres that exist in your library, most songs first (for the station picker)."""
    return await stations.library_genre_counts(db)


@router.get("/radio/stations", response_model=list[RadioStationOut])
async def list_stations(db: SessionDep, user_id: UserId) -> list[RadioStationOut]:
    return [await stations.out(db, user_id, s) for s in await stations.list_all(db, user_id)]


@router.post("/radio/stations", response_model=RadioStationOut, status_code=201)
async def create_station(body: RadioStationIn, db: SessionDep, user_id: UserId) -> RadioStationOut:
    return await stations.out(db, user_id, await stations.create(db, user_id, body.name, body.genres, body.preset))


@router.get("/radio/stations/{station_id}", response_model=RadioStationOut)
async def get_station(station_id: str, db: SessionDep, user_id: UserId) -> RadioStationOut:
    return await stations.out(db, user_id, await stations.get(db, user_id, station_id))


@router.patch("/radio/stations/{station_id}", response_model=RadioStationOut)
async def update_station(station_id: str, body: RadioStationUpdate, db: SessionDep, user_id: UserId) -> RadioStationOut:
    station = await stations.update(db, user_id, station_id, body.name, body.genres, body.preset, "preset" in body.model_fields_set)
    return await stations.out(db, user_id, station)


@router.delete("/radio/stations/{station_id}", status_code=204)
async def delete_station(station_id: str, db: SessionDep, user_id: UserId) -> Response:
    await stations.delete(db, user_id, station_id)
    return Response(status_code=204)


@router.post("/radio/stations/{station_id}/duplicate", response_model=RadioStationOut, status_code=201)
async def duplicate_station(station_id: str, db: SessionDep, user_id: UserId) -> RadioStationOut:
    return await stations.out(db, user_id, await stations.duplicate(db, user_id, station_id))


@router.post("/radio/stations/{station_id}/start", response_model=RadioStartOut, status_code=201)
async def start_station(station_id: str, request: Request, db: SessionDep, user_id: UserId, count: int = 10) -> RadioStartOut:
    """Same as starting a session with a station seed: a normal Panda Radio session."""
    return await start_radio(RadioStart(seed={"kind": "station", "id": station_id}, count=count), request, db, user_id)
