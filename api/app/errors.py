"""Turn Navidrome failures into user-safe HTTP responses, in one place.

Every error body has the same shape, which the web app reads:

    {"error": {"code": "not_found", "message": "That isn't in your music library."}}

Messages are written for the person using PandaFM. Technical detail goes to
the API log instead, and nothing here can contain credentials: Navidrome's
exceptions are raised without the request URL that carries the token.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.navidrome.client import (
    NavidromeAuthError,
    NavidromeError,
    NavidromeForbidden,
    NavidromeNotFound,
    NavidromeUnavailable,
    PlaylistChanged,
)

log = logging.getLogger(__name__)


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


async def navidrome_error_handler(request: Request, exc: Exception) -> JSONResponse:
    if isinstance(exc, NavidromeNotFound):
        return error_response(404, "not_found", "That isn’t in your music library.")

    if isinstance(exc, PlaylistChanged):
        return error_response(
            409, "playlist_changed", "This playlist changed somewhere else. Reload it and try again."
        )

    if isinstance(exc, NavidromeForbidden):
        return error_response(403, "forbidden", "Navidrome doesn’t allow changing that.")

    if isinstance(exc, NavidromeAuthError):
        log.error("Navidrome rejected PandaFM's credentials on %s: %s", request.url.path, exc)
        return error_response(
            503,
            "navidrome_auth",
            "PandaFM can’t sign in to Navidrome. Check NAVIDROME_USER and "
            "NAVIDROME_PASSWORD in the stack’s environment variables.",
        )

    if isinstance(exc, NavidromeUnavailable):
        log.warning("Navidrome unavailable on %s: %s", request.url.path, exc)
        return error_response(
            503,
            "navidrome_unavailable",
            "Navidrome isn’t responding, so your library can’t load right now.",
        )

    log.warning("Navidrome error on %s: %s", request.url.path, exc)
    return error_response(502, "navidrome_error", "Navidrome couldn’t complete that request.")


async def radio_error_handler(request: Request, exc: Exception) -> JSONResponse:
    return error_response(409, "radio", str(exc))


def register_error_handlers(app: FastAPI) -> None:
    # Registered on the base class; Starlette matches subclasses through the MRO.
    app.add_exception_handler(NavidromeError, navidrome_error_handler)
    from app.services.radio import RadioError  # local: keeps the handler module light

    app.add_exception_handler(RadioError, radio_error_handler)
