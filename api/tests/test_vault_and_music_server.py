"""5.3: the installation key, encrypted secrets, and testing a music server (no database needed)."""

import asyncio
import os
import stat

import pytest

from app.services.music_server import BadUrl, normalize_url
from app.services.music_server import test_connection as check_connection  # (not collected as a test)
from app.vault import Vault, VaultError, load_key
from tests import fake_music_server as fake


def test_secrets_are_authenticated_encryption_bound_to_their_purpose(tmp_path):
    vault = Vault(load_key(tmp_path))
    sealed = vault.encrypt("navi-pass 42", "music-server-password")
    assert "navi-pass" not in sealed and sealed.startswith("v1:" + vault.key_id)
    assert vault.decrypt(sealed, "music-server-password") == "navi-pass 42"
    assert vault.encrypt("navi-pass 42", "music-server-password") != sealed  # a fresh nonce every time
    with pytest.raises(VaultError):
        vault.decrypt(sealed, "something-else")  # can't be replayed into another field
    tampered = sealed[:-4] + ("AAAA" if not sealed.endswith("AAAA") else "BBBB")
    with pytest.raises(VaultError):
        vault.decrypt(tampered, "music-server-password")
    with pytest.raises(VaultError, match="installation key changed"):
        Vault(os.urandom(32)).decrypt(sealed, "music-server-password")


def test_the_installation_key_is_created_once_privately_or_supplied(tmp_path):
    key = load_key(tmp_path)
    path = tmp_path / "installation.key"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert load_key(tmp_path) == key  # reused, never regenerated
    import base64
    explicit = os.urandom(32)
    assert load_key(tmp_path / "unused", base64.b64encode(explicit).decode()) == explicit
    assert load_key(tmp_path / "unused", explicit.hex()) == explicit
    with pytest.raises(VaultError):
        load_key(tmp_path, "too-short")
    unwritable = tmp_path / "ro"
    unwritable.mkdir()
    unwritable.chmod(0o500)
    if os.geteuid() != 0:  # root ignores permissions
        with pytest.raises(VaultError, match="writable config volume"):
            load_key(unwritable)


@pytest.mark.parametrize("raw, expected", [
    ("music.example.com", "https://music.example.com"),
    ("https://music.example.com/", "https://music.example.com"),
    ("  http://192.168.1.20:4533// ", "http://192.168.1.20:4533"),
    ("https://example.com/navidrome/rest", "https://example.com/navidrome"),
])
def test_music_server_addresses_are_normalised(raw, expected):
    assert normalize_url(raw) == expected


@pytest.mark.parametrize("raw", ["", "ftp://music.example.com", "https://user:pw@music.example.com", "https://"])
def test_bad_addresses_are_refused(raw):
    with pytest.raises(BadUrl):
        normalize_url(raw)


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_a_working_navidrome_is_recognised():
    r = run(check_connection("music.example.com", fake.USER, fake.PASSWORD, fake.transport("ok")))
    assert (r.ok, r.kind, r.url, r.server_type, r.server_version, r.open_subsonic) == (True, "ok", "https://music.example.com", "navidrome", "0.58.0", True)
    assert "Navidrome 0.58.0" in r.message


@pytest.mark.parametrize("mode, user, password, kind, words", [
    ("ok", fake.USER, "wrong", "bad_credentials", "rejected that username or password"),
    ("unreachable", fake.USER, fake.PASSWORD, "unreachable", "couldn’t reach that server"),
    ("html", fake.USER, fake.PASSWORD, "not_subsonic", "doesn’t appear to provide"),
    ("404", fake.USER, fake.PASSWORD, "not_subsonic", "doesn’t appear to provide"),
])
def test_failures_are_explained_without_the_password(mode, user, password, kind, words):
    r = run(check_connection("https://music.example.com", user, password, fake.transport(mode)))
    assert (r.ok, r.kind) == (False, kind) and words in r.message
    assert password not in r.message and "navi-pass" not in repr(r)


def test_a_bad_address_is_reported_before_connecting():
    r = run(check_connection("ftp://nope", fake.USER, fake.PASSWORD, fake.transport("ok")))
    assert (r.ok, r.kind) == (False, "bad_url")


def test_only_home_lan_and_vpn_addresses_count_as_private():
    from app.auth.limits import private_address
    for ip in ("192.168.1.20", "10.1.2.3", "172.20.0.5", "127.0.0.1", "100.101.102.103", "::1", "fd12::1", "::ffff:192.168.1.5"):
        assert private_address(ip), ip
    for ip in ("203.0.113.9", "198.51.100.7", "8.8.8.8", "2001:db8::1", "testclient", "", None):
        assert not private_address(ip), ip
