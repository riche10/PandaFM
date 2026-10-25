"""Shared FastAPI dependencies.

Routers ask for what they need through these functions instead of reading
app.state directly, so tests can swap any of them with
app.dependency_overrides. get_current_user_id() returns the authenticated
owner (5.0); require_auth() guards every protected route.
"""

from typing import Annotated

from collections.abc import AsyncIterator

from fastapi import Depends, Path, Request
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


async def require_auth(request: Request, session: SessionDep):
    """The signed-in caller (5.0). Every library, media and radio route depends on this,
    either through UserId or as a router-level dependency registered in main.py."""
    from app.auth.guard import authenticate_request  # local import keeps app.deps light

    return await authenticate_request(request, session)


async def optional_auth(request: Request):
    """The caller if signed in, else None. For public routes that tell the owner more."""
    from app.auth.guard import optional_context

    return await optional_context(request)


async def get_current_user_id(auth=Depends(require_auth)) -> int:
    """The person using PandaFM: the authenticated owner."""
    return auth.user_id


UserId = Annotated[int, Depends(get_current_user_id)]

# Navidrome ids (songs, albums, artists, artwork). They are only ever sent to
# Navidrome as query parameters, so a length cap is the only check needed.
ItemId = Annotated[str, Path(min_length=1, max_length=200)]
