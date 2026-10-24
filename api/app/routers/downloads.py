"""Downloads for the Android app: song facts, manifests and the files themselves.

Only songs Navidrome knows can be downloaded, addressed by Navidrome id and a
profile name; there is no way to ask for a server path.
"""

import asyncio
import urllib.parse
from typing import Annotated

from fastapi import APIRouter, Path, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import select

from app.audio.files import relative_path
from app.audio.profiles import PROFILES, Plan, plan
from app.audio.quality import revision
from app.deps import ItemId, NavidromeDep, SessionDep, UserId
from app.errors import error_response
from app.models import Conversion
from app.models import Track as TrackRow
from app.navidrome.parse import facts_of
from app.routers.media import ProxiedAudioResponse
from app.schemas.downloads import AudioInfo, DownloadPlan, Manifest, ManifestItem, PrepareRequest, ProfileEstimate, ProfileInfo
from app.schemas.library import Track
from app.services.conversions import ConversionCache, ConversionError
from app.services.library_sync import upsert_tracks

router = APIRouter(tags=["downloads"])
ProfileId = Annotated[str, Path(pattern=r"^[a-z_]{1,32}$")]
WAIT_FOR_CONVERSION_S = 20


def _plan_out(p: Plan) -> DownloadPlan:
    return DownloadPlan(**p.__dict__)


def _cache(request: Request) -> ConversionCache:
    return request.app.state.conversions


async def _db_track_id(db, user_id: int, track: Track) -> int:
    row = await db.scalar(select(TrackRow.id).where(TrackRow.navidrome_id == track.id))
    if row is None:  # not synced yet: cache it now
        await upsert_tracks(db, user_id, [track])
        await db.commit()
        row = await db.scalar(select(TrackRow.id).where(TrackRow.navidrome_id == track.id))
    return row


@router.get("/downloads/profiles", response_model=list[ProfileInfo])
async def list_profiles() -> list[ProfileInfo]:
    return [ProfileInfo(id=p.id, label=p.label, description=p.description) for p in PROFILES.values()]


@router.get("/tracks/{track_id}/audio-info", response_model=AudioInfo)
async def audio_info(track_id: ItemId, navidrome: NavidromeDep) -> AudioInfo:
    track = await navidrome.get_track(track_id)
    facts = facts_of(track)
    return AudioInfo(track=track, quality=track.quality, source_revision=revision(facts) if track.suffix else None,
                     plans=[_plan_out(plan(facts, p)) for p in PROFILES])


@router.post("/downloads/prepare", response_model=Manifest)
async def prepare(body: PrepareRequest, request: Request, navidrome: NavidromeDep, db: SessionDep, user_id: UserId) -> Manifest | JSONResponse:
    if body.profile not in PROFILES:
        return error_response(422, "unknown_profile", f"Unknown download quality “{body.profile}”.")
    tracks, name = await _collection(body, navidrome)
    cache = _cache(request)

    # Same album, same title? Add a short id so the files can't collide.
    paths = [relative_path(artist=t.album_artist or t.artist, album=t.album, title=t.title, track_number=t.track_number,
                           disc_number=t.disc_number, extension=plan(facts_of(t), body.profile).extension, track_id=t.id) for t in tracks]
    clashes = {p for p in paths if paths.count(p) > 1}

    items: list[ManifestItem] = []
    totals = {p: [0, True] for p in PROFILES}
    for t, path in zip(tracks, paths):
        facts = facts_of(t)
        rev = revision(facts) if t.suffix else None
        chosen = plan(facts, body.profile)
        for profile_id in PROFILES:
            other = plan(facts, profile_id)
            totals[profile_id][0] += other.estimated_bytes or 0
            totals[profile_id][1] &= other.exact_size and other.estimated_bytes is not None
        size, digest, status = (chosen.estimated_bytes if chosen.exact_size else None), None, "ready"
        if chosen.action == "convert" and rev:
            db_id = await _db_track_id(db, user_id, t)
            done = await cache.find(db, db_id, body.profile, rev)
            if done:
                size, digest = done.size_bytes, done.sha256
            else:
                status = "pending"
                if body.warm:
                    cache.ensure(t, db_id, facts, chosen, rev).add_done_callback(lambda job: job.exception())  # warm up; errors surface on download
        if path in clashes:
            path = relative_path(artist=t.album_artist or t.artist, album=t.album, title=t.title, track_number=t.track_number,
                                 disc_number=t.disc_number, extension=chosen.extension, track_id=t.id, disambiguate=True)
        items.append(ManifestItem(track=t, plan=_plan_out(chosen), relative_path=path,
                                  url=f"/api/downloads/files/{urllib.parse.quote(t.id, safe='')}/{body.profile}",
                                  source_revision=rev, size_bytes=size, sha256=digest, status=status))
    return Manifest(
        kind=body.kind, id=body.id, name=name, profile=body.profile,
        duration_seconds=sum(t.duration_seconds or 0 for t in tracks), items=items,
        estimates=[ProfileEstimate(profile=p, label=PROFILES[p].label, bytes=totals[p][0], exact=totals[p][1]) for p in PROFILES],
    )


async def _collection(body: PrepareRequest, navidrome) -> tuple[list[Track], str]:
    if body.kind == "album":
        album = await navidrome.get_album(body.id or "")
        return album.tracks, album.name
    if body.kind == "playlist":
        playlist = await navidrome.get_playlist(body.id or "")
        unique = list({t.id: t for t in playlist.tracks}.values())  # a song listed twice is one file
        return unique, playlist.name
    if body.kind == "favorites":
        return (await navidrome.get_favorites()).tracks, "Favorites"
    limit = asyncio.Semaphore(4)

    async def one(track_id: str) -> Track:
        async with limit:
            return await navidrome.get_track(track_id)

    tracks = await asyncio.gather(*(one(i) for i in dict.fromkeys(body.track_ids)))
    return list(tracks), tracks[0].title if len(tracks) == 1 else f"{len(tracks)} songs"


def _disposition(track: Track, extension: str) -> str:
    name = f"{track.artist} - {track.title}.{extension}"
    return f"attachment; filename*=UTF-8''{urllib.parse.quote(name, safe='')}"


@router.get("/downloads/files/{track_id}/{profile}", responses={202: {"description": "Still converting; retry later"}})
async def download_file(track_id: ItemId, profile: ProfileId, request: Request, navidrome: NavidromeDep, db: SessionDep, user_id: UserId):
    if profile not in PROFILES:
        return error_response(404, "unknown_profile", "Unknown download quality.")
    track = await navidrome.get_track(track_id)
    facts = facts_of(track)
    chosen = plan(facts, profile)
    if chosen.action == "original":
        stream = await navidrome.open_stream(track_id, range_header=request.headers.get("range"), if_range=request.headers.get("if-range"))
        response = ProxiedAudioResponse(stream)
        response.headers["Content-Disposition"] = _disposition(track, chosen.extension)
        return response

    cache = _cache(request)
    rev = revision(facts)
    db_id = await _db_track_id(db, user_id, track)
    done = await cache.find(db, db_id, profile, rev)
    if done is None:
        job = cache.ensure(track, db_id, facts, chosen, rev)
        try:
            await asyncio.wait_for(asyncio.shield(job), WAIT_FOR_CONVERSION_S)
        except TimeoutError:
            return JSONResponse({"status": "converting"}, status_code=202, headers={"Retry-After": "5"})
        except ConversionError as exc:
            return error_response(502, "conversion_failed", f"PandaFM couldn’t convert this song ({exc}).")
        done = await cache.find(db, db_id, profile, rev)
        if done is None:
            return JSONResponse({"status": "converting"}, status_code=202, headers={"Retry-After": "5"})
    await cache.touch(done.id)
    path = cache.path_of(done)
    headers = {"Content-Disposition": _disposition(track, chosen.extension), "X-PandaFM-SHA256": done.sha256 or "", "Cache-Control": "private, max-age=86400"}
    media = "audio/flac" if chosen.extension == "flac" else "audio/mp4"
    with cache.serving(done.file_name):
        return FileResponse(path, media_type=media, headers=headers)


@router.delete("/downloads/files/{track_id}/{profile}", status_code=204)
async def forget_conversion(track_id: ItemId, profile: ProfileId, request: Request, db: SessionDep) -> Response:
    """Remove the server's cached copy only (never library files or anything on a device)."""
    row = await db.scalar(select(TrackRow).where(TrackRow.navidrome_id == track_id))
    if row is not None:
        cache = _cache(request)
        for conversion in (await db.execute(select(Conversion).where(Conversion.track_id == row.id, Conversion.profile == profile))).scalars():
            if conversion.file_name:
                (cache.files / conversion.file_name).unlink(missing_ok=True)
            await db.delete(conversion)
        await db.commit()
    return Response(status_code=204)


@router.get("/downloads/cache")
async def cache_stats(request: Request) -> dict:
    return await _cache(request).stats()
