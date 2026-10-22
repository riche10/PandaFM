"""Safe file and folder names for downloaded music.

Names come from tags (titles can contain anything), so every component is
cleaned for Android, FAT/exFAT SD cards and Windows alike, and can never
climb out of its folder.
"""

import hashlib
import re
import unicodedata

MAX_COMPONENT = 100
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def safe_component(name: str | None, fallback: str = "Unknown") -> str:
    text = unicodedata.normalize("NFC", name or "")
    text = _UNSAFE.sub("_", text)
    text = re.sub(r"\s+", " ", text).strip().strip(".").strip()
    if not text or set(text) <= {"_", "."}:
        text = fallback
    if text.lower().split(".")[0] in _RESERVED:
        text = f"_{text}"
    if len(text) > MAX_COMPONENT:
        text = text[:MAX_COMPONENT].rstrip(" .")
    return text


def short_hash(value: str, length: int = 6) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:length]


def relative_path(*, artist: str | None, album: str | None, title: str | None, track_number: int | None,
                  disc_number: int | None, extension: str, track_id: str, disambiguate: bool = False) -> str:
    """Music/<Artist>/<Album>/<NN - Title>.<ext>, always relative, always clean."""
    number = ""
    if track_number:
        number = f"{disc_number}-{track_number:02d} - " if disc_number and disc_number > 1 else f"{track_number:02d} - "
    stem = safe_component(f"{number}{title or 'Untitled'}", "Untitled")
    if disambiguate:
        stem = f"{stem[:MAX_COMPONENT - 9]} [{short_hash(track_id)}]"
    ext = re.sub(r"[^a-z0-9]", "", extension.lower())[:5] or "bin"
    return "/".join(["Music", safe_component(artist, "Unknown Artist"), safe_component(album, "Unknown Album"), f"{stem}.{ext}"])
