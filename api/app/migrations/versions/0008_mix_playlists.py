"""PandaFM 5.3: persistent Panda Mix playlists (their own stable mixed order).

Additive: one new table. Nothing existing is touched or dropped.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mix_playlists",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("playlist_id", sa.String(200), nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("seed", sa.Integer, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("mixed_order", JSONB, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("user_id", "playlist_id", name="uq_mix_playlist"),
    )


def downgrade() -> None:
    op.drop_table("mix_playlists")
