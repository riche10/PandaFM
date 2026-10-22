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
    kind: Literal["track", "album", "artist"]
    id: str = Field(min_length=1, max_length=200)


class RadioStart(BaseModel):
    mode: str = "panda"
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
