"""Panda Mix analysis jobs and transition plans (5.2).

Only tracks a Panda Mix asks for are analysed (a rolling lookahead, or a
downloaded playlist the user prepares), never the whole library. Work is
bounded (PANDAFM_MIX_ANALYSIS_WORKERS), prioritised (current transition
first), coalesced, niced below streaming, and reused until the source file or
the analysis version changes. Source audio is read from a private temporary
copy; library files are never touched.
"""

import asyncio
import itertools
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.audio.quality import AudioFacts, revision
from app.mix import analysis as mix_analysis
from app.mix.planner import plan as plan_transition
from app.mix.planner import validate_override
from app.models import MixTrackAnalysis, MixTransitionOverride

log = logging.getLogger("pandafm.mix")
MEMO_MAX = 4000


def _nice_thread() -> None:
    try:
        os.nice(10)  # numpy work yields to streaming and transcoding
    except OSError:
        pass


class MixAnalyzer:
    def __init__(self, root: str | Path, sessions: async_sessionmaker[AsyncSession], navidrome, workers: int = 1) -> None:
        self.tmp = Path(root) / "mix-tmp"
        self._sessions = sessions
        self._navidrome = navidrome
        self.workers = max(1, workers)
        self._queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._seq = itertools.count()
        self._queued: dict[str, int] = {}  # track -> best priority waiting
        self._running: set[str] = set()
        self._tasks: list[asyncio.Task] = []
        self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="panda-dj", initializer=_nice_thread)
        self.analysed = 0  # for tests and diagnostics

    def start(self) -> None:
        try:
            self.tmp.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            log.warning("Panda Mix can't use %s: %s", self.tmp, exc)
        if not self._tasks:
            self._tasks = [asyncio.create_task(self._work()) for _ in range(self.workers)]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        self._pool.shutdown(wait=False, cancel_futures=True)

    def state_of(self, track_id: str) -> str | None:
        if track_id in self._running:
            return "running"
        return "queued" if track_id in self._queued else None

    def schedule(self, track_id: str, priority: int) -> None:
        """Ask for an analysis; repeated asks coalesce (the better priority wins)."""
        if track_id in self._running:
            return
        if track_id in self._queued and self._queued[track_id] <= priority:
            return
        self._queued[track_id] = priority
        self._queue.put_nowait((priority, next(self._seq), track_id))

    async def drain(self) -> None:
        """Tests: wait until nothing is queued or running."""
        while self._queued or self._running:
            await asyncio.sleep(0.05)

    async def _work(self) -> None:
        while True:
            priority, _, track_id = await self._queue.get()
            if self._queued.get(track_id) != priority:
                continue  # superseded by a better-priority request
            del self._queued[track_id]
            if load_is_high():
                await asyncio.sleep(2)  # the server is busy: playback first
            self._running.add(track_id)
            try:
                await self._analyse(track_id)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001  (one bad file must never stop the worker)
                log.exception("Panda Mix analysis crashed for a track")
            finally:
                self._running.discard(track_id)

    async def _analyse(self, track_id: str) -> None:
        async with self._sessions() as db:
            rev = await source_revision(db, track_id)
        path = self.tmp / f"{uuid.uuid4().hex}.src"
        status, payload, error = "failed", None, None
        try:
            stream = await self._navidrome.open_stream(track_id)
            try:
                if stream.status_code != 200:
                    raise mix_analysis.AnalysisError(f"Navidrome answered {stream.status_code}")
                with open(path, "wb") as out:
                    async for chunk in stream.iter_bytes():
                        out.write(chunk)
            finally:
                await stream.aclose()
            payload = await asyncio.get_running_loop().run_in_executor(self._pool, mix_analysis.analyze_file, path)
            status = "ready"
            self.analysed += 1
            log.info("PandaDJ analysed track=%s bpm=%s conf=%s", track_id, payload.get("bpm"), payload.get("bpm_confidence"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001  (unreachable source, bad file...): recorded as failed, never retried in a loop
            error = (str(exc) or exc.__class__.__name__)[:300]
            log.warning("PandaDJ analysis failed for track=%s: %s", track_id, error)
        finally:
            path.unlink(missing_ok=True)
        async with self._sessions() as db:
            stmt = insert(MixTrackAnalysis).values(navidrome_id=track_id, source_revision=rev, analysis_version=mix_analysis.ANALYSIS_VERSION,
                                                   status=status, payload=payload, error=error)
            await db.execute(stmt.on_conflict_do_update(index_elements=["navidrome_id"], set_={
                "source_revision": rev, "analysis_version": mix_analysis.ANALYSIS_VERSION, "status": status, "payload": payload,
                "error": error, "updated_at": text("now()")}))
            await db.commit()


def load_is_high() -> bool:
    try:
        return os.getloadavg()[0] > (os.cpu_count() or 1) * 0.9
    except OSError:
        return False


async def source_revision(db: AsyncSession, track_id: str) -> str | None:
    r = (await db.execute(text("SELECT suffix, bitrate_kbps, sample_rate, bit_depth, channels, size_bytes, duration_s FROM tracks WHERE navidrome_id = :i"),
                          {"i": track_id})).first()
    if r is None or r.suffix is None:
        return None
    return revision(AudioFacts(r.suffix, None, r.bitrate_kbps, r.sample_rate, r.bit_depth, r.channels, r.size_bytes, r.duration_s))


async def usable_analyses(db: AsyncSession, ids: list[str]) -> dict[str, dict]:
    """Ready analyses that still match the source and the analysis version (stale ones are re-done)."""
    if not ids:
        return {}
    rows = (await db.execute(select(MixTrackAnalysis).where(MixTrackAnalysis.navidrome_id.in_(ids)))).scalars().all()
    out = {}
    for r in rows:
        if r.analysis_version != mix_analysis.ANALYSIS_VERSION or r.status not in ("ready", "failed"):
            continue
        if r.source_revision is not None and r.source_revision != await source_revision(db, r.navidrome_id):
            continue  # the file changed: analyse again
        out[r.navidrome_id] = {"status": r.status, "payload": r.payload}
    return out


_memo: dict[tuple, dict] = {}


def auto_plan(a: dict, b: dict, aa: dict | None, ba: dict | None, mode: str) -> dict:
    """Plans are a pure function of the two analyses: memoised per directional pair."""
    key = (a.get("id"), b.get("id"), mode, id(aa) if False else (aa or {}).get("duration_ms"), (aa or {}).get("bpm"), (ba or {}).get("duration_ms"), (ba or {}).get("bpm"),
           a.get("album_id"), b.get("album_id"), a.get("track_number"), b.get("track_number"), mix_analysis.ANALYSIS_VERSION)
    if key not in _memo:
        if len(_memo) > MEMO_MAX:
            _memo.clear()
        _memo[key] = plan_transition(a, b, aa, ba, mode)
    return dict(_memo[key])


async def overrides(db: AsyncSession, user_id: int, playlist_id: str | None, pairs: list[tuple[str, str]]) -> dict[tuple[str, str], dict]:
    if not pairs:
        return {}
    rows = (await db.execute(select(MixTransitionOverride).where(MixTransitionOverride.user_id == user_id,
                                                                MixTransitionOverride.playlist_scope.in_([playlist_id or "", ""])))).scalars().all()
    wanted = set(pairs)
    out: dict[tuple[str, str], dict] = {}
    for r in sorted(rows, key=lambda r: r.playlist_scope == ""):  # playlist-specific first
        k = (r.from_track, r.to_track)
        if k in wanted and k not in out:
            out[k] = {**r.plan, "manual": True, "override_scope": "playlist" if r.playlist_scope else "any"}
    return out


async def prepare(db: AsyncSession, analyzer: MixAnalyzer | None, user_id: int, tracks: list[dict], current: int, lookahead: int,
                  mode: str, playlist_id: str | None, all_pairs: bool, priority_base: int = 0) -> dict:
    """Readiness and plans for a Panda Mix order (already shuffled, if shuffled). Idempotent."""
    ids = [t["id"] for t in tracks]
    found = await usable_analyses(db, ids)
    lo, hi = max(0, current), min(len(tracks), max(0, current) + lookahead + 1)
    if analyzer is not None:
        for k in range(lo, hi):
            if ids[k] not in found:
                analyzer.schedule(ids[k], priority_base + k - lo)
    def status(i: str) -> str:
        if i in found:
            return found[i]["status"]
        return (analyzer.state_of(i) if analyzer else None) or "missing"
    pair_range = range(len(tracks) - 1) if all_pairs else range(lo, max(lo, hi - 1))
    pairs = [(ids[k], ids[k + 1]) for k in pair_range]
    manual = await overrides(db, user_id, playlist_id, pairs)
    transitions = []
    for k in pair_range:
        a, b = tracks[k], tracks[k + 1]
        aa = found.get(a["id"], {}).get("payload") if found.get(a["id"], {}).get("status") == "ready" else None
        ba = found.get(b["id"], {}).get("payload") if found.get(b["id"], {}).get("status") == "ready" else None
        p = auto_plan(a, b, aa, ba, mode)
        p.setdefault("ready", True)
        if (a["id"], b["id"]) in manual:
            p = {**p, **manual[(a["id"], b["id"])], "ready": True}
        p["index"] = k
        transitions.append(p)
    states = [{"id": i, "status": status(i)} for i in ids[lo:hi]]
    return {"mode": mode, "tracks": states, "transitions": transitions, "preparing": any(s["status"] in ("queued", "running", "missing") for s in states)}


async def save_override(db: AsyncSession, user_id: int, playlist_id: str | None, from_id: str, to_id: str, plan: dict,
                        a_duration_ms: int, b_duration_ms: int) -> dict:
    clean = validate_override(plan, a_duration_ms, b_duration_ms)
    stmt = insert(MixTransitionOverride).values(user_id=user_id, playlist_scope=playlist_id or "", from_track=from_id, to_track=to_id, plan=clean)
    await db.execute(stmt.on_conflict_do_update(constraint="uq_mix_override_pair", set_={"plan": clean, "updated_at": text("now()")}))
    await db.commit()
    return clean


async def reset_override(db: AsyncSession, user_id: int, playlist_id: str | None, from_id: str, to_id: str) -> bool:
    result = await db.execute(delete(MixTransitionOverride).where(MixTransitionOverride.user_id == user_id, MixTransitionOverride.playlist_scope == (playlist_id or ""),
                                                                  MixTransitionOverride.from_track == from_id, MixTransitionOverride.to_track == to_id))
    await db.commit()
    return result.rowcount > 0
