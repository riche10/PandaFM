"""Run database migrations: `python -m app.migrate [upgrade|current|check]`.

The API container runs `upgrade` before starting the web server. A
PostgreSQL advisory lock makes this safe even if two API containers start at
once: the second waits, then finds nothing left to do. Migrations only move
forward; they never drop or recreate the database volume.
"""

import logging
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from app.config import Settings, get_settings

MIGRATION_LOCK_KEY = 0x50414E44  # "PAND": an arbitrary, app-specific advisory lock id
log = logging.getLogger("pandafm.migrate")


def _config() -> Config:
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    return config


def upgrade(settings: Settings | None = None) -> str:
    """Bring the schema up to date. Returns the revision now in place."""
    engine = create_engine((settings or get_settings()).database_url, connect_args={"connect_timeout": 10})
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK_KEY})
            try:
                config = _config()
                config.attributes["connection"] = connection
                command.upgrade(config, "head")
                connection.commit()
                return current(connection) or "none"
            finally:
                connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK_KEY})
                connection.commit()
    finally:
        engine.dispose()


def current(connection) -> str | None:
    return MigrationContext.configure(connection).get_current_revision()


def head() -> str | None:
    return ScriptDirectory.from_config(_config()).get_current_head()


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    action = argv[1] if len(argv) > 1 else "upgrade"
    if action == "upgrade":
        log.info("Database schema is at revision %s", upgrade())
        return 0
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        revision = current(connection)
    if action == "current":
        print(revision or "none (no PandaFM tables yet)")
        return 0
    if action == "check":
        print(f"database: {revision or 'none'}, code expects: {head()}")
        return 0 if revision == head() else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
