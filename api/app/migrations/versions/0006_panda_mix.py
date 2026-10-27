"""PandaFM 5.2 Panda Mix: track analysis and manual transition overrides.

Additive: two new tables. Nothing existing is touched or dropped.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-26
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mix_track_analysis",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("navidrome_id", sa.String(200), nullable=False, unique=True),
        sa.Column("source_revision", sa.String(64), nullable=True),
        sa.Column("analysis_version", sa.Integer, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column("error", sa.String(300), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_table(
        "mix_transition_overrides",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("playlist_scope", sa.String(200), nullable=False),
        sa.Column("from_track", sa.String(200), nullable=False),
        sa.Column("to_track", sa.String(200), nullable=False),
        sa.Column("plan", JSONB, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("user_id", "playlist_scope", "from_track", "to_track", name="uq_mix_override_pair"),
    )


def downgrade() -> None:
    op.drop_table("mix_transition_overrides")
    op.drop_table("mix_track_analysis")
