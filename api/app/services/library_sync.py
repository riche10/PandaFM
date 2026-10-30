"""Copy Navidrome's song metadata into PandaFM's `tracks` cache.

Navidrome stays authoritative. Songs are upserted by Navidrome id; songs no
longer in Navidrome are flagged unavailable (never deleted, so history
survives). Stars may import likes (PandaFM owns them; see services/favorites.py). Pages are
fetched with a short pause so Navidrome isn't hammered, and a run is
idempotent: running it twice changes nothing the second time.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, literal_column, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.audio.quality import revision
from app.models import LibrarySync, Track, TrackPreference
from app.navidrome.parse import facts_of
from app.navidrome.client import NavidromeClient, NavidromeError
from app.schemas.library import Track as TrackOut
from app.schemas.library import TrackListOrder

log = logging.getLogger(__name__)

PAGE_SIZE = 500
PAGE_PAUSE_S = 0.05
RESYNC_AFTER = timedelta(hours=6)  # full refresh at least this often
CHECK_EVERY_S = 600  # how often the background task looks for a new Navidrome scan
STARTUP_DELAY_S = 20


class LibrarySyncer:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession], navidrome: NavidromeClient, user_id_lookup) -> None:
        self._sessions = session_factory
        self._navidrome = navidrome
        self._user_id = user_id_lookup  # async () -> int
        self._lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self._lock.locked()

    async def run(self, trigger: str) -> dict[str, Any]:
        """Run one sync now (or wait for the one in progress) and return its status."""
        if self._lock.locked():
            async with self._lock:  # someone else is syncing; wait for their result
                pass
            return await self.status()
        async with self._lock:
            await self._sync(trigger)
        return await self.status()

    async def _sync(self, trigger: str) -> None:
        if getattr(self._navidrome, "configured", True) is False:
            return  # 5.3: nothing to import until the owner connects a music server
        user_id = await self._user_id()
        async with self._sessions() as db:
            run = LibrarySync(trigger=trigger, status="running")
            db.add(run)
            await db.commit()
            run_id, started_at = run.id, run.started_at

        seen = added = 0
        try:
            offset = 0
            while True:
                page = await self._navidrome.list_tracks(TrackListOrder.all, size=PAGE_SIZE, offset=offset)
                if page:
                    async with self._sessions() as db:
                        added += await upsert_tracks(db, user_id, page)
                        await db.commit()
                seen += len(page)
                if len(page) < PAGE_SIZE:
                    break
                offset += PAGE_SIZE
                await asyncio.sleep(PAGE_PAUSE_S)

            async with self._sessions() as db:
                available = await db.scalar(select(func.count()).select_from(Track).where(Track.is_available))
                if seen == 0 and available:
                    # Navidrome reporting an empty library (e.g. the NAS isn't mounted) is
                    # far likelier than every song vanishing. Leave the cache alone.
                    raise RuntimeError("Navidrome returned no songs; keeping the cached library as it is.")
                missing = (
                    await db.execute(
                        update(Track)
                        .where(Track.is_available, (Track.last_synced_at.is_(None)) | (Track.last_synced_at < started_at))
                        .values(is_available=False)
                    )
                ).rowcount
                from app.services.favorites import transfer_identities

                await transfer_identities(db, user_id)  # a replaced backend's new ids keep the likes and history
                await db.execute(
                    update(LibrarySync)
                    .where(LibrarySync.id == run_id)
                    .values(status="completed", finished_at=func.now(), tracks_seen=seen, tracks_added=added, tracks_updated=seen - added, tracks_missing=missing)
                )
                await db.commit()
            log.info("Library sync done: %s songs, %s new, %s unavailable", seen, added, missing)
        except (NavidromeError, RuntimeError, OSError) as exc:
            log.warning("Library sync failed: %s", exc)
            async with self._sessions() as db:
                await db.execute(
                    update(LibrarySync)
                    .where(LibrarySync.id == run_id)
                    .values(status="failed", finished_at=func.now(), tracks_seen=seen, tracks_added=added, error=str(exc)[:500])
                )
                await db.commit()

    async def status(self) -> dict[str, Any]:
        async with self._sessions() as db:
            last = await db.scalar(select(LibrarySync).order_by(LibrarySync.id.desc()).limit(1))
            last_ok = await db.scalar(select(LibrarySync).where(LibrarySync.status == "completed").order_by(LibrarySync.id.desc()).limit(1))
            total = await db.scalar(select(func.count()).select_from(Track))
            available = await db.scalar(select(func.count()).select_from(Track).where(Track.is_available))
        return {
            "running": self.running,
            "tracks_total": total or 0,
            "tracks_available": available or 0,
            "last_run": _run_dict(last),
            "last_success": _run_dict(last_ok),
        }

    async def needs_sync(self) -> bool:
        async with self._sessions() as db:
            last_ok = await db.scalar(select(LibrarySync).where(LibrarySync.status == "completed").order_by(LibrarySync.id.desc()).limit(1))
        if last_ok is None or datetime.now(UTC) - last_ok.started_at > RESYNC_AFTER:
            return True
        try:
            scan = await self._navidrome.get_scan_status()
        except NavidromeError:
            return False
        return bool(scan.last_scan and scan.last_scan > last_ok.started_at and not scan.scanning)

    async def ensure_synced(self, timeout_s: float = 120) -> None:
        """Radio needs a cache: sync once if PandaFM has never synced."""
        async with self._sessions() as db:
            done = await db.scalar(select(func.count()).select_from(LibrarySync).where(LibrarySync.status == "completed"))
        if not done:
            await asyncio.wait_for(self.run("radio"), timeout_s)

    async def run_periodically(self) -> None:
        """Background task: sync after start-up, then whenever Navidrome has rescanned."""
        try:
            async with self._sessions() as db:  # a run interrupted by a restart is not running any more
                await db.execute(update(LibrarySync).where(LibrarySync.status == "running").values(status="failed", error="Interrupted by a restart", finished_at=func.now()))
                await db.commit()
        except Exception:  # the database may not be up yet; the loop below retries anyway
            log.warning("Couldn't tidy up earlier sync runs", exc_info=True)
        await asyncio.sleep(STARTUP_DELAY_S)
        first = True
        while True:
            try:
                if await self.needs_sync():
                    await self.run("startup" if first else "scheduled")
            except Exception:  # never let the background task die
                log.exception("Scheduled library sync failed")
            first = False
            await asyncio.sleep(CHECK_EVERY_S)


def _run_dict(run: LibrarySync | None) -> dict[str, Any] | None:
    if run is None:
        return None
    return {
        "id": run.id,
        "trigger": run.trigger,
        "status": run.status,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "tracks_seen": run.tracks_seen,
        "tracks_added": run.tracks_added,
        "tracks_updated": run.tracks_updated,
        "tracks_missing": run.tracks_missing,
        "error": run.error,
    }


def track_row(t: TrackOut) -> dict[str, Any]:
    return {
        "navidrome_id": t.id,
        "title": t.title,
        "artist": t.artist,
        "artist_id": t.artist_id,
        "album": t.album,
        "album_id": t.album_id,
        "genres": t.genres,
        "year": t.year,
        "duration_s": t.duration_seconds,
        "cover_art_id": t.cover_art_id,
        "suffix": t.suffix,
        "bitrate_kbps": t.bitrate_kbps,
        "sample_rate": t.sample_rate,
        "bit_depth": t.bit_depth,
        "channels": t.channels,
        "size_bytes": t.size_bytes,
        "source_revision": revision(facts_of(t)) if t.suffix else None,
    }


async def upsert_tracks(db: AsyncSession, user_id: int, tracks: list[TrackOut]) -> int:
    """Insert or refresh songs; mirror Navidrome stars. Returns how many were new."""
    stmt = pg_insert(Track).values([track_row(t) for t in tracks])
    fields = ["title", "artist", "artist_id", "album", "album_id", "genres", "year", "duration_s", "cover_art_id",
              "suffix", "bitrate_kbps", "sample_rate", "bit_depth", "channels", "size_bytes", "source_revision"]
    stmt = stmt.on_conflict_do_update(
        index_elements=[Track.navidrome_id],
        set_={**{f: stmt.excluded[f] for f in fields}, "is_available": True, "last_synced_at": func.now()},
    ).returning(Track.id, Track.navidrome_id, literal_column("(xmax = 0)").label("inserted"))
    rows = (await db.execute(stmt)).all()
    ids = {nid: tid for tid, nid, _ in rows}
    # New rows get last_synced_at too (the INSERT path doesn't run the SET clause).
    await db.execute(update(Track).where(Track.id.in_(list(ids.values())), Track.last_synced_at.is_(None)).values(last_synced_at=func.now()))

    # 5.5.2: PandaFM owns track likes. A star may import one (see services/favorites.py); a song without a
    # star changes nothing. Before 5.5.2 an unstarred song was written liked=False, so a fresh music server
    # (zero stars) erased every Liked Song.
    from app.services.favorites import import_stars

    await import_stars(db, user_id, [ids[t.id] for t in tracks if t.favorite and t.id in ids])
    return sum(1 for *_, inserted in rows if inserted)


async def ensure_track(db: AsyncSession, snapshot: dict[str, Any]) -> int:
    """The cache id for a Navidrome song, adding it from the app's snapshot if needed."""
    stmt = pg_insert(Track).values({**snapshot, "last_synced_at": None}).on_conflict_do_nothing(index_elements=[Track.navidrome_id])
    await db.execute(stmt)
    return (await db.execute(text("SELECT id FROM tracks WHERE navidrome_id = :nid"), {"nid": snapshot["navidrome_id"]})).scalar_one()
