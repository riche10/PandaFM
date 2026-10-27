"""PandaFM 5.3: the external music server's saved configuration.

Additive: one new table. The password is stored only as AES-GCM ciphertext
(key in PandaFM's config volume). Nothing existing is touched.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "music_server",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("server_url", sa.String(500), nullable=False),
        sa.Column("username", sa.String(200), nullable=False),
        sa.Column("password_enc", sa.String(1000), nullable=False),
        sa.Column("key_id", sa.String(32), nullable=False),
        sa.Column("server_type", sa.String(100), nullable=True),
        sa.Column("server_version", sa.String(100), nullable=True),
        sa.Column("api_version", sa.String(32), nullable=True),
        sa.Column("open_subsonic", sa.Boolean, nullable=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("id = 1", name="music_server_single_row"),
    )


def downgrade() -> None:
    op.drop_table("music_server")
