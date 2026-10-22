"""Listening events sent by the web app's player (POST /api/events)."""

import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

EventType = Literal[
    "play_started", "play_completed", "skip", "pause", "resume", "seek", "favorite", "unfavorite", "radio_started"
]


class TrackSnapshot(BaseModel):
    """Enough about the song to cache it if it hasn't been synced yet."""

    id: str = Field(min_length=1, max_length=200)  # Navidrome id
    title: str = Field(default="Untitled", max_length=500)
    artist: str = Field(default="Unknown artist", max_length=500)
    artist_id: str | None = Field(default=None, max_length=200)
    album: str | None = Field(default=None, max_length=500)
    album_id: str | None = Field(default=None, max_length=200)
    genres: list[str] = Field(default_factory=list, max_length=20)
    year: int | None = None
    duration_seconds: int | None = Field(default=None, ge=0)
    cover_art_id: str | None = Field(default=None, max_length=200)


class EventIn(BaseModel):
    event_id: UUID  # made by the app; the same id twice is stored once
    type: EventType
    track: TrackSnapshot
    play_id: UUID
    occurred_at: datetime
    position_s: float | None = Field(default=None, ge=0, le=86_400)
    duration_s: float | None = Field(default=None, ge=0, le=86_400)
    source: str = Field(default="library", max_length=32)
    mode: str | None = Field(default=None, max_length=32)
    radio_session_id: UUID | None = None
    radio_selection_id: int | None = None
    details: dict[str, Any] = Field(default_factory=dict)

    @field_validator("details")
    @classmethod
    def small_details(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 20 or len(json.dumps(value, default=str)) > 2000:
            raise ValueError("details is too large")
        return value


class EventBatch(BaseModel):
    events: list[EventIn] = Field(min_length=1, max_length=200)


class EventResult(BaseModel):
    accepted: int
    duplicates: int
