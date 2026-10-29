#!/usr/bin/env python3
"""Launcher-icon sources for the Android app (5.4): are they usable, and are the icons current?

  scripts/check-android-icons.py --sources   exit 1 if a web/assets/app-icon*.png isn't a valid PNG
  scripts/check-android-icons.py --stale     exit 1 if the launcher icons weren't generated from today's sources
  scripts/check-android-icons.py --stamp     record today's sources as the ones the icons came from

Standard library only (it runs on the build host before Docker).
"""

import hashlib
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "web" / "assets"
STAMP = ROOT / "web" / "android" / "icon-sources.sha256"
NAMES = ("app-icon", "app-icon-foreground", "app-icon-background", "app-icon-monochrome")


def png_problem(path: Path) -> str | None:
    """None for a structurally sound PNG, else what's wrong (a damaged upload, a truncated file...)."""
    b = path.read_bytes()
    if b[:8] != b"\x89PNG\r\n\x1a\n":
        return "not a PNG (bad signature)"
    i, seen = 8, []
    while i + 12 <= len(b):
        length, kind = struct.unpack(">I4s", b[i:i + 8])
        data, crc = b[i + 8:i + 8 + length], b[i + 8 + length:i + 12 + length]
        if len(crc) < 4:
            return f"truncated inside the {kind!r} chunk"
        if struct.unpack(">I", crc)[0] != zlib.crc32(kind + data) & 0xFFFFFFFF:
            return f"damaged {kind.decode('latin-1')} chunk (checksum mismatch)"
        seen.append(kind)
        i += 12 + length
        if kind == b"IEND":
            break
    if b"IEND" not in seen:
        return "truncated (no IEND chunk)"
    if b"IDAT" not in seen:
        return "no image data"
    return None


def sources(assets: Path = ASSETS) -> list[Path]:
    return sorted(p for n in NAMES for p in (assets / f"{n}.png", assets / f"{n}.svg") if p.exists())


def problems(assets: Path = ASSETS) -> list[str]:
    return [f"{p.name}: {why}" for p in sources(assets) if p.suffix == ".png" and (why := png_problem(p))]


def digest(assets: Path = ASSETS) -> str:
    h = hashlib.sha256()
    for p in sources(assets):
        h.update(p.name.encode() + b"\0" + p.read_bytes())
    return h.hexdigest()


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "--sources"
    if mode == "--sources":
        bad = problems()
        for line in bad:
            print(f"icon source unusable: {line}", file=sys.stderr)
        return 1 if bad else 0
    if mode == "--stale":
        if not STAMP.exists() or STAMP.read_text().strip() != digest():
            print("The Android launcher icons were not generated from the current web/assets artwork. "
                  "Rebuild with PANDAFM_ANDROID_ICONS=1 (after fixing any damaged source).", file=sys.stderr)
            return 1
        return 0
    if mode == "--stamp":
        STAMP.write_text(digest() + "\n")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
