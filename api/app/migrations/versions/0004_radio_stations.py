"""Saved radio stations, and which station started a radio session.

Additive: one new table and one nullable column (SET NULL when a station is
deleted, so sessions and history stay intact).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-24
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "radio_stations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("genres", JSONB, nullable=False),
        sa.Column("preset", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_radio_stations_user", "radio_stations", ["user_id"])
    op.add_column("radio_sessions", sa.Column("station_id", UUID(as_uuid=True), sa.ForeignKey("radio_stations.id", ondelete="SET NULL"), nullable=True))


def downgrade() -> None:
    op.drop_column("radio_sessions", "station_id")
    op.drop_table("radio_stations")
