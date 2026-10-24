# PandaFM for Android (and Sony Walkman)

The Android app is the same React app as the web version, wrapped with
Capacitor 8. It streams from your PandaFM server and can keep music on the
device, as ordinary audio files in a folder you choose (internal storage or
an SD card).

## Build the APK

You only need Docker (for example on the PandaFM server):

```bash
git clone https://github.com/riche10/PandaFM.git && cd PandaFM
git checkout feature/stage4-android-offline
./web/android/build-apk.sh
# → web/android/app/build/outputs/apk/debug/app-debug.apk
```

The first build downloads the Android SDK (a few minutes); it is kept in
the `pandafm-android-sdk` and `pandafm-gradle` Docker volumes. The script
also runs the native unit tests. The APK is debug-signed, which is fine for
installing on your own devices (allow "install unknown apps" for the app you
open it with).

With Android Studio instead: `cd web && npm ci && npm run android:sync`,
then open `web/android`.

### HTTPS, and plain-http LAN servers

Release builds talk to **https://** servers only. To use a plain
`http://192.168.x.x:8085` address on your home network, build with:

```bash
PANDAFM_ANDROID_ALLOW_HTTP=1 ./web/android/build-apk.sh
```

That build allows cleartext traffic and user-installed certificate
authorities. Don't distribute it; prefer HTTPS through your external Nginx.

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
