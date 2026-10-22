"""Listening history, preference statistics, track cache and Panda Radio.

The first PandaFM schema. Purely additive: it only creates new tables, so it
is safe on the existing (empty) database volume.

Revision ID: 0001
Revises:
Create Date: 2026-10-22
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, sa.Identity(), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False, unique=True),
        sa.Column("display_name", sa.String(120)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )
    # PandaFM is single-user for now; this is the user everything belongs to.
    op.execute("INSERT INTO users (username, display_name) VALUES ('default', 'PandaFM') ON CONFLICT DO NOTHING")

    op.create_table(
        "tracks",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("navidrome_id", sa.String(200), nullable=False, unique=True),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("artist", sa.Text, nullable=False),
        sa.Column("artist_id", sa.String(200)),
        sa.Column("album", sa.Text),
        sa.Column("album_id", sa.String(200)),
        sa.Column("genres", pg.ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("year", sa.Integer),
        sa.Column("duration_s", sa.Integer),
        sa.Column("cover_art_id", sa.String(200)),
        sa.Column("is_available", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("last_synced_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_tracks_artist_id", "tracks", ["artist_id"])
    op.create_index("ix_tracks_album_id", "tracks", ["album_id"])
    op.create_index("ix_tracks_genres", "tracks", ["genres"], postgresql_using="gin")
    op.create_index("ix_tracks_available_year", "tracks", ["is_available", "year"])

    op.create_table(
        "radio_sessions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("seed_track_id", sa.BigInteger, sa.ForeignKey("tracks.id")),
        sa.Column("seed", pg.JSONB),
        sa.Column("mode", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default=sa.text("'active'")),
        sa.Column("state", pg.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_radio_sessions_user_status", "radio_sessions", ["user_id", "status"])

    op.create_table(
        "listening_events",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("event_id", pg.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("track_id", sa.BigInteger, sa.ForeignKey("tracks.id"), nullable=False),
        sa.Column("play_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("radio_session_id", pg.UUID(as_uuid=True), sa.ForeignKey("radio_sessions.id", ondelete="SET NULL")),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("position_s", sa.Float),
        sa.Column("duration_s", sa.Float),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("mode", sa.String(32)),
        sa.Column("details", pg.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.create_index("ix_events_user_time", "listening_events", ["user_id", "occurred_at"])
    op.create_index("ix_events_track", "listening_events", ["track_id"])
    op.create_index("ix_events_play", "listening_events", ["play_id"])
    op.create_index("ix_events_radio_session", "listening_events", ["radio_session_id"])

    op.create_table(
        "track_preferences",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("track_id", sa.BigInteger, sa.ForeignKey("tracks.id"), primary_key=True),
        sa.Column("liked", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("play_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("completed_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("skip_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("early_skip_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("late_skip_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("listened_s", sa.Float, nullable=False, server_default=sa.text("0")),
        sa.Column("last_played_at", sa.DateTime(timezone=True)),
        sa.Column("last_completed_at", sa.DateTime(timezone=True)),
        sa.Column("last_skipped_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )
    op.create_index("ix_prefs_user_last_played", "track_preferences", ["user_id", "last_played_at"])
    op.create_index("ix_prefs_user_liked", "track_preferences", ["user_id", "liked"])

    op.create_table(
        "radio_queue_items",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("session_id", pg.UUID(as_uuid=True), sa.ForeignKey("radio_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("track_id", sa.BigInteger, sa.ForeignKey("tracks.id"), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("score", sa.Float, nullable=False),
        sa.Column("score_breakdown", pg.JSONB, nullable=False),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default=sa.text("'queued'")),
        sa.Column("state_version", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.UniqueConstraint("session_id", "position", name="uq_radio_items_session_position"),
    )
    op.create_index("ix_radio_items_session_status", "radio_queue_items", ["session_id", "status"])

    op.create_table(
        "library_syncs",
        sa.Column("id", sa.Integer, sa.Identity(), primary_key=True),
        sa.Column("trigger", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("tracks_seen", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("tracks_added", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("tracks_updated", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("tracks_missing", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("error", sa.Text),
    )


def downgrade() -> None:
    # Destroys listening history; only for development. Never run on a live install.
    for table in ["library_syncs", "radio_queue_items", "track_preferences", "listening_events", "radio_sessions", "tracks", "users"]:
        op.drop_table(table)
