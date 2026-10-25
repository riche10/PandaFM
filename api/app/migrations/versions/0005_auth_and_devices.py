"""PandaFM 5.0: owner authentication and device sessions.

Additive: password columns on users (NULL until the owner completes setup,
which turns the existing default user into the owner, keeping all history)
and a new auth_sessions table. Nothing is dropped.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_hash", sa.Text, nullable=True))
    op.add_column("users", sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "auth_sessions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("access_hash", sa.String(64), nullable=True, unique=True),
        sa.Column("access_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("csrf_token", sa.String(64), nullable=True),
        sa.Column("device_name", sa.String(80), nullable=False),
        sa.Column("platform", sa.String(24), nullable=False),
        sa.Column("user_agent", sa.String(120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_auth_sessions_user", "auth_sessions", ["user_id"])


def downgrade() -> None:
    op.drop_table("auth_sessions")
    op.drop_column("users", "password_changed_at")
    op.drop_column("users", "password_hash")
