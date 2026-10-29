"""PandaFM API entry point (uvicorn app.main:app)."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.deps import require_auth
from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.errors import register_error_handlers
from app.routers import auth, downloads, events, explore, mix, releases, setup, favorites, health, library, me, media, playlists, radio, sync
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
        # 5.3: PandaFM starts without a music server; the owner connects one in the app. Every
        # component keeps this handle; the client behind it is swapped when the configuration changes.
        from app.navidrome.handle import NavidromeHandle
        from app.services.music_server import MusicServerManager

        app.state.navidrome = NavidromeHandle()
        app.state.music_server = MusicServerManager(
            app.state.navidrome, app.state.session_factory, cfg.config_dir,
            getattr(cfg.config_key, "get_secret_value", lambda: cfg.config_key)() if cfg.config_key else None, timeout=cfg.navidrome_timeout_seconds,
            stream_timeout=cfg.navidrome_stream_timeout_seconds,
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
        from app.services.mix import MixAnalyzer

        app.state.mix = MixAnalyzer(cfg.cache_dir, app.state.session_factory, app.state.navidrome, cfg.mix_analysis_workers)
        app.state.mix.start()  # idle until a Panda Mix asks for something
        legacy_password = cfg.navidrome_password
        await app.state.music_server.load(  # saved configuration, or a one-time import of ≤5.2 environment variables
            cfg.navidrome_url, cfg.navidrome_user, getattr(legacy_password, "get_secret_value", lambda: legacy_password)() if legacy_password else None
        )
        log.info("PandaFM API %s starting (%s)", __version__, "music server connected" if app.state.navidrome.configured else "no music server connected yet")
        try:
            yield
        finally:
            if sync_task:
                sync_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await sync_task
            await app.state.mix.stop()
            await app.state.navidrome.aclose()
            await app.state.db_engine.dispose()

    app = FastAPI(
        title="PandaFM API",
        version=__version__,
        lifespan=lifespan,
        # Interactive docs are never public: off unless PANDAFM_API_DOCS=true, and then owner-only (below).
        docs_url=None,
        openapi_url=None,
        redoc_url=None,
    )
    if settings is not None:
        app.state.settings = settings
    # Public: the health check (booleans only for anonymous callers) and sign-in/setup.
    app.include_router(health.router, prefix="/api")
    app.include_router(auth.router, prefix="/api")
    app.include_router(setup.public, prefix="/api")  # booleans only: which setup screen to show
    app.include_router(releases.router, prefix="/api")  # 5.4.1: the published Android release (public, nothing private)
    # Everything else needs a signed-in owner (5.0). Routes with a UserId parameter
    # get the same check through it; the router-level dependency covers the rest.
    signed_in = [Depends(require_auth)]
    for module in (library, media, favorites, playlists, events, sync, radio, me, downloads, explore, mix):
        app.include_router(module.router, prefix="/api", dependencies=signed_in)
    app.include_router(setup.router, prefix="/api", dependencies=signed_in)  # the owner's music server settings
    if (settings or _docs_enabled()) and (settings.api_docs if settings else _docs_enabled()):
        _owner_only_docs(app)
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
    """The owner (5.0), or before setup the default user it will become: the same row either way."""
    from sqlalchemy import select

    from app.models import User

    async with app.state.session_factory() as session:
        user_id = await session.scalar(select(User.id).order_by(User.password_hash.is_(None), User.id).limit(1))
    if user_id is None:
        raise RuntimeError("No user exists; run `python -m app.migrate upgrade`.")
    return user_id


def _docs_enabled() -> bool:
    try:
        return get_settings().api_docs
    except Exception:  # noqa: BLE001
        return False


def _owner_only_docs(app: FastAPI) -> None:
    from fastapi.openapi.docs import get_swagger_ui_html

    @app.get("/api/openapi.json", include_in_schema=False, dependencies=[Depends(require_auth)])
    async def openapi_json():
        return app.openapi()

    @app.get("/api/docs", include_in_schema=False, dependencies=[Depends(require_auth)])
    async def docs():
        return get_swagger_ui_html(openapi_url="/api/openapi.json", title="PandaFM API")


app = create_app()
