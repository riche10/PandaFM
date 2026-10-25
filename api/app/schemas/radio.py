"""Panda Radio API models."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.library import Track


class RadioMode(BaseModel):
    id: str
    label: str
    description: str


class RadioSeedIn(BaseModel):
    kind: Literal["track", "album", "artist", "station", "genre"]
    id: str = Field(min_length=1, max_length=200)


class RadioStart(BaseModel):
    mode: str = "panda"
    # A built-in mode id ("study") or a custom preset id (uuid). Wins over mode.
    preset: str | None = Field(default=None, max_length=64)
    seed: RadioSeedIn | None = None
    count: int = Field(default=10, ge=1, le=30)


class RadioPick(BaseModel):
    selection_id: int
    track: Track
    reasons: list[str]
    score: float
    breakdown: dict[str, float]  # for the debug view; the app shows `reasons`


class RadioSessionOut(BaseModel):
    id: UUID
    mode: str
    mode_label: str
    preset_id: str | None = None  # the preset that started it (mode id for built-ins)
    station_id: str | None = None  # the saved station that started it, if any
    status: str
    seed_kind: str | None = None
    seed_name: str | None = None
    skips: int = 0
    completions: int = 0
    exploration: float = 0.0


class RadioStartOut(BaseModel):
    session: RadioSessionOut
    seed_track: Track | None = None  # plays first when radio starts from a song
    picks: list[RadioPick]


class RadioExtend(BaseModel):
    upcoming: list[int] = Field(default_factory=list, max_length=200)  # radio picks the app still has queued
    target: int = Field(default=8, ge=1, le=30)


class RadioExtendOut(BaseModel):
    session: RadioSessionOut
    replaced: list[int]  # queued picks to drop: the session changed direction
    picks: list[RadioPick]


class RadioControls(BaseModel):
    """The six high-level controls, 0-100. Translated server-side into bounded weights."""

    model_config = {"extra": "forbid"}

    familiarity: int = Field(ge=0, le=100)
    discovery: int = Field(ge=0, le=100)
    continuity: int = Field(ge=0, le=100)
    artist_variety: int = Field(ge=0, le=100)
    genre_variety: int = Field(ge=0, le=100)
    wildcards: int = Field(ge=0, le=100)


PresetName = Field(min_length=1, max_length=40, pattern=r"^[^\x00-\x1f\x7f]+$")


class RadioPresetOut(BaseModel):
    id: str  # "study" for built-ins, a uuid for custom presets
    kind: Literal["builtin", "custom"]
    name: str  # what the app shows
    default_name: str | None = None  # built-ins: PandaFM's own name
    base_mode: str
    base_name: str  # the base mode's shown name ("Based on Lock In")
    description: str
    controls: RadioControls


class RadioPresetCreate(BaseModel):
    model_config = {"extra": "forbid"}

    name: str = PresetName
    base_mode: str = "panda"
    controls: RadioControls | None = None


class RadioPresetUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    name: str | None = PresetName
    base_mode: str | None = None
    controls: RadioControls | None = None


class ModeRename(BaseModel):
    model_config = {"extra": "forbid"}

    name: str | None = PresetName  # null resets to PandaFM's name


StationName = Field(min_length=1, max_length=40, pattern=r"^[^\x00-\x1f\x7f]+$")


class RadioStationOut(BaseModel):
    id: str
    name: str
    genres: list[str]  # library genre tags, as chosen
    families: list[str]  # broad families, for a quiet subtitle ("punk, rock")
    preset: str  # the behaviour actually used ("panda" if the chosen custom preset is gone)
    preset_name: str
    preset_missing: bool  # the custom preset this station used was deleted: playing as Panda
    label: str  # what Queue and Now Playing show: "Rock" or "Rock · Familiar"


class RadioStationIn(BaseModel):
    model_config = {"extra": "forbid"}

    name: str = StationName
    genres: list[str] = Field(min_length=1, max_length=20)
    preset: str | None = Field(default=None, max_length=64)


class RadioStationUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    name: str | None = StationName
    genres: list[str] | None = Field(default=None, min_length=1, max_length=20)
    preset: str | None = Field(default=None, max_length=64)


class LibraryGenre(BaseModel):
    name: str  # the tag as it appears in your library
    songs: int
    family: str | None  # broad family from the shared genre model
