"""PandaFM's own database tables (SQLAlchemy 2 typed models).

Navidrome stays authoritative for music, favorites and playlists. These
tables hold what only PandaFM knows: who listened to what and how, the
statistics derived from that, and Panda Radio's sessions and choices.
Schema changes go through Alembic migrations in app/migrations/.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def _now():
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = _now()


class Track(Base):
    """A cached copy of Navidrome's song metadata, for recommendation queries.

    Rows are never deleted: a song that disappears from Navidrome is marked
    unavailable so its listening history stays intact.
    """

    __tablename__ = "tracks"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    navidrome_id: Mapped[str] = mapped_column(String(200), unique=True)
    title: Mapped[str] = mapped_column(Text)
    artist: Mapped[str] = mapped_column(Text)
    artist_id: Mapped[str | None] = mapped_column(String(200))
    album: Mapped[str | None] = mapped_column(Text)
    album_id: Mapped[str | None] = mapped_column(String(200))
    genres: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'"))
    year: Mapped[int | None] = mapped_column(Integer)
    duration_s: Mapped[int | None] = mapped_column(Integer)
    cover_art_id: Mapped[str | None] = mapped_column(String(200))
    # Technical facts from Navidrome (Stage 4); nullable for songs cached before.
    suffix: Mapped[str | None] = mapped_column(String(16))
    bitrate_kbps: Mapped[int | None] = mapped_column(Integer)
    sample_rate: Mapped[int | None] = mapped_column(Integer)
    bit_depth: Mapped[int | None] = mapped_column(Integer)
    channels: Mapped[int | None] = mapped_column(Integer)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    source_revision: Mapped[str | None] = mapped_column(String(32))
    is_available: Mapped[bool] = mapped_column(server_default=text("true"))
    first_seen_at: Mapped[datetime] = _now()
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_tracks_artist_id", "artist_id"),
        Index("ix_tracks_album_id", "album_id"),
        Index("ix_tracks_genres", "genres", postgresql_using="gin"),
        Index("ix_tracks_available_year", "is_available", "year"),
    )


class ListeningEvent(Base):
    """Append-only listening behaviour. Never updated, never deleted."""

    __tablename__ = "listening_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    event_id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), unique=True)  # client-made; makes retries safe
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"))
    play_id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True))  # ties one listen's events together
    radio_session_id: Mapped[UUID | None] = mapped_column(ForeignKey("radio_sessions.id", ondelete="SET NULL"))
    event_type: Mapped[str] = mapped_column(String(32))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # client clock
    recorded_at: Mapped[datetime] = _now()  # server clock
    position_s: Mapped[float | None] = mapped_column(Float)
    duration_s: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(32))
    mode: Mapped[str | None] = mapped_column(String(32))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))

    __table_args__ = (
        Index("ix_events_user_time", "user_id", "occurred_at"),
        Index("ix_events_track", "track_id"),
        Index("ix_events_play", "play_id"),
        Index("ix_events_radio_session", "radio_session_id"),
    )


class TrackPreference(Base):
    """Per user and song statistics, a projection of listening_events.

    Rebuildable at any time from the events. `liked` mirrors Navidrome's
    star (the source of truth) so recommendations can use it cheaply.
    """

    __tablename__ = "track_preferences"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"), primary_key=True)
    liked: Mapped[bool] = mapped_column(server_default=text("false"))
    play_count: Mapped[int] = mapped_column(server_default=text("0"))
    completed_count: Mapped[int] = mapped_column(server_default=text("0"))
    skip_count: Mapped[int] = mapped_column(server_default=text("0"))
    early_skip_count: Mapped[int] = mapped_column(server_default=text("0"))
    late_skip_count: Mapped[int] = mapped_column(server_default=text("0"))
    listened_s: Mapped[float] = mapped_column(Float, server_default=text("0"))
    last_played_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_skipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = _now()

    __table_args__ = (
        Index("ix_prefs_user_last_played", "user_id", "last_played_at"),
        Index("ix_prefs_user_liked", "user_id", "liked"),
    )


class RadioSession(Base):
    __tablename__ = "radio_sessions"

    id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    seed_track_id: Mapped[int | None] = mapped_column(ForeignKey("tracks.id"))
    seed: Mapped[dict[str, Any] | None] = mapped_column(JSONB)  # {"kind", "id", "name"} for "Based on: …"
    mode: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), server_default=text("'active'"))
    state: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))  # short-term taste
    created_at: Mapped[datetime] = _now()
    last_activity_at: Mapped[datetime] = _now()
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_radio_sessions_user_status", "user_id", "status"),)


class RadioQueueItem(Base):
    """What the radio engine chose, and why. Not the player's queue (that lives in the app)."""

    __tablename__ = "radio_queue_items"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    session_id: Mapped[UUID] = mapped_column(ForeignKey("radio_sessions.id", ondelete="CASCADE"))
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"))
    position: Mapped[int] = mapped_column(Integer)
    score: Mapped[float] = mapped_column(Float)
    score_breakdown: Mapped[dict[str, Any]] = mapped_column(JSONB)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), server_default=text("'queued'"))  # queued|played|skipped|replaced
    state_version: Mapped[int] = mapped_column(Integer, server_default=text("0"))  # session steer version when chosen
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        UniqueConstraint("session_id", "position", name="uq_radio_items_session_position"),
        Index("ix_radio_items_session_status", "session_id", "status"),
    )


class LibrarySync(Base):
    """One run of copying Navidrome's song metadata into `tracks`."""

    __tablename__ = "library_syncs"

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    trigger: Mapped[str] = mapped_column(String(16))  # startup|manual|scheduled|radio
    status: Mapped[str] = mapped_column(String(16))  # running|completed|failed
    started_at: Mapped[datetime] = _now()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tracks_seen: Mapped[int] = mapped_column(server_default=text("0"))
    tracks_added: Mapped[int] = mapped_column(server_default=text("0"))
    tracks_updated: Mapped[int] = mapped_column(server_default=text("0"))
    tracks_missing: Mapped[int] = mapped_column(server_default=text("0"))
    error: Mapped[str | None] = mapped_column(Text)


class Conversion(Base):
    """A portable copy of one song made for downloads, kept in the conversion cache."""

    __tablename__ = "conversions"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"))
    profile: Mapped[str] = mapped_column(String(32))
    source_revision: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16))  # ready | failed
    file_name: Mapped[str | None] = mapped_column(String(200))  # inside the cache directory, never a library path
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    sha256: Mapped[str | None] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()
    last_accessed_at: Mapped[datetime] = _now()

    __table_args__ = (
        UniqueConstraint("track_id", "profile", "source_revision", name="uq_conversions_track_profile_revision"),
        Index("ix_conversions_last_accessed", "last_accessed_at"),
    )
