"""PandaFM API entry point (uvicorn app.main:app)."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.errors import register_error_handlers
from app.navidrome.client import NavidromeClient
from app.routers import downloads, events, favorites, health, library, me, media, playlists, radio, sync
from app.services.conversions import ConversionCache
from app.services.library_sync import LibrarySyncer

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
        # httpx logs every request URL at INFO, and Navidrome URLs carry the
        # Subsonic username, token and salt (a replayable login). Keep them
        # out of the container log, whatever PANDAFM_LOG_LEVEL is.
        for noisy in ("httpx", "httpcore"):
            logging.getLogger(noisy).setLevel(logging.WARNING)

        # Long-lived shared resources, closed cleanly on shutdown.
        app.state.settings = cfg
        app.state.db_engine = create_engine(cfg)
        app.state.session_factory = create_session_factory(app.state.db_engine)
        app.state.navidrome = NavidromeClient(
            cfg.navidrome_url,
            cfg.navidrome_user,
            cfg.navidrome_password.get_secret_value(),
            timeout=cfg.navidrome_timeout_seconds,
        )
        app.state.syncer = LibrarySyncer(app.state.session_factory, app.state.navidrome, lambda: _default_user_id(app))
        sync_task = asyncio.create_task(app.state.syncer.run_periodically()) if cfg.background_sync else None
        app.state.conversions = ConversionCache(
            cfg.cache_dir, int(cfg.cache_max_gb * 1024**3), app.state.session_factory, app.state.navidrome, cfg.conversion_concurrency
        )
        try:
            app.state.conversions.prepare_dirs()
        except OSError as exc:  # downloads need a writable cache; everything else works without
            log.warning("Conversion cache at %s isn't writable: %s", cfg.cache_dir, exc)
        log.info("PandaFM API %s starting (Navidrome at %s)", __version__, cfg.navidrome_url)
        try:
            yield
        finally:
            if sync_task:
                sync_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await sync_task
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
    app.include_router(media.router, prefix="/api")
    app.include_router(favorites.router, prefix="/api")
    app.include_router(playlists.router, prefix="/api")
    app.include_router(events.router, prefix="/api")
    app.include_router(sync.router, prefix="/api")
    app.include_router(radio.router, prefix="/api")
    app.include_router(me.router, prefix="/api")
    app.include_router(downloads.router, prefix="/api")
    # The Android app's WebView runs on its own origin (https://localhost) and calls
    # the API cross-origin. Browsers using PandaFM on its own address are unaffected.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=(settings or get_settings()).cors_origins if settings else _cors_origins(),
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition", "X-PandaFM-SHA256", "Retry-After"],
    )
    register_error_handlers(app)
    return app


def _cors_origins() -> list[str]:
    try:
        return get_settings().cors_origins
    except Exception:  # settings incomplete (e.g. while generating docs): use the safe default
        return ["https://localhost", "http://localhost", "capacitor://localhost"]


async def _default_user_id(app: FastAPI) -> int:
    from sqlalchemy import select

    from app.deps import DEFAULT_USERNAME
    from app.models import User

    async with app.state.session_factory() as session:
        user_id = await session.scalar(select(User.id).where(User.username == DEFAULT_USERNAME))
    if user_id is None:
        raise RuntimeError("The default user is missing; run `python -m app.migrate upgrade`.")
    return user_id


app = create_app()
