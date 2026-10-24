"""Audio facts on cached tracks, and the conversion cache index.

Purely additive: new nullable columns and one new table. The next library
sync fills the new columns.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-23
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for name, column_type in [
        ("suffix", sa.String(16)),
        ("bitrate_kbps", sa.Integer()),
        ("sample_rate", sa.Integer()),
        ("bit_depth", sa.Integer()),
        ("channels", sa.Integer()),
        ("size_bytes", sa.BigInteger()),
        ("source_revision", sa.String(32)),
    ]:
        op.add_column("tracks", sa.Column(name, column_type, nullable=True))

    op.create_table(
        "conversions",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("track_id", sa.BigInteger, sa.ForeignKey("tracks.id"), nullable=False),
        sa.Column("profile", sa.String(32), nullable=False),
        sa.Column("source_revision", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("file_name", sa.String(200)),
        sa.Column("size_bytes", sa.BigInteger),
        sa.Column("sha256", sa.String(64)),
        sa.Column("error", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("last_accessed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("track_id", "profile", "source_revision", name="uq_conversions_track_profile_revision"),
    )
    op.create_index("ix_conversions_last_accessed", "conversions", ["last_accessed_at"])


def downgrade() -> None:
    op.drop_table("conversions")
    for name in ["suffix", "bitrate_kbps", "sample_rate", "bit_depth", "channels", "size_bytes", "source_revision"]:
        op.drop_column("tracks", name)
