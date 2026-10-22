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

from fastapi import APIRouter, Header, Query, Response
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from app.deps import ItemId, NavidromeDep
from app.navidrome.client import AudioStream

router = APIRouter(tags=["media"])

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
    range_header: Annotated[str | None, Header(alias="Range")] = None,
    if_range: Annotated[str | None, Header(alias="If-Range")] = None,
) -> ProxiedAudioResponse:
    stream = await navidrome.open_stream(track_id, range_header=range_header, if_range=if_range)
    return ProxiedAudioResponse(stream)


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
