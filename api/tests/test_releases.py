"""5.4.1 self-hosted Android releases: the manifest endpoint and the Nginx download location."""

import hashlib
import json
import re
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import releases

ROOT = Path(__file__).resolve().parents[2]


def client(tmp_path: Path) -> TestClient:
    app = FastAPI()
    app.state.settings = SimpleNamespace(releases_dir=str(tmp_path))
    app.include_router(releases.router, prefix="/api")
    return TestClient(app)


def publish(tmp_path: Path, **override) -> dict:
    folder = tmp_path / "android"
    folder.mkdir(parents=True, exist_ok=True)
    apk = b"PK\x03\x04 pretend apk " * 100
    (folder / "PandaFM-5.4.1.apk").write_bytes(apk)
    manifest = {"platform": "android", "versionName": "5.4.1", "versionCode": 50401, "filename": "PandaFM-5.4.1.apk",
                "downloadUrl": "/downloads/android/PandaFM-5.4.1.apk", "sha256": hashlib.sha256(apk).hexdigest(), "size": len(apk),
                "releasedAt": "2026-10-29T12:00:00Z", "notes": "Playback reliability and self-hosted updates", **override}
    (folder / "latest.json").write_text(json.dumps(manifest))
    return manifest


def test_the_published_release_is_served_with_a_relative_url_and_no_cache(tmp_path):
    m = publish(tmp_path)
    r = client(tmp_path).get("/api/releases/android/latest")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
    body = r.json()
    assert body["versionCode"] == 50401 and body["versionName"] == "5.4.1" and body["sha256"] == m["sha256"] and body["size"] == m["size"]
    assert body["downloadUrl"] == "/downloads/android/PandaFM-5.4.1.apk"  # relative: same origin, no hostname
    assert str(tmp_path) not in r.text  # no server paths


def test_nothing_published_is_a_quiet_404(tmp_path):
    r = client(tmp_path).get("/api/releases/android/latest")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_release" and r.headers["cache-control"] == "no-cache"


def test_malformed_or_incomplete_manifests_are_never_advertised(tmp_path):
    c = client(tmp_path)
    bad = [
        {"versionCode": "50401"}, {"versionCode": 0}, {"versionCode": True}, {"sha256": "abc"}, {"sha256": "G" * 64},
        {"size": -1}, {"size": 1}, {"platform": "ios"}, {"versionName": "5.4.1; rm -rf /"},
        {"filename": "../../etc/passwd"}, {"filename": "PandaFM-5.4.1.apk/../../x.apk"}, {"filename": "evil.apk"}, {"filename": "PandaFM-5.4.1.exe"},
    ]
    for override in bad:
        publish(tmp_path, **override)
        assert c.get("/api/releases/android/latest").status_code == 404, override
    publish(tmp_path)
    (tmp_path / "android" / "latest.json").write_text("{not json")
    assert c.get("/api/releases/android/latest").status_code == 404
    publish(tmp_path)
    (tmp_path / "android" / "PandaFM-5.4.1.apk").unlink()  # the manifest points at a file that isn't there
    assert c.get("/api/releases/android/latest").status_code == 404


def test_nginx_serves_only_versioned_apks_read_only_and_immutable():
    conf = (ROOT / "web" / "nginx.conf").read_text()
    m = re.search(r'location ~ "\^/downloads/android/\((.+?)\)\$" \{(.*?)\n    \}', conf, re.S)
    assert m, "the APK location"
    name, block = re.compile("^" + m.group(1) + "$"), m.group(2)
    for ok in ("PandaFM-5.4.1.apk", "PandaFM-5.4.2-rc1.apk"):
        assert name.match(ok), ok
    for evil in ("../latest.json", "PandaFM-../../x.apk", "latest.json", "PandaFM-5.4.1.apk/x", "x.apk", "PandaFM-.apk"):
        assert not name.match(evil), evil
    assert "alias /releases/android/$1;" in block and "autoindex off;" in block
    assert "default_type application/vnd.android.package-archive;" in block and "types { }" in block
    assert "immutable" in block and "nosniff" in block
    assert re.search(r"location /downloads/ \{\s*return 404;", conf)  # everything else under /downloads/


def test_compose_mounts_releases_read_only_into_both_containers():
    compose = (ROOT / "docker-compose.yml").read_text()
    assert compose.count("${PANDAFM_RELEASES_DIR:-/srv/pandafm/releases}:/releases:ro") == 2


import shutil  # noqa: E402
import socket  # noqa: E402
import subprocess  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402

import pytest  # noqa: E402


@pytest.mark.skipif(shutil.which("nginx") is None, reason="needs nginx")
def test_a_real_nginx_serves_apks_and_nothing_else(tmp_path):
    """The /downloads locations exactly as in web/nginx.conf, served by a real nginx."""
    conf = (ROOT / "web" / "nginx.conf").read_text()
    start = conf.index('    location ~ "^/downloads/android/')
    end = conf.index("    location /downloads/ {")
    end = conf.index("}", end) + 1
    blocks = conf[start:end].replace("alias /releases/android/$1;", f"alias {tmp_path}/android/$1;")
    (tmp_path / "android").mkdir()
    (tmp_path / "android" / "PandaFM-5.4.1.apk").write_bytes(b"PK\x03\x04apk")
    (tmp_path / "android" / "latest.json").write_text("{}")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    import os
    import pwd

    user = f"user {pwd.getpwuid(os.geteuid()).pw_name};" if os.geteuid() == 0 else ""  # workers must read this private temp folder
    (tmp_path / "nginx.conf").write_text(f"""{user} daemon off; pid {tmp_path}/nginx.pid; error_log {tmp_path}/error.log;
events {{}}
http {{ access_log off; include /etc/nginx/mime.types;
  client_body_temp_path {tmp_path}; proxy_temp_path {tmp_path}; fastcgi_temp_path {tmp_path}; uwsgi_temp_path {tmp_path}; scgi_temp_path {tmp_path};
  server {{ listen 127.0.0.1:{port}; root {tmp_path}/www;
{blocks}
  }}
}}""")
    proc = subprocess.Popen(["nginx", "-c", str(tmp_path / "nginx.conf")], stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)

        def get(path):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}") as r:
                    return r.status, dict(r.headers), r.read()
            except urllib.error.HTTPError as e:
                return e.code, dict(e.headers), b""

        status, headers, body = get("/downloads/android/PandaFM-5.4.1.apk")
        assert status == 200 and body == b"PK\x03\x04apk"
        assert headers["Content-Type"] == "application/vnd.android.package-archive"
        assert "immutable" in headers["Cache-Control"] and headers["X-Content-Type-Options"] == "nosniff"
        for path in ("/downloads/android/latest.json", "/downloads/android/", "/downloads/", "/downloads/android/../android/latest.json",
                     "/downloads/android/%2e%2e/android/latest.json", "/downloads/android/x.apk", "/downloads/android/PandaFM-5.4.1.apk.bak"):
            assert get(path)[0] == 404, path
    finally:
        proc.terminate()
        proc.wait(timeout=5)


SCRIPT = ROOT / "scripts" / "build-and-publish-android.sh"


def _run_publish(tmp_path, version_name, version_code, apk_bytes=b"PK\x03\x04 a signed apk", **env):
    import os
    props = tmp_path / f"version-{version_code}.properties"
    props.write_text(f"versionName={version_name}\nversionCode={version_code}\n")
    apk = tmp_path / f"build-{version_code}.apk"
    apk.write_bytes(apk_bytes)
    return subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True,
                          env={**os.environ, "PANDAFM_RELEASES_DIR": str(tmp_path / "releases"), "PANDAFM_PUBLISH_APK": str(apk),
                               "PANDAFM_VERSION_PROPERTIES": str(props), "TMPDIR": str(tmp_path), **env})


@pytest.mark.skipif(shutil.which("bash") is None or shutil.which("flock") is None, reason="needs bash and flock")
def test_the_publish_script_publishes_atomically_and_refuses_downgrades(tmp_path):
    import os
    import stat
    r = _run_publish(tmp_path, "5.4.1", 50401, PANDAFM_RELEASE_NOTES="Playback reliability")
    assert r.returncode == 0, r.stderr
    android = tmp_path / "releases" / "android"
    release = releases.android_release(tmp_path / "releases")  # exactly what the API will serve
    assert release and release["versionCode"] == 50401 and release["notes"] == "Playback reliability"
    assert release["sha256"] == hashlib.sha256(b"PK\x03\x04 a signed apk").hexdigest()
    for f in ("PandaFM-5.4.1.apk", "latest.json"):
        assert stat.S_IMODE(os.stat(android / f).st_mode) == 0o644  # readable by the web container's nginx
    assert not [p for p in android.iterdir() if ".tmp." in p.name]  # no partial files left behind
    assert "SHA-256" in r.stdout and release["sha256"] in r.stdout
    same = _run_publish(tmp_path, "5.4.1", 50401)
    assert same.returncode != 0 and "already published" in same.stderr
    assert _run_publish(tmp_path, "5.4.1", 50401, PANDAFM_ALLOW_REPUBLISH="1").returncode == 0
    older = _run_publish(tmp_path, "5.4.0", 50400)
    assert older.returncode != 0 and "downgrade" in older.stderr
    assert releases.android_release(tmp_path / "releases")["versionCode"] == 50401  # untouched


@pytest.mark.skipif(shutil.which("bash") is None or shutil.which("flock") is None, reason="needs bash and flock")
def test_a_broken_build_never_reaches_clients_and_old_releases_are_pruned(tmp_path):
    assert _run_publish(tmp_path, "5.4.1", 50401).returncode == 0
    bad = _run_publish(tmp_path, "5.4.2", 50402, apk_bytes=b"<html>error page</html>")
    assert bad.returncode != 0 and "isn't an APK" in bad.stderr
    assert releases.android_release(tmp_path / "releases")["versionCode"] == 50401  # clients still see the good one
    for k, code in enumerate(range(50402, 50407)):
        assert _run_publish(tmp_path, f"5.4.{2 + k}", code).returncode == 0
        time.sleep(0.01)
    apks = sorted(p.name for p in (tmp_path / "releases" / "android").glob("PandaFM-*.apk"))
    assert len(apks) == 4 and "PandaFM-5.4.6.apk" in apks  # the published one plus 3 older
