# PandaFM for Android (and Sony Walkman)

The Android app is the same React app as the web version, wrapped with
Capacitor 8. It streams from your PandaFM server and can keep music on the
device, as ordinary audio files in a folder you choose (internal storage or
an SD card).

## Build the APK

You only need Docker (for example on the PandaFM server):

```bash
git clone https://github.com/riche10/PandaFM.git && cd PandaFM
./web/android/build-apk.sh                              # HTTPS servers (default)
PANDAFM_ANDROID_ALLOW_HTTP=1 ./web/android/build-apk.sh # also plain-http LAN servers
# → web/android/app/build/outputs/apk/debug/app-debug.apk
```

The first build downloads the Android SDK (a few minutes); it is kept in the
`pandafm-android-sdk` and `pandafm-gradle` Docker volumes. The script also
runs the native unit tests. With Android Studio instead: `cd web && npm
install && npm run android:sync`, then open `web/android`.

### Signing: install updates over the previous APK

Android only installs an update over an app signed by the same key. Every
build is signed with PandaFM's development key, created on the first build in
the Docker volume `pandafm-android-signing` (`PANDAFM_SIGNING_DIR=/some/folder`
uses a host folder instead). It holds `pandafm-dev.p12`, a random password in
`.password` and `signing.properties`; nothing of it is in Git, and the
password is never printed. Each build prints the key's SHA-256 fingerprint:
it should stay the same.

Back it up (losing it means uninstalling the app to update it):

```bash
docker run --rm -v pandafm-android-signing:/signing -v "$PWD":/backup alpine \
  tar czf /backup/pandafm-android-signing.tgz -C /signing .
# restore on another machine:
docker run --rm -v pandafm-android-signing:/signing -v "$PWD":/backup alpine \
  tar xzf /backup/pandafm-android-signing.tgz -C /signing
```

**One-time step:** APKs built before Stage 4.2 were signed with a throwaway
key that no longer exists, so the first Stage 4.2 APK cannot update them.
Uninstall the old PandaFM once (this clears its saved server address and its
list of downloads; music files already on the SD card stay, download them
again to relink them), then install. From then on, new builds update in place
and keep everything.

### Versions

`web/android/app/version.properties` holds `versionName` and `versionCode`.
Bump both for every APK you install over an older one; `versionCode` must only
grow (`major*10000 + minor*100 + patch`, so 0.4.2 is 402).

### HTTPS, and plain-http LAN servers

Default builds talk to **https://** servers only. `PANDAFM_ANDROID_ALLOW_HTTP=1`
builds also allow plain `http://192.168.x.x:PORT` and user-installed
certificate authorities. Don't distribute those; prefer HTTPS through your
external Nginx.

## How it works

- **Server:** the first screen asks for your PandaFM address, checks
  `/api/health` (PandaFM, database, Navidrome) and remembers it. Change it
  in Settings. The app never sees Navidrome credentials.
- **Storage:** Settings › Offline storage › Choose folder opens Android's
  folder picker. Create or pick a `PandaFM` folder (on the SD card for a
  Walkman). PandaFM keeps access to that one folder across restarts and asks
  for no other storage permission.
- **Files:** `PandaFM/Music/<Artist>/<Album>/<NN - Title>.<ext>`, plus
  `PandaFM/.pandafm/artwork/`. Nothing is encrypted; other players can use
  the files. Songs are identified by their PandaFM/Navidrome id in the app's
  manifest, not by file name.
- **Downloads** run in a background service (notification: "PandaFM
  downloads"). Each file is written as `<name>.part`, resumed after a dropped
  connection, checked (size, SHA-256 for converted files) and only then
  renamed. Wi-Fi only (default) waits for Wi-Fi; "Any network" uses mobile data.
- **One copy per song.** A song in two downloaded playlists is stored once;
  removing one playlist keeps it. Downloading a song again at a different
  quality keeps the existing copy (remove it first to change quality).
- **Keep downloaded** collections follow server changes: new songs are
  fetched, removed songs are deleted unless another download needs them, and
  a changed library file is re-downloaded (the old copy keeps playing until
  the new one is verified). Sync runs at app start, when Wi-Fi returns, and
  from Downloaded › Sync now.
- **Playback** uses the downloaded file when there is one, otherwise streams;
  offline and not downloaded shows a clear message. Listening offline is
  buffered and sent to PandaFM when the server is reachable again (same event
  ids, so nothing is counted twice). Panda Radio needs the server; its picks
  play from downloaded files when they exist.

## Playback (Stage 4.2)

The app plays music natively with **AndroidX Media3 / ExoPlayer 1.11.1**, not
in the WebView. Browsers keep using `<audio>`; the choice is made once, at the
platform boundary (`web/src/player/engineSelect.ts`).

- **The shared queue stays in charge.** The web app's queue, Panda Radio and
  Autoplay decide every song. The native player (`PandaPlayerPlugin` →
  `PlaybackService`) plays one song at a time and reports what happens. Each
  load has a generation number, so late events from a previous song are
  ignored, and a song completes once however often Android reports it.
- **Background playback** lives in a Media3 `MediaSessionService`, not in the
  Activity: music continues with the screen locked or another app in front.
  The WebView's renderer is kept at important priority so the queue can move
  on to the next song in the background.
- **Media controls** (lock screen, notification, Bluetooth, headsets, Walkman
  buttons) use the one native MediaSession; the browser Media Session is not
  used in the app. Play, pause and seek act at once and are recorded like the
  app's own buttons; next and previous go to the shared queue. Audio focus and
  "headphones unplugged" use Media3's standard handling.
- **Sources:** streams are the normal `…/api/tracks/{id}/stream` URLs (PandaFM
  stays the proxy, with Range requests for seeking). Downloads are played
  straight from their `content://` URI in your PandaFM folder, with no copies.
- **Formats:** FLAC, MP3, AAC/M4A, Ogg Vorbis, Opus and WAV through Android's
  decoders. Nothing is transcoded for playback. FLAC needs Android 8.1 or newer
  (every current phone and Walkman).
- **Artwork:** remote covers are fetched through the PandaFM API and shown as
  in-app images (see below); downloaded artwork is used offline; the lock
  screen loads its artwork natively (the saved copy, else the server's cover).

### Why artwork and FLAC failed before

The app's page runs at `https://localhost`. On a plain-http LAN server
(`http://192.168.10.65:8086`), Chromium (and so the WebView) treats images
and audio from that address as mixed content that it cannot upgrade to HTTPS
(the host is an IP address) and blocks them. The "allow mixed content" switch
only covers fetch()/XHR, which is why song data loaded while covers and
streams did not. A blocked stream surfaces as `MEDIA_ERR_SRC_NOT_SUPPORTED`,
which PandaFM showed as "This browser can't play this file's format"; the FLAC
itself was never the problem. Native playback sidesteps the WebView, and
covers now load through fetch().

### Diagnostics

Settings › Diagnostics shows the platform, the playback engine, whether the
current song comes from the server or a download, the source type and codec.
With a debug APK, `chrome://inspect` on a computer (phone connected by USB)
shows the WebView's console. Native logs: `adb logcat -s PandaFM.Player`
(never URLs or credentials).

### Limitations

- If Android ends PandaFM's process (or you swipe it away), playback stops:
  the queue lives in the web app, and isn't rebuilt natively.
- System "next" at the end of a queue does what the app's Next does (nothing
  unless Autoplay or the queue has more).

## Dependencies

The repository deliberately keeps no `package-lock.json`: the web Docker image
installs from `package.json` with `npm install`, and a lockfile made on one
machine can leave out platform-specific packages another needs. What must be
reproducible is pinned exactly instead: Capacitor 8.5.3 in `package.json`,
Media3 1.11.1 in `web/android/variables.gradle`, and the Gradle wrapper version
in `web/android/gradle/wrapper`. Moving both builds to `npm ci` with a
committed lockfile is a good later, separate change.

## Quality profiles (server-side, `api/app/audio/profiles.py`)

| Profile | Lossless sources | Lossy sources |
|---|---|---|
| Original | the file as it is | the file as it is |
| Lossless Portable | FLAC stays FLAC; WAV/ALAC/AIFF → FLAC (same rate and depth) | kept as they are, **never** made FLAC |
| High Quality | AAC 256 kbps (max 48 kHz) | kept if already ≤ ~295 kbps and Android-friendly, else AAC 256 |
| Space Saver | AAC 128 kbps | kept if already ≤ ~147 kbps, else AAC 128 |

Conversions keep title, artist, album, album artist, track, disc, year,
genre and cover art. They are cached in the `pandafm-cache` volume (limit
`PANDAFM_CACHE_MAX_GB`, least recently used removed first); library files are
never modified. Badges: LOSSLESS for lossless sources; HI-RES only for lossless
sources above 16-bit or 48 kHz.

## Walkman checklist

1. Install `app-debug.apk` on the Walkman.
2. Enter your PandaFM address (https://…), Test connection: three ✓, Continue.
3. Play a song while online: it streams.
4. Settings › Offline storage › Choose folder → SD card → create `PandaFM` → Use this folder. Restart the app: the folder is still shown.
5. Open a FLAC song's menu › Download › Original › Start download.
6. Turn Wi-Fi off; play that song: it plays (Downloaded page, Songs).
7. Its menu or Now Playing shows `FLAC · LOSSLESS · 16-bit / 44.1 kHz` (or HI-RES for 24-bit/96 kHz files).
8. Download an album (album page › download button).
9. Download a playlist the same way, with Keep downloaded on.
10. Press Home during a large download: the "PandaFM downloads" notification stays and progress continues.
11. Turn Wi-Fi off mid-download, then on again.
12. Downloads resume (not from zero for large files); failures show Retry failed.
13. On the server, add and remove songs in that playlist.
14. Downloaded › Sync now: new songs download, removed ones disappear.
15. Put a song in two downloaded playlists, remove one playlist download: the song stays.
16. Song menu › Remove download (keeps it on the server).
17. In the browser, the song, its favorite and playlists are all still there.
18. Wi-Fi off: play several downloaded songs, skip one, finish one.
19. Wi-Fi on, open the app.
20. In the browser, Home › Recently played and /stats include those plays.
21. Lock the screen: title, artist, artwork, play/pause, next/previous and seeking work, online and offline.
22. Online: start Panda Radio from Home; it plays and steers as before.
