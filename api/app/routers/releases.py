"""Self-hosted Android releases (5.4.1).

The build host publishes signed APKs and a latest.json into a directory that is
mounted read-only into the PandaFM containers. This endpoint only reads and
validates the manifest; the APK itself is served by the web container's Nginx
at /downloads/android/<file>. Public on purpose: a new phone can install
PandaFM from its own server, and nothing here is private.
"""

import json
import re
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from app.config import get_settings

router = APIRouter(prefix="/releases", tags=["releases"])

SAFE_FILENAME = re.compile(r"^PandaFM-[0-9A-Za-z][0-9A-Za-z.+-]{0,39}\.apk$")
VERSION_NAME = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_APK_BYTES = 512 * 1024 * 1024
NO_CACHE = {"Cache-Control": "no-cache"}  # clients must see a new release as soon as it's published


def android_release(releases_dir: str | Path) -> dict | None:
    """The published Android release, or None if there isn't a complete, valid one."""
    folder = Path(releases_dir) / "android"
    try:
        raw = (folder / "latest.json").read_bytes()
        if len(raw) > 65536:
            return None
        m = json.loads(raw)
    except (OSError, ValueError):
        return None
    if not isinstance(m, dict) or m.get("platform") != "android":
        return None
    name, code, filename, sha, size = m.get("versionName"), m.get("versionCode"), m.get("filename"), m.get("sha256"), m.get("size")
    if not (isinstance(name, str) and VERSION_NAME.match(name)):
        return None
    if not (isinstance(code, int) and not isinstance(code, bool) and 0 < code <= 2_100_000_000):
        return None
    if not (isinstance(filename, str) and SAFE_FILENAME.match(filename)):
        return None  # never a path, never traversal
    if not (isinstance(sha, str) and SHA256.match(sha)):
        return None
    if not (isinstance(size, int) and not isinstance(size, bool) and 0 < size <= MAX_APK_BYTES):
        return None
    apk = folder / filename
    try:
        if not apk.is_file() or apk.is_symlink() or apk.stat().st_size != size:
            return None  # not (fully) published: never advertise a broken release
    except OSError:
        return None
    notes, released = m.get("notes"), m.get("releasedAt")
    return {
        "platform": "android",
        "versionName": name,
        "versionCode": code,
        "filename": filename,
        "downloadUrl": f"/downloads/android/{filename}",  # relative: same origin as this server
        "sha256": sha,
        "size": size,
        "releasedAt": released if isinstance(released, str) and len(released) <= 40 else None,
        "notes": notes[:2000] if isinstance(notes, str) else None,
    }


@router.get("/android/latest")
async def latest_android(request: Request):
    cfg = getattr(request.app.state, "settings", None) or get_settings()
    release = await run_in_threadpool(android_release, cfg.releases_dir)
    if release is None:
        return JSONResponse({"error": {"code": "no_release", "message": "No Android release has been published on this server."}},
                            status_code=404, headers=NO_CACHE)
    return JSONResponse(release, headers=NO_CACHE)
