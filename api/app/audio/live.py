"""Live AAC for the first play of a song whose cached copy at that quality isn't ready yet.

The cached conversion (seekable, Range-capable) keeps being made in the
background; this only bridges the first seconds so playback starts at once.
A live stream can't seek: a seek waits for the cached file instead.
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator

log = logging.getLogger(__name__)
CHUNK = 64 * 1024


async def live_aac(navidrome, track_id: str, bitrate_kbps: int) -> AsyncIterator[bytes]:
    upstream = await navidrome.open_stream(track_id)
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-map", "0:a:0",
        "-c:a", "aac", "-b:a", f"{bitrate_kbps}k", "-f", "adts", "pipe:1",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )

    async def feed() -> None:
        try:
            async for chunk in upstream.iter_bytes():
                proc.stdin.write(chunk)
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with contextlib.suppress(Exception):
                proc.stdin.close()

    feeder = asyncio.create_task(feed())
    try:
        while chunk := await proc.stdout.read(CHUNK):
            yield chunk
    finally:  # the listener skipped or closed the app: stop everything
        feeder.cancel()
        with contextlib.suppress(Exception):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        with contextlib.suppress(Exception):
            await upstream.aclose()
