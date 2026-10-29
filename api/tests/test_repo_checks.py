"""5.4 regressions in the repository itself: the API image's writable folders, and launcher-icon checks."""

import os
import re
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
icons = __import__("check-android-icons".replace("-", "_")) if False else None


def _load_icons_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("check_android_icons", ROOT / "scripts" / "check-android-icons.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_api_image_prepares_both_writable_folders_for_its_user():
    """5.3 bug: /config wasn't prepared, so a fresh named volume couldn't hold installation.key."""
    text = (ROOT / "api" / "Dockerfile").read_text()
    user_at = text.index("USER pandafm")
    setup = text[:user_at]
    assert re.search(r"useradd [^\n]*--uid 10001", setup)
    assert re.search(r"mkdir -p [^\n]*/cache[^\n]*/config|mkdir -p [^\n]*/config[^\n]*/cache", setup)
    assert re.search(r"chown pandafm(:pandafm)? [^\n]*/cache[^\n]*/config|chown pandafm(:pandafm)? [^\n]*/config[^\n]*/cache", setup)
    assert "/config" in text[text.index("VOLUME"):user_at]


def _png(path: Path, truncate: bool = False) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x80" * 4 for _ in range(4))
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    path.write_bytes(data[: len(data) // 2] if truncate else data)


def test_icon_sources_are_validated(tmp_path):
    mod = _load_icons_module()
    _png(tmp_path / "app-icon-foreground.png")
    assert mod.problems(tmp_path) == []
    _png(tmp_path / "app-icon.png", truncate=True)
    bad = mod.problems(tmp_path)
    assert len(bad) == 1 and bad[0].startswith("app-icon.png:")
    damaged = bytearray((tmp_path / "app-icon-foreground.png").read_bytes())
    damaged[40] ^= 0xFF  # flip a byte inside a chunk
    (tmp_path / "app-icon-monochrome.png").write_bytes(bytes(damaged))
    assert any("checksum" in p or "truncated" in p for p in mod.problems(tmp_path))


def test_a_new_icon_source_makes_the_launcher_icons_stale(tmp_path):
    mod = _load_icons_module()
    _png(tmp_path / "app-icon-foreground.png")
    before = mod.digest(tmp_path)
    _png(tmp_path / "app-icon.png")
    assert mod.digest(tmp_path) != before  # the stamp no longer matches: --stale fails until icons are regenerated


@pytest.mark.skipif(shutil.which("sh") is None, reason="needs a POSIX shell")
@pytest.mark.parametrize("files, mode, expected", [
    (["app-icon-foreground.png"], "auto", "1"),  # the 5.3 bug: PNG alone was skipped
    (["app-icon-foreground.svg"], "auto", "1"),
    ([], "auto", "0"),
    (["app-icon-foreground.png"], "0", "0"),
])
def test_icon_regeneration_needs_either_source(tmp_path, files, mode, expected):
    (tmp_path / "web" / "assets").mkdir(parents=True)
    (tmp_path / "scripts").mkdir()
    shutil.copy(ROOT / "scripts" / "check-android-icons.py", tmp_path / "scripts")
    for f in files:
        target = tmp_path / "web" / "assets" / f
        _png(target) if f.endswith(".png") else target.write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    out = subprocess.run(["sh", str(ROOT / "scripts" / "android-icons-mode.sh"), str(tmp_path)], capture_output=True, text=True,
                         env={**os.environ, "PANDAFM_ANDROID_ICONS": mode})
    assert out.stdout.strip() == expected, out.stderr


def test_damaged_icon_artwork_keeps_the_current_icons_with_a_warning(tmp_path):
    (tmp_path / "web" / "assets").mkdir(parents=True)
    (tmp_path / "scripts").mkdir()
    shutil.copy(ROOT / "scripts" / "check-android-icons.py", tmp_path / "scripts")
    _png(tmp_path / "web" / "assets" / "app-icon-foreground.png", truncate=True)
    out = subprocess.run(["sh", str(ROOT / "scripts" / "android-icons-mode.sh"), str(tmp_path)], capture_output=True, text=True,
                         env={**os.environ, "PANDAFM_ANDROID_ICONS": "auto"})
    assert out.stdout.strip() == "0" and "damaged" in out.stderr
    forced = subprocess.run(["sh", str(ROOT / "scripts" / "android-icons-mode.sh"), str(tmp_path)], capture_output=True, text=True,
                            env={**os.environ, "PANDAFM_ANDROID_ICONS": "1"})
    assert forced.returncode == 1
