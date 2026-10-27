"""PandaFM 5.3: the external music server, stored by PandaFM (password encrypted).

Additive: one new table. Nothing existing is touched or dropped.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "music_server",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("url", sa.String(500), nullable=False),
        sa.Column("username", sa.String(200), nullable=False),
        sa.Column("password_sealed", sa.String(1000), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("music_server")
