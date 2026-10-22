"""Shared FastAPI dependencies.

Routers ask for what they need through these functions instead of reading
app.state directly, so tests can swap any of them with
app.dependency_overrides. Stage 3 adds get_session() and get_current_user()
here; the latter returns the single default user in 0.1 and is the one
place real authentication would plug in later.
"""

from typing import Annotated

from collections.abc import AsyncIterator

from fastapi import Depends, Path, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.navidrome.client import NavidromeClient


def get_db_engine(request: Request) -> AsyncEngine:
    return request.app.state.db_engine


def get_navidrome(request: Request) -> NavidromeClient:
    return request.app.state.navidrome


NavidromeDep = Annotated[NavidromeClient, Depends(get_navidrome)]


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.session_factory() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]

DEFAULT_USERNAME = "default"


async def get_current_user_id(request: Request, session: SessionDep) -> int:
    """The person using PandaFM. Single-user for now: always the default user.

    This is the one place real authentication will plug in later.
    """
    cached = getattr(request.app.state, "default_user_id", None)
    if cached is not None:
        return cached
    from app.models import User  # local import keeps app.deps light for tests without a DB

    user_id = await session.scalar(select(User.id).where(User.username == DEFAULT_USERNAME))
    if user_id is None:
        raise RuntimeError("The default user is missing; run `python -m app.migrate upgrade`.")
    request.app.state.default_user_id = user_id
    return user_id


UserId = Annotated[int, Depends(get_current_user_id)]

# Navidrome ids (songs, albums, artists, artwork). They are only ever sent to
# Navidrome as query parameters, so a length cap is the only check needed.
ItemId = Annotated[str, Path(min_length=1, max_length=200)]
