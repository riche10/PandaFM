"""Saved stations: musical neighbourhoods you create (Rock, Metal, Pop Punk...).

A preset says HOW Panda chooses music; a station says WHAT neighbourhood it
stays in. A station stores its genres and a preset reference; starting it is a
normal Panda Radio session with a persistent (strict) genre anchor.
"""

from uuid import UUID, uuid4

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import RadioStation
from app.radio.genres import canonical, families
from app.schemas.radio import LibraryGenre, RadioStationOut
from app.services import presets
from app.services.presets import PresetError

MAX_STATIONS = 100


async def library_genre_counts(db: AsyncSession) -> list[LibraryGenre]:
    rows = await db.execute(text("SELECT g, count(*) AS n FROM tracks, unnest(genres) AS g WHERE is_available GROUP BY g ORDER BY n DESC, g"))
    out = []
    for r in rows:
        fam = sorted({f for c in canonical([r.g]) for f in families(c)})
        out.append(LibraryGenre(name=r.g, songs=r.n, family=fam[0] if fam else None))
    return out


async def behaviour(db: AsyncSession, user_id: int, station: RadioStation) -> tuple[presets.Resolved, bool]:
    """The preset a station plays with; Panda if its custom preset was deleted (never broken)."""
    try:
        return await presets.resolve(db, user_id, station.preset or "panda"), False
    except PresetError:
        return await presets.resolve(db, user_id, "panda"), True


def label(station: RadioStation, chosen: presets.Resolved) -> str:
    return station.name if chosen.base == "panda" and chosen.preset_id is None else f"{station.name} · {chosen.name}"


async def out(db: AsyncSession, user_id: int, station: RadioStation) -> RadioStationOut:
    chosen, missing = await behaviour(db, user_id, station)
    fams = sorted({f for c in canonical(station.genres) for f in families(c)})
    return RadioStationOut(
        id=str(station.id), name=station.name, genres=list(station.genres), families=fams,
        preset=str(chosen.preset_id) if chosen.preset_id else chosen.base, preset_name=chosen.name,
        preset_missing=missing, label=label(station, chosen),
    )


async def get(db: AsyncSession, user_id: int, ref: str) -> RadioStation:
    try:
        sid = UUID(ref)
    except ValueError:
        raise PresetError(404, "station_not_found", "That station doesn’t exist.") from None
    station = await db.scalar(select(RadioStation).where(RadioStation.id == sid, RadioStation.user_id == user_id))
    if station is None:
        raise PresetError(404, "station_not_found", "That station doesn’t exist (it may have been deleted).")
    return station


async def list_all(db: AsyncSession, user_id: int) -> list[RadioStation]:
    return list((await db.execute(select(RadioStation).where(RadioStation.user_id == user_id).order_by(RadioStation.created_at, RadioStation.name))).scalars())


async def _clean_genres(db: AsyncSession, genres: list[str]) -> list[str]:
    """Genres must exist in the library (the picker only offers those)."""
    wanted = list(dict.fromkeys(g.strip() for g in genres if g and g.strip()))
    known = set((await db.execute(text("SELECT DISTINCT g FROM tracks, unnest(genres) AS g WHERE g = ANY(:wanted)"), {"wanted": wanted})).scalars())
    kept = [g for g in wanted if g in known]
    if not kept:
        raise PresetError(422, "unknown_genres", "Pick at least one genre from your library.")
    return kept


async def _check_preset(db: AsyncSession, user_id: int, preset: str | None) -> str | None:
    if preset in (None, "", "panda"):
        return None
    await presets.resolve(db, user_id, preset)  # 404/422 if it doesn't exist
    return preset


async def create(db: AsyncSession, user_id: int, name: str, genres: list[str], preset: str | None) -> RadioStation:
    count = await db.scalar(select(func.count()).select_from(RadioStation).where(RadioStation.user_id == user_id))
    if count >= MAX_STATIONS:
        raise PresetError(422, "too_many_stations", f"You can keep up to {MAX_STATIONS} stations.")
    station = RadioStation(id=uuid4(), user_id=user_id, name=name.strip(), genres=await _clean_genres(db, genres), preset=await _check_preset(db, user_id, preset))
    db.add(station)
    await db.commit()
    return station


async def update(db: AsyncSession, user_id: int, ref: str, name: str | None, genres: list[str] | None, preset: str | None, preset_given: bool) -> RadioStation:
    station = await get(db, user_id, ref)
    if name is not None:
        station.name = name.strip()
    if genres is not None:
        station.genres = await _clean_genres(db, genres)
    if preset_given:
        station.preset = await _check_preset(db, user_id, preset)
    station.updated_at = func.now()
    await db.commit()
    await db.refresh(station)
    return station


async def delete(db: AsyncSession, user_id: int, ref: str) -> None:
    """Removes the saved station only: songs, presets, history and a playing session stay."""
    await db.delete(await get(db, user_id, ref))
    await db.commit()


async def duplicate(db: AsyncSession, user_id: int, ref: str) -> RadioStation:
    source = await get(db, user_id, ref)
    taken = {s.name for s in await list_all(db, user_id)}
    name, n = f"{source.name} Copy"[:40], 2
    while name in taken:
        name, n = f"{source.name} Copy {n}"[:40], n + 1
    return await create(db, user_id, name, list(source.genres), source.preset)
