"""Audio and artwork, proxied from Navidrome.

The browser only ever sees /api/... URLs. Navidrome's salted-token
credentials are added by NavidromeClient on the server side and never
appear in anything returned from here.

Audio is streamed chunk by chunk, never buffered whole. The browser's
Range / If-Range headers are forwarded, and Navidrome's 200/206/416
answers come back with their Content-Range, Content-Length and
Accept-Ranges intact, which is what makes seeking work. Keeping audio
same-origin also matters later: Web Audio (Panda DJ) can analyse and
crossfade same-origin media without any CORS setup.
"""

from typing import Annotated

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Header, Query, Request, Response
from fastapi.responses import FileResponse
from starlette.responses import StreamingResponse

from app.audio.live import live_aac
from app.audio.profiles import plan
from app.audio.quality import revision
from app.errors import error_response
from app.navidrome.parse import facts_of
from app.services.conversions import ConversionError
from starlette.types import Receive, Scope, Send

from app.deps import SessionDep, UserId, ItemId, NavidromeDep
from app.navidrome.client import AudioStream

router = APIRouter(tags=["media"])
log = logging.getLogger(__name__)
QUALITY_PROFILES = {"high": "high_quality", "low": "space_saver"}  # the download profiles, reused
STREAM_WAIT_S = 4.0  # first play: how long to wait for the cached copy before going live
SEEK_WAIT_S = 20.0  # a seek needs the cached (seekable) copy

# Navidrome artwork ids carry a content hash (al-<id>_<hash>), so a given
# URL rarely changes. A week of browser caching plus ETag revalidation.
COVER_CACHE_CONTROL = "private, max-age=604800"


class ProxiedAudioResponse(StreamingResponse):
    """A StreamingResponse that always closes the Navidrome connection.

    Browsers drop audio connections constantly: every seek, skip or long
    pause abandons one request and starts another. Starlette reports a
    disconnect by raising, which skips background tasks, so cleanup lives
    in a finally block around the whole response instead.
    """

    def __init__(self, stream: AudioStream) -> None:
        super().__init__(stream.iter_bytes(), status_code=stream.status_code, headers=stream.headers)
        self._upstream = stream

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self._upstream.aclose()


@router.get(
    "/tracks/{track_id}/stream",
    response_class=ProxiedAudioResponse,
    # Explicit, because FastAPI otherwise reads the default status from the
    # response class's __init__, which ProxiedAudioResponse doesn't take.
    status_code=200,
    responses={206: {"description": "Partial content (Range request)"}},
)
async def stream_track(
    track_id: ItemId,
    navidrome: NavidromeDep,
    request: Request,
    db: SessionDep,
    user_id: UserId,
    quality: Annotated[Literal["original", "high", "low"], Query(description="original, high (AAC ~256 kbps) or low (AAC ~128 kbps)")] = "original",
    range_header: Annotated[str | None, Header(alias="Range")] = None,
    if_range: Annotated[str | None, Header(alias="If-Range")] = None,
):
    """Stream a song: the original file, or (for remote listening) a smaller AAC copy.

    High/low reuse the download profiles and the conversion cache: a cached
    copy is served with Range (seekable); the first play of an uncached song
    starts at once as live AAC while the cached copy is made. Lossy sources
    already at or below the target play as they are; nothing becomes FLAC.
    """
    if quality == "original":
        return ProxiedAudioResponse(await navidrome.open_stream(track_id, range_header=range_header, if_range=if_range))
    from app.routers.downloads import _cache, _db_track_id  # runtime import: downloads imports this module

    track = await navidrome.get_track(track_id)
    facts = facts_of(track)
    chosen = plan(facts, QUALITY_PROFILES[quality])
    if chosen.action == "original":  # already small enough: no transcode
        response = ProxiedAudioResponse(await navidrome.open_stream(track_id, range_header=range_header, if_range=if_range))
        response.headers["X-PandaFM-Quality"] = "original"
        return response
    cache = _cache(request)
    rev = revision(facts)
    db_id = await _db_track_id(db, user_id, track)
    profile = QUALITY_PROFILES[quality]
    done = await cache.find(db, db_id, profile, rev)
    if done is None:
        job = cache.ensure(track, db_id, facts, chosen, rev)
        seeking = bool(range_header) and not range_header.replace(" ", "").startswith("bytes=0-")
        try:
            await asyncio.wait_for(asyncio.shield(job), SEEK_WAIT_S if seeking else STREAM_WAIT_S)
        except TimeoutError:
            if seeking:
                return error_response(503, "preparing", "PandaFM is still preparing this song at this quality.", headers={"Retry-After": "3"})
            log.info("Live %s stream while the cached copy is made", quality)
            return StreamingResponse(live_aac(navidrome, track_id, chosen.bitrate_kbps or 256), media_type="audio/aac",
                                     headers={"Accept-Ranges": "none", "Cache-Control": "no-store", "X-PandaFM-Quality": quality, "X-PandaFM-Stream": "live"})
        except ConversionError:
            log.warning("Conversion failed; streaming the original instead")
            response = ProxiedAudioResponse(await navidrome.open_stream(track_id, range_header=range_header, if_range=if_range))
            response.headers["X-PandaFM-Quality"] = "original"
            return response
        done = await cache.find(db, db_id, profile, rev)
        if done is None:
            return error_response(503, "preparing", "PandaFM is still preparing this song at this quality.", headers={"Retry-After": "3"})
    await cache.touch(done.id)
    with cache.serving(done.file_name):
        return FileResponse(cache.path_of(done), media_type="audio/mp4", headers={"X-PandaFM-Quality": quality, "Cache-Control": "private, max-age=86400"})


@router.get(
    "/covers/{cover_art_id}",
    response_class=Response,
    responses={200: {"content": {"image/*": {}}}, 304: {"description": "Not modified"}},
)
async def cover_art(
    cover_art_id: ItemId,
    navidrome: NavidromeDep,
    size: Annotated[int | None, Query(ge=16, le=2000, description="Square size in pixels")] = None,
    if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
) -> Response:
    cover = await navidrome.get_cover_art(cover_art_id, size=size)
    headers = {"Cache-Control": COVER_CACHE_CONTROL}
    if cover.etag:
        headers["ETag"] = cover.etag
        if if_none_match == cover.etag:
            return Response(status_code=304, headers=headers)
    return Response(content=cover.content, media_type=cover.content_type, headers=headers)
