"""Alembic environment. Run migrations with `python -m app.migrate` (see that module)."""

from alembic import context

from app.models import Base

connection = context.config.attributes["connection"]
context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
with context.begin_transaction():
    context.run_migrations()
