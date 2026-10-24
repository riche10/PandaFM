"""Radio presets and built-in mode names for the current PandaFM user.

Built-in modes are never stored or changed: a rename is a display-name
override in users.preferences, and "Reset name" removes it. Custom presets
are rows in radio_presets. Both feed the same Stage 3 engine.
"""

from dataclasses import dataclass
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import RadioPreset, User
from app.radio.config import MODES
from app.radio.presets import DEFAULT_CONTROLS, clean_controls
from app.schemas.radio import RadioControls, RadioPresetOut

MAX_PRESETS = 50
TAGLINES = {"panda": "Balanced", "familiar": "Songs you love", "discovery": "Explore your library", "study": "Steady focus", "chaos": "Anything goes"}


class PresetError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code = status, code


@dataclass(frozen=True)
class Resolved:
    base: str
    name: str
    preset_id: UUID | None  # custom presets only
    controls: dict | None  # custom presets only


async def mode_names(db: AsyncSession, user_id: int) -> dict[str, str]:
    prefs = await db.scalar(select(User.preferences).where(User.id == user_id)) or {}
    names = prefs.get("radio_names") or {}
    return {k: v for k, v in names.items() if k in MODES and isinstance(v, str) and v.strip()}


def shown_name(mode_id: str, names: dict[str, str]) -> str:
    return names.get(mode_id) or MODES[mode_id].label


def builtin_out(mode_id: str, names: dict[str, str]) -> RadioPresetOut:
    mode = MODES[mode_id]
    return RadioPresetOut(id=mode_id, kind="builtin", name=shown_name(mode_id, names), default_name=mode.label, base_mode=mode_id,
                          base_name=shown_name(mode_id, names), description=mode.description, controls=RadioControls(**DEFAULT_CONTROLS[mode_id]))


def custom_out(p: RadioPreset, names: dict[str, str]) -> RadioPresetOut:
    base = p.base_mode if p.base_mode in MODES else "panda"
    return RadioPresetOut(id=str(p.id), kind="custom", name=p.name, base_mode=base, base_name=shown_name(base, names),
                          description=f"Your preset, based on {shown_name(base, names)}", controls=RadioControls(**clean_controls(base, p.controls)))


async def list_all(db: AsyncSession, user_id: int) -> list[RadioPresetOut]:
    names = await mode_names(db, user_id)
    custom = (await db.execute(select(RadioPreset).where(RadioPreset.user_id == user_id).order_by(RadioPreset.created_at, RadioPreset.name))).scalars()
    return [builtin_out(m, names) for m in MODES] + [custom_out(p, names) for p in custom]


async def get_custom(db: AsyncSession, user_id: int, ref: str) -> RadioPreset:
    try:
        preset_id = UUID(ref)
    except ValueError:
        raise PresetError(404, "preset_not_found", "That radio preset doesn’t exist.") from None
    preset = await db.scalar(select(RadioPreset).where(RadioPreset.id == preset_id, RadioPreset.user_id == user_id))
    if preset is None:
        raise PresetError(404, "preset_not_found", "That radio preset doesn’t exist (it may have been deleted).")
    return preset


async def resolve(db: AsyncSession, user_id: int, ref: str) -> Resolved:
    """A built-in mode id or a custom preset id, as the engine needs it."""
    if ref in MODES:
        return Resolved(ref, shown_name(ref, await mode_names(db, user_id)), None, None)
    preset = await get_custom(db, user_id, ref)
    base = preset.base_mode if preset.base_mode in MODES else "panda"
    return Resolved(base, preset.name, preset.id, clean_controls(base, preset.controls))


def _check_base(base: str) -> str:
    if base not in MODES:
        raise PresetError(422, "unknown_mode", f"“{base}” isn’t a Panda Radio mode.")
    return base


async def create(db: AsyncSession, user_id: int, name: str, base: str, controls: dict | None) -> RadioPreset:
    _check_base(base)
    count = await db.scalar(select(func.count()).select_from(RadioPreset).where(RadioPreset.user_id == user_id))
    if count >= MAX_PRESETS:
        raise PresetError(422, "too_many_presets", f"You can keep up to {MAX_PRESETS} radio presets.")
    preset = RadioPreset(id=uuid4(), user_id=user_id, name=name.strip(), base_mode=base, controls=clean_controls(base, controls))
    db.add(preset)
    await db.commit()
    return preset


async def update(db: AsyncSession, user_id: int, ref: str, name: str | None, base: str | None, controls: dict | None) -> RadioPreset:
    preset = await get_custom(db, user_id, ref)
    if name is not None:
        preset.name = name.strip()
    if base is not None:
        preset.base_mode = _check_base(base)
        if controls is None:  # a new base brings its own defaults
            preset.controls = clean_controls(base, None)
    if controls is not None:
        preset.controls = clean_controls(preset.base_mode, controls)
    preset.updated_at = func.now()
    await db.commit()
    await db.refresh(preset)
    return preset


async def delete(db: AsyncSession, user_id: int, ref: str) -> None:
    """Removes the preset only. Past sessions keep their name and profile snapshot."""
    await db.delete(await get_custom(db, user_id, ref))
    await db.commit()


async def duplicate(db: AsyncSession, user_id: int, ref: str) -> RadioPreset:
    source = await resolve(db, user_id, ref)
    taken = set((await db.execute(select(RadioPreset.name).where(RadioPreset.user_id == user_id))).scalars())
    name = f"{source.name} Copy"[:40]
    n = 2
    while name in taken:
        name = f"{source.name} Copy {n}"[:40]
        n += 1
    controls = source.controls if source.controls is not None else DEFAULT_CONTROLS[source.base]
    return await create(db, user_id, name, source.base, controls)


async def rename_mode(db: AsyncSession, user_id: int, mode_id: str, name: str | None) -> RadioPresetOut:
    _check_base(mode_id)
    user = await db.get(User, user_id)
    prefs = dict(user.preferences or {})
    names = dict(prefs.get("radio_names") or {})
    if name and name.strip() and name.strip() != MODES[mode_id].label:
        names[mode_id] = name.strip()
    else:
        names.pop(mode_id, None)  # reset to PandaFM's name
    prefs["radio_names"] = names
    user.preferences = prefs
    await db.commit()
    return builtin_out(mode_id, names)
