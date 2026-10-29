# Self-hosted Android updates (5.4.1)

Your PandaFM server can publish the Android app, and installed PandaFM apps can
update themselves from it, with no USB cable, ADB or copying APKs around. It is
entirely self-hosted: no app store, no Google Play Services.

PandaFM never installs anything silently. It downloads and checks the update,
then opens Android's own installer, where **you** tap *Update*.

## How a phone updates

**Settings › App** shows the installed version (for example *PandaFM 5.4.1 ·
Android build 50401*) and whether the server offers something newer.

1. **Check for updates** (PandaFM also checks quietly a few seconds after it
   starts, at most every 12 hours; a failed automatic check is never shown).
2. **Download update**: into PandaFM's private cache, with progress and
   Cancel; a partial download is deleted.
3. PandaFM verifies the download before it will install it:
   - its **SHA-256** matches the release manifest;
   - it is **`app.pandafm.client`** with exactly the announced **version code**;
   - it is **signed with the same certificate** as the PandaFM already
     installed. An APK signed with any other key is rejected and deleted (a
     compromised or mis-built server artifact can't replace PandaFM).
4. **Install update** opens Android's installer. The first time, Android may
   ask you to allow *Install unknown apps* for PandaFM; PandaFM opens that
   page and carries on when you come back.

Only a higher **version code** counts as an update; PandaFM never offers a
downgrade. Updating keeps everything: the server address, your sign-in, the
downloads and their storage permission, the queue and every setting.

## The server side

Published releases live in one host directory, mounted **read-only** into
PandaFM's containers; the build host's publish script is the only writer.

| Setting | Default | |
|---|---|---|
| `PANDAFM_RELEASES_DIR` | `/srv/pandafm/releases` | host directory with `android/latest.json` and `android/PandaFM-<version>.apk` |

`docker-compose.yml` mounts it as `/releases:ro` into `pandafm-api` (which
serves the manifest) and `pandafm-web` (which serves the APK files). With
Portainer, set `PANDAFM_RELEASES_DIR` in the stack's environment and create the
directory on the host (`sudo mkdir -p /srv/pandafm/releases/android`, owned by
the user who runs the publish script). Publishing a release only writes files:
**no image rebuild and no stack redeploy**.

| URL | What | Caching |
|---|---|---|
| `/api/releases/android/latest` | the release manifest (JSON, nothing private) | `no-cache` |
| `/downloads/android/PandaFM-<version>.apk` | the APK (public on purpose, so a new device can install it) | immutable |
| `/download/android/` | a page with the download button and the SHA-256 | normal |

Only versioned `PandaFM-<version>.apk` names are served from `/downloads/`;
there is no directory listing, and other names or paths are a 404.

The manifest looks like:

```json
{
  "platform": "android",
  "versionName": "5.4.1",
  "versionCode": 50401,
  "filename": "PandaFM-5.4.1.apk",
  "downloadUrl": "/downloads/android/PandaFM-5.4.1.apk",
  "sha256": "…",
  "size": 12345678,
  "releasedAt": "2026-10-29T12:00:00Z",
  "notes": "Playback reliability and self-hosted updates"
}
```

## Publishing a release (on the build host)

```sh
cd ~/PandaFM-build
PANDAFM_RELEASES_DIR=/srv/pandafm/releases ./scripts/build-and-publish-android.sh   # optional: a branch name (default main)
```

The script builds with `scripts/build-android-apk.sh` (its build lock, a fresh
`origin/<branch>` checkout, and the **existing persistent signing key**, which
never enters a PandaFM container or the repository), reads the version, checks
the APK, refuses to publish a version code lower than the current release, then
publishes atomically: the APK under a temporary name, verified, renamed; the
manifest last, so clients never see a release whose APK isn't there yet. It
keeps the three previous APKs (`PANDAFM_KEEP_RELEASES`) and prints the
version, path and SHA-256. The production containers never build Android, hold
the signing key or need the Docker socket.

## A new phone or Walkman

Open `https://<your PandaFM>/download/android/` in its browser, tap **Download
Android APK**, allow your browser to install apps if Android asks, and install.
Compare the SHA-256 shown on the page if you like. From then on, updates come
through Settings › App.
