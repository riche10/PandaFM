"""Custom radio presets, built-in mode names, and preset snapshots on sessions.

Additive: a new table, new nullable columns, and a users.preferences column
defaulting to {}. Existing sessions keep using their built-in mode.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-24
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("preferences", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")))
    op.create_table(
        "radio_presets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("base_mode", sa.String(32), nullable=False),
        sa.Column("controls", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_radio_presets_user", "radio_presets", ["user_id"])
    op.add_column("radio_sessions", sa.Column("preset_id", UUID(as_uuid=True), sa.ForeignKey("radio_presets.id", ondelete="SET NULL"), nullable=True))
    op.add_column("radio_sessions", sa.Column("display_name", sa.String(80), nullable=True))
    op.add_column("radio_sessions", sa.Column("profile", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("radio_sessions", "profile")
    op.drop_column("radio_sessions", "display_name")
    op.drop_column("radio_sessions", "preset_id")
    op.drop_table("radio_presets")
    op.drop_column("users", "preferences")
