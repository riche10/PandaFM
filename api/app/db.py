"""Database engine and sessions.

Tables are defined in app.models and created by Alembic migrations
(app.migrate), never by create_all().
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings


def create_engine(settings: Settings) -> AsyncEngine:
    return create_async_engine(
        settings.database_url,
        pool_pre_ping=True,  # survive the database container restarting
        pool_size=5,
        max_overflow=5,
        connect_args={"connect_timeout": 5},
    )


async def ping_database(engine: AsyncEngine) -> str:
    """Run a trivial query and return the PostgreSQL server version."""
    async with engine.connect() as conn:
        result = await conn.execute(text("SHOW server_version"))
        return str(result.scalar_one())


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
