"""PandaFM API entry point (uvicorn app.main:app)."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import __version__
from app.config import Settings, get_settings
from app.db import create_engine
from app.errors import register_error_handlers
from app.navidrome.client import NavidromeClient
from app.routers import health, library

log = logging.getLogger("pandafm")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app. Settings are resolved at startup, not import time,
    so tests can pass their own."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cfg = settings or get_settings()
        logging.basicConfig(
            level=cfg.log_level.upper(),
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )

        # Long-lived shared resources, closed cleanly on shutdown.
        app.state.settings = cfg
        app.state.db_engine = create_engine(cfg)
        app.state.navidrome = NavidromeClient(
            cfg.navidrome_url,
            cfg.navidrome_user,
            cfg.navidrome_password.get_secret_value(),
            timeout=cfg.navidrome_timeout_seconds,
        )
        log.info("PandaFM API %s starting (Navidrome at %s)", __version__, cfg.navidrome_url)
        try:
            yield
        finally:
            await app.state.navidrome.aclose()
            await app.state.db_engine.dispose()

    app = FastAPI(
        title="PandaFM API",
        version=__version__,
        lifespan=lifespan,
        # Everything lives under /api so the web container's Nginx routes it with one rule.
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.include_router(health.router, prefix="/api")
    app.include_router(library.router, prefix="/api")
    register_error_handlers(app)
    return app


app = create_app()
