"""Shared FastAPI dependencies.

Routers ask for what they need through these functions instead of reading
app.state directly, so tests can swap any of them with
app.dependency_overrides. Stage 3 adds get_session() and get_current_user()
here; the latter returns the single default user in 0.1 and is the one
place real authentication would plug in later.
"""

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncEngine

from app.navidrome.client import NavidromeClient


def get_db_engine(request: Request) -> AsyncEngine:
    return request.app.state.db_engine


def get_navidrome(request: Request) -> NavidromeClient:
    return request.app.state.navidrome
