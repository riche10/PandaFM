"""The conversion cache: portable copies of songs, made with ffmpeg on demand.

- Library files are never touched: the source is fetched through Navidrome
  into a scratch file, converted, and the scratch file deleted.
- Output is written as <name>.part and renamed only once ffmpeg succeeded and
  its checksum is known, so an interrupted conversion never looks finished.
- Each (song, profile, source revision) is converted once; concurrent
  requests wait for the same job. A changed source gets a new revision.
- The cache has a size limit; the least recently used copies go first,
  never one that is being downloaded right now.
"""

import asyncio
import hashlib
import logging
import os
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.audio.files import short_hash
from app.audio.profiles import Plan, ffmpeg_args
from app.audio.quality import AudioFacts
from app.models import Conversion
from app.navidrome.client import NavidromeClient, NavidromeError
from app.schemas.library import Track

log = logging.getLogger(__name__)
CHUNK = 1 << 20


@dataclass(frozen=True)
class Ready:
    path: Path
    size_bytes: int
    sha256: str


class ConversionError(Exception):
    pass


class ConversionCache:
    def __init__(self, root: str | Path, max_bytes: int, sessions: async_sessionmaker[AsyncSession], navidrome: NavidromeClient, concurrency: int = 1) -> None:
        self.root = Path(root)
        self.files = self.root / "conversions"
        self.tmp = self.root / "tmp"
        self.max_bytes = max_bytes
        self._sessions = sessions
        self._navidrome = navidrome
        self._jobs: dict[str, asyncio.Task] = {}
        self._serving: Counter[str] = Counter()
        self._slots = asyncio.Semaphore(max(1, concurrency))

    def prepare_dirs(self) -> None:
        """Create the cache folders and remove half-written files from a previous run."""
        self.files.mkdir(parents=True, exist_ok=True)
        self.tmp.mkdir(parents=True, exist_ok=True)
        for leftover in [*self.tmp.glob("*"), *self.files.rglob("*.part")]:
            leftover.unlink(missing_ok=True)

    @staticmethod
    def key(track_id: str, profile: str, revision: str) -> str:
        return f"{short_hash(track_id, 16)}-{profile}-{revision}"

    def _path(self, key: str, extension: str) -> Path:
        return self.files / key[:2] / f"{key}.{extension}"

    async def find(self, db: AsyncSession, track_db_id: int, profile: str, revision: str) -> Conversion | None:
        """A ready conversion for this exact source revision; older revisions are dropped."""
        rows = (await db.execute(select(Conversion).where(Conversion.track_id == track_db_id, Conversion.profile == profile))).scalars().all()
        found = None
        for row in rows:
            if row.source_revision != revision:  # the library file changed since: stale
                if row.file_name:
                    (self.files / row.file_name).unlink(missing_ok=True)
                await db.delete(row)
            elif row.status == "ready" and row.file_name and (self.files / row.file_name).exists():
                found = row
        await db.commit()
        return found

    def ensure(self, track: Track, track_db_id: int, facts: AudioFacts, plan: Plan, revision: str) -> asyncio.Task:
        """Start (or join) the conversion of one song for one profile."""
        key = self.key(track.id, plan.profile, revision)
        job = self._jobs.get(key)
        if job is None or job.done():
            job = asyncio.create_task(self._convert(key, track, track_db_id, facts, plan, revision))
            self._jobs[key] = job
            job.add_done_callback(lambda _: self._jobs.pop(key, None) if self._jobs.get(key) is job else None)
        return job

    async def _convert(self, key: str, track: Track, track_db_id: int, facts: AudioFacts, plan: Plan, revision: str) -> Ready:
        final = self._path(key, plan.extension)
        part = final.with_name(final.name + ".part")
        source = self.tmp / f"{key}.source"
        cover = self.tmp / f"{key}.jpg"
        async with self._slots:
            try:
                final.parent.mkdir(parents=True, exist_ok=True)
                await self._fetch_source(track.id, source)
                has_cover = await self._fetch_cover(track.cover_art_id, cover)
                command = ffmpeg_args(facts, plan, source=str(source), cover=str(cover) if has_cover else None, output=str(part), tags=_tags(track))
                process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
                _, stderr = await process.communicate()
                if process.returncode != 0 or not part.exists() or part.stat().st_size == 0:
                    raise ConversionError((stderr or b"").decode(errors="replace").strip()[-300:] or "ffmpeg failed")
                digest = _sha256(part)
                size = part.stat().st_size
                os.replace(part, final)  # atomic: the file appears complete or not at all
                await self._record(track_db_id, plan.profile, revision, "ready", final.relative_to(self.files).as_posix(), size, digest, None)
                await self.enforce_limit()
                return Ready(final, size, digest)
            except (ConversionError, NavidromeError, OSError) as exc:
                part.unlink(missing_ok=True)
                await self._record(track_db_id, plan.profile, revision, "failed", None, None, None, str(exc)[:500])
                log.warning("Conversion of %s to %s failed: %s", track.id, plan.profile, exc)
                raise ConversionError(str(exc)) from exc
            finally:
                source.unlink(missing_ok=True)
                cover.unlink(missing_ok=True)

    async def _fetch_source(self, track_id: str, target: Path) -> None:
        stream = await self._navidrome.open_stream(track_id)
        try:
            if stream.status_code != 200:
                raise ConversionError(f"Navidrome answered {stream.status_code} for the source file")
            with open(target, "wb") as out:
                async for chunk in stream.iter_bytes():
                    out.write(chunk)
        finally:
            await stream.aclose()

    async def _fetch_cover(self, cover_art_id: str | None, target: Path) -> bool:
        if not cover_art_id:
            return False
        try:
            cover = await self._navidrome.get_cover_art(cover_art_id, size=600)
        except NavidromeError:
            return False
        if cover.content_type not in ("image/jpeg", "image/png"):
            return False  # mp4/flac muxers want JPEG or PNG
        target.write_bytes(cover.content)
        return True

    async def _record(self, track_db_id: int, profile: str, revision: str, status: str, file_name: str | None, size: int | None, digest: str | None, error: str | None) -> None:
        async with self._sessions() as db:
            stmt = pg_insert(Conversion).values(track_id=track_db_id, profile=profile, source_revision=revision, status=status,
                                                file_name=file_name, size_bytes=size, sha256=digest, error=error)
            await db.execute(stmt.on_conflict_do_update(
                constraint="uq_conversions_track_profile_revision",
                set_={"status": status, "file_name": file_name, "size_bytes": size, "sha256": digest, "error": error, "last_accessed_at": func.now()},
            ))
            await db.commit()

    @contextmanager
    def serving(self, file_name: str):
        """Mark a file as being downloaded so cleanup leaves it alone."""
        self._serving[file_name] += 1
        try:
            yield
        finally:
            self._serving[file_name] -= 1
            if self._serving[file_name] <= 0:
                del self._serving[file_name]

    async def touch(self, conversion_id: int) -> None:
        async with self._sessions() as db:
            await db.execute(update(Conversion).where(Conversion.id == conversion_id).values(last_accessed_at=func.now()))
            await db.commit()

    async def enforce_limit(self) -> int:
        """Delete least recently used copies until the cache fits. Returns bytes freed."""
        freed = 0
        async with self._sessions() as db:
            total = (await db.scalar(select(func.coalesce(func.sum(Conversion.size_bytes), 0)).where(Conversion.status == "ready"))) or 0
            if total <= self.max_bytes:
                return 0
            oldest = (await db.execute(select(Conversion).where(Conversion.status == "ready").order_by(Conversion.last_accessed_at, Conversion.id))).scalars().all()
            for row in oldest:
                if total <= self.max_bytes:
                    break
                if row.file_name in self._serving:
                    continue
                (self.files / row.file_name).unlink(missing_ok=True)
                total -= row.size_bytes or 0
                freed += row.size_bytes or 0
                await db.execute(delete(Conversion).where(Conversion.id == row.id))
            await db.commit()
        return freed

    async def stats(self) -> dict:
        async with self._sessions() as db:
            row = (await db.execute(select(func.count(), func.coalesce(func.sum(Conversion.size_bytes), 0)).where(Conversion.status == "ready"))).one()
        return {"entries": row[0], "bytes": int(row[1]), "max_bytes": self.max_bytes}

    def path_of(self, conversion: Conversion) -> Path:
        return self.files / conversion.file_name


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _tags(t: Track) -> dict[str, str]:
    return {
        "title": t.title,
        "artist": t.artist,
        "album": t.album or "",
        "album_artist": t.album_artist or t.artist,
        "track": str(t.track_number or ""),
        "disc": str(t.disc_number or ""),
        "date": str(t.year or ""),
        "genre": "; ".join(t.genres),
    }
