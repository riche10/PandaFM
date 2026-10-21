"""GET /api/health: is PandaFM wired up correctly?

Answers HTTP 200 whenever the API process is alive, so Docker never
restarts the API just because Navidrome is mid-scan or the database is
restarting. The body says which dependencies are reachable and why not.
"""

import asyncio
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncEngine

from app import __version__
from app.db import ping_database
from app.deps import get_db_engine, get_navidrome
from app.navidrome.client import NavidromeAuthError, NavidromeClient, NavidromeError

log = logging.getLogger(__name__)
router = APIRouter(tags=["system"])

CHECK_TIMEOUT_SECONDS = 5.0


class DatabaseStatus(BaseModel):
    ok: bool
    detail: str | None = None
    server_version: str | None = None


class NavidromeStatus(BaseModel):
    ok: bool
    detail: str | None = None
    server_type: str | None = None
    server_version: str | None = None
    open_subsonic: bool | None = None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    database: DatabaseStatus
    navidrome: NavidromeStatus


@router.get("/health", response_model=HealthResponse)
async def health(
    engine: Annotated[AsyncEngine, Depends(get_db_engine)],
    navidrome: Annotated[NavidromeClient, Depends(get_navidrome)],
) -> HealthResponse:
    database, navidrome_status = await asyncio.gather(
        _check_database(engine), _check_navidrome(navidrome)
    )
    return HealthResponse(
        status="ok" if database.ok and navidrome_status.ok else "degraded",
        version=__version__,
        database=database,
        navidrome=navidrome_status,
    )


async def _check_database(engine: AsyncEngine) -> DatabaseStatus:
    try:
        version = await asyncio.wait_for(ping_database(engine), CHECK_TIMEOUT_SECONDS)
    except TimeoutError:
        return DatabaseStatus(ok=False, detail="The database did not answer within 5 seconds.")
    except Exception as exc:  # a health check reports failures, it never raises
        log.warning("Database health check failed: %s", exc)
        return DatabaseStatus(ok=False, detail=_first_line(exc))
    return DatabaseStatus(ok=True, server_version=version)


async def _check_navidrome(client: NavidromeClient) -> NavidromeStatus:
    try:
        info = await asyncio.wait_for(client.ping(), CHECK_TIMEOUT_SECONDS)
    except TimeoutError:
        return NavidromeStatus(ok=False, detail="Navidrome did not answer within 5 seconds.")
    except NavidromeAuthError as exc:
        return NavidromeStatus(
            ok=False,
            detail=(
                f"Navidrome rejected PandaFM's login ({exc}). Check NAVIDROME_USER "
                "and NAVIDROME_PASSWORD in .env match a Navidrome account."
            ),
        )
    except NavidromeError as exc:
        log.warning("Navidrome health check failed: %s", exc)
        return NavidromeStatus(ok=False, detail=str(exc))
    return NavidromeStatus(
        ok=True,
        server_type=info.server_type,
        server_version=info.server_version,
        open_subsonic=info.open_subsonic,
    )


def _first_line(exc: Exception) -> str:
    # SQLAlchemy wraps driver errors; the driver's own message is the useful part.
    original = getattr(exc, "orig", None) or exc
    lines = str(original).strip().splitlines()
    return (lines[0] if lines else type(original).__name__)[:300]
