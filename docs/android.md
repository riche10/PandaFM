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

## App icon

PandaFM's launcher icon is a panda face with headphones on a Walkman-orange
background. It is an Android adaptive icon (every launcher shape) with a
monochrome layer for Android 13+ themed icons.

The artwork lives in `web/assets/` (1024 × 1024 PNGs, plus the SVGs they were
drawn from):

| File | What it is |
|---|---|
| `app-icon-background.png` | Full-bleed background; launchers crop it to their shape |
| `app-icon-foreground.png` | The panda, on transparency |
| `app-icon-monochrome.png` | One colour on transparency; Android tints it for themed icons |
| `app-icon.png` | The composed icon (generated; for previews and store listings) |

Keep everything important inside the central circle of the foreground and
monochrome layers: radius 313 px around the centre of the 1024 canvas (66dp of
108dp). Launchers may cut off anything outside it.

**Replace the artwork:** drop new PNGs over the three layer files (or edit
the SVGs), then regenerate:

```bash
cd web
npm run android:icons              # from the PNGs
npm run android:icons -- --from-svg  # re-export the PNGs from the SVGs first
```

This writes every mipmap density (legacy square and round icons for Android
7, adaptive layers and `mipmap-anydpi-v26/ic_launcher*.xml` with the
monochrome layer) under `web/android/app/src/main/res/`. Commit the artwork
and the generated files. It uses `sharp` 0.35.5, installed on demand (not a
project dependency, so normal web builds are unaffected). The build script
below regenerates the icons automatically whenever the artwork is present.

## One-command build on the server

`scripts/build-android-apk.sh` updates the checkout and builds the APK:

```bash
scripts/build-android-apk.sh              # main
scripts/build-android-apk.sh feature/x    # another branch
```

It fetches `origin`, checks out the branch and **hard-resets this checkout
to `origin/<branch>`** (local changes to tracked files there are discarded:
use a checkout dedicated to building). It regenerates the icons if
`web/assets` has artwork, runs `PANDAFM_ANDROID_ALLOW_HTTP=1
./web/android/build-apk.sh` (signed with the same persistent key, so the APK
installs over the previous one), and prints the APK path:

```
PandaFM 0.4.2 (main @ 5b93ade) APK:
/home/you/PandaFM/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Options: `PANDAFM_ANDROID_ALLOW_HTTP=0` for an HTTPS-only build,
`PANDAFM_ANDROID_ICONS=0` to skip icon generation (`1` forces it). Only one
build runs at a time.

A short command on the server:

```bash
mkdir -p ~/bin
cat > ~/bin/build-pandafm-apk <<'SH'
#!/usr/bin/env bash
exec "$HOME/PandaFM/scripts/build-android-apk.sh" "$@"
SH
chmod +x ~/bin/build-pandafm-apk
```

Ubuntu adds `~/bin` to `PATH` at your next login (or run `source ~/.profile`).
Then `build-pandafm-apk` builds `main` and `build-pandafm-apk feature/x`
builds a branch. Adjust `$HOME/PandaFM` if your checkout lives elsewhere.

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

- **The native queue is in charge (5.0.1).** On Android the playback service
  (`PlaybackService`, a Media3 `MediaLibraryService`) owns the queue
  (`NativeQueue`, driven by `QueueController`). The app's screens are a
  synchronised view: they send commands (play this album, Play next, remove,
  move, shuffle, repeat…) and mirror the snapshots the service publishes. In
  browsers nothing changed: the web queue is in charge there.
- **Background playback without the app.** Songs advance, Panda Radio refills
  and Autoplay continues inside the service, so swiping PandaFM away, a
  destroyed Activity, or Android Auto starting the service on its own doesn't
  stop the queue. Music that is playing keeps going; a paused or empty player
  lets the service stop. Listening history is reported by the service too.
- **What plays next vs. how it plays.** `QueueController` decides what plays;
  `ExoEngine` plays one song. Each load has a generation number, so a late
  "song ended" after you pressed Next can't advance the queue twice. (This
  split is what Panda DJ's two-deck engine builds on.)
- **Media controls** (lock screen, notification, Bluetooth, headsets, Walkman
  buttons, the car) all go through `QueuePlayer` straight to the native queue.
  Audio focus and "headphones unplugged" use Media3's standard handling.
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


## Signing in (5.0)

First run: **Server address → Test connection → Sign in** (or, on a brand-new
server, **Set up PandaFM** with the administrator's setup token).

- The app signs in as a *device*: it gets a refresh token and short-lived
  access tokens. The refresh token is encrypted with an AES-GCM key kept in
  the Android Keystore and is excluded from Android backups and
  device-to-device transfers; access tokens stay in memory.
- Native playback (Media3), lock-screen artwork and background downloads
  authenticate by themselves (`AuthStore`), so they work without the app's
  screen open. The token is sent only as an `Authorization` header and only to
  your PandaFM server's own address; downloads follow redirects only within
  that address, and Media3 never forwards it to another host.
- If the session ends (signed out from Settings › Account & devices, password
  changed), the app shows sign-in again. **Continue offline** keeps downloaded
  music playable; downloads are never deleted by signing out.
- `adb logcat -s PandaFM.Auth PandaFM.Download` shows sign-in and download
  events without passwords or tokens.


## Queue persistence (5.0.1)

The service saves its queue to `files/queue.json` (written atomically: a
temporary file, then a rename), after every change and every 10 seconds while
playing: the songs (PandaFM's own track records, at most 500 around the
current one), the current song, the source (album, playlist, radio, station…),
shuffle, repeat, the radio session and the position. It never contains URLs,
tokens or artwork. After a restart the queue comes back **paused** and Play
resumes where it was; nothing ever plays by itself after a cold start. A
corrupt or unknown file is ignored (the queue starts empty). If the radio
session has ended on the server, its songs stay and the radio link is
dropped. Streams are resolved when a song loads, so the current network and
streaming quality always apply.

Upgrading from 5.0: the first time 5.0.1 opens, a valid queue the 5.0 app had
saved is moved into the service once (only if the service's queue is empty).
Browser queues are untouched.

## Android Auto

PandaFM appears in Android Auto as a media app with the car's own driver-safe
browsing UI (no custom screens). Sign in and choose the server on the phone;
the car never asks for a password.

```
PandaFM
├── Recently played
├── Favorites
├── Panda Radio            Panda, Familiar, Discovery, Study, Chaos, your Radio Styles
├── My Stations
├── Playlists → playlist → songs
├── Genres → genre → Start <Genre> Radio · Songs · Albums
├── Albums → album → songs        (pages from the server)
├── Artists → artist → albums
├── Smart Collections      Recently Added, Unplayed, Favorites, Rediscover, Lossless, Hi-Res
└── Downloaded             Albums, Playlists, Songs (always on the phone)
```

- **Playing** a song plays its album, playlist or list from that song; playing
  an album, playlist, collection or Favorites plays all of it. Stations, radio
  styles and genres start Panda Radio on the server (the same semantics as on
  the phone); the service keeps it topped up.
- **Search and voice** use PandaFM's search ("Play Daft Punk", "Play Random
  Access Memories", "Play my workout playlist", "Play Pop Punk", "Play my Pop
  Punk Drive station"). Saying "playlist" or "station" prefers those; otherwise
  an exact song, artist, album, playlist, genre (its radio) or station, then
  the broader search.
- **Not signed in** (or this phone was signed out): the car shows only "Open
  PandaFM on your phone to sign in." and your downloads; no library details.
- **No connection:** the root becomes Downloaded and Resume queue. Downloaded
  songs always play from the phone, never streamed.
- **Streaming quality** follows Settings › Playback (Auto: original on Wi-Fi,
  AAC ~256 kbps on mobile data), decided per song, so a network change applies
  from the next song without restarting the queue.
- **Artwork** in the car's lists comes from PandaFM's own content provider,
  granted only to the car app that asked; no tokens appear in any address.

### Testing with the Desktop Head Unit (DHU)

1. Install the Android SDK's **Android Auto Desktop Head Unit Emulator** (SDK
   Manager › SDK Tools), then on the phone install Android Auto.
2. On the phone: Android Auto settings → tap **Version** ten times → **Developer
   settings** → **Start head unit server**. Also allow **Unknown sources** there
   (for a locally built APK).
3. Connect the phone by USB and run `adb forward tcp:5277 tcp:5277`, then start
   `desktop-head-unit` from `<sdk>/extras/google/auto/`.
4. In the DHU, open the media apps launcher: **PandaFM** is listed. Browse the
   root, open Playlists, play one; check title, artist, artwork, next/previous.
5. Voice: press the DHU's microphone (or type `mic` commands in its console) and
   say "Play <artist>".
6. Offline: switch the phone to airplane mode (keep USB), reopen PandaFM in the
   DHU: Downloaded and Resume queue only.

No Play Store publication is needed for this.

### Manual acceptance checklist

Online
1. Sign in to PandaFM on the phone. Connect Android Auto.
2. PandaFM appears as a media app; browse the root.
3. Playlists → start a playlist; title, artist and artwork appear.
4. Next and previous work. Lock the phone and swipe PandaFM away.
5. The song ends and the next one plays (no app screen).
6. Genres → start a Genre Radio. My Stations → start a station.
7. Search for an artist, an album and a song.

Offline
1. Download a playlist on the phone. Turn the network off.
2. Connect Android Auto: Downloaded is offered; play the playlist.
3. With the app swiped away, the next downloaded song plays.

Sign-in
1. From a browser, Settings › Account & devices → sign out the phone.
2. Android Auto's library shows only "Open PandaFM on your phone to sign in."
3. Downloaded music is still there; the phone asks you to sign in.

### Limitations

- The car's "up next" list shows the current song (PandaFM's queue is in the
  service, not in Media3's playlist); next/previous always work.
- Regular playback uses one native deck; Panda Mix uses two decks for overlapping transitions.
- Car artwork for downloaded songs needs the server once (it's cached after).
- Voice requests depend on what Google Assistant passes to media apps.


## Playback stability (5.1)

5.1 fixes the 5.0.1 reports of music stopping after a few minutes and of the
Now Playing timeline freezing. What was wrong, and how it works now:

- **The service wasn't a foreground media service.** 5.0.1's rewrite dropped
  `addSession(session)`. Media3 then only managed the media notification and
  the foreground state once some `MediaController` connected, and PandaFM's own
  screens don't use one. The service could stay an ordinary background service,
  which Android stops a minute or so after the app leaves the screen:
  `onDestroy` released the player and the music stopped. The session is added
  again as soon as it exists.
- **Buffering was taken for a pause.** PandaFM's state now comes from Media3's
  facts together (`PlaybackStateModel`): `playbackState`, `playWhenReady`,
  `isPlaying` and the playback suppression reason. Waiting for data, or a moment
  of lost audio focus, is *buffering* (still meaning to play); only
  `playWhenReady=false` is a pause. Pause and resume listening events are
  recorded where they're asked for, never inferred from buffering.
- **The timeline stopped and couldn't restart.** The plugin's position ticker
  now runs whenever playback is intended (playing, loading, buffering). When the
  service is recreated the plugin moves its listener to the new queue (5.0.1
  kept listening to the old one). Coming back to the app, and opening Now
  Playing, re-reads the native snapshot at once.
- **Artwork touched the playing song.** Artwork is now a `content://` URI on
  the MediaItem from the start (`ArtworkProvider`, signed-in fetch or the
  downloaded copy); Media3's own bitmap loader resolves it for the
  notification, lock screen and car. The playing item is never replaced, and a
  missing or failed cover can't affect audio.
- **Network trouble.** A stream that fails with a clearly recoverable network
  error (or an expired access token: refreshed first) is retried at most three
  times (1 s, 3 s, 8 s), at the same position, as *buffering*. Anything else is
  a clear error; the queue stays and Play, Next and Previous still work.
  Downloaded files are never retried (and never streamed). A first-play live
  AAC stream that can't seek is reloaded at the new position.
- **Lifecycle.** `onTaskRemoved` keeps the service while PandaFM means to play
  (a buffer can't look like "inactive"). After `onDestroy`, late radio,
  library, engine and artwork callbacks are ignored. Queue and listening-event
  files are written on a background thread; the sign-in check no longer
  decrypts with the Keystore on the player thread.

### Logs and Diagnostics

`adb logcat -s PandaFM.Playback PandaFM.Auto PandaFM.Auth PandaFM.Download`
shows state transitions (`gen=24 playing → buffering playWhenReady=true`),
user pauses and plays, player errors (Media3 code, remote or downloaded,
generation, state, track id, retry count), and the service lifecycle
(`onCreate`, recreation, queue restore, `onTaskRemoved` and its decision,
`onDestroy`). No position ticks, URLs, tokens or passwords are logged.

Without a computer: **Settings › Diagnostics** shows the PandaFM version,
whether the playback service is running, the queue and ExoPlayer state,
`playWhenReady`, `isPlaying`, the current track id, queue index and length,
generation, source (remote/downloaded), stream quality, network, position,
duration, the last playback error, and the last 50 playback events (kept in
memory only). **Copy diagnostics** puts it all on the clipboard.

### Manual acceptance checklist (5.1)

**Basic playback**
1. Install 5.1 over 5.0.1 (no uninstall: same package and signing key).
2. Open PandaFM.
3. Play a remote playlist.
4. Leave it playing at least 15 minutes.
5. The timeline updates continuously.
6. Audio doesn't randomly stop.
7. Several tracks advance correctly.

**Now Playing**
1. Open Now Playing and watch the slider.
2. Background the app, then return.
3. The slider immediately shows the correct position.
4. Seek; the position keeps updating.

**Lock screen**
1. Start playback; lock the phone for 15+ minutes.
2. Several songs advance.
3. Unlock: PandaFM shows the correct song and position.

**Background**
1. Start playback, press Home, use other apps.
2. Music continues and the queue advances.

**Swipe away**
1. Play a playlist; swipe PandaFM from Recents.
2. Music continues; the next track starts when the current one ends.

**Buffer simulation**
Temporarily degrade or disconnect Wi-Fi. Expected: playing → buffering →
playing, never permanently paused.

**Artwork**
Start a track whose artwork isn't cached yet. Artwork may appear later; audio
must not stutter, restart or stop when it does.

**Downloaded**
Play downloaded tracks with the network off. The timeline and advancement stay
stable.


## Panda Mix on Android (5.3)

`PandaDjEngine` gives the playback service two decks, each the 5.1
`EngineCore` over its own ExoPlayer. Normal Play uses one deck exactly as in
5.1. During a Panda Mix the next song is preloaded on the standby deck about
20 s before the transition, the blend runs on the outgoing deck's own clock
(equal-power gains), the current song (history, lock screen, Android Auto)
changes at the midpoint and the session follows that deck, and the old deck
stops afterwards. Only the current deck holds audio focus. If the incoming
song becomes ready late, Panda DJ shortens the remaining overlap instead of
dropping the mix immediately; if it never becomes ready, the current song
finishes normally and Diagnostics records why. Seeking safely re-arms an
upcoming transition instead of forgetting it. Plans are cached in
`files/mix-plans.json` for offline use. See [panda-mix.md](panda-mix.md).


## Connecting to the server (5.3)

The app decides its first screen from one connection state: no server saved
(Connect to PandaFM), saved server unreachable (Can't reach your PandaFM
server: Try again, Change server, or Continue offline when downloads exist;
the address is never erased by an outage), setup unfinished (owner account,
then the music server), signed out (Sign in), or ready. A server only counts as
PandaFM if `/api/health` answers like PandaFM. If PandaFM answers but its music
server doesn't, the app opens normally with a banner: that's a server-side
problem, not a wrong address.


## Next-track warmup (5.4)

Ordinary playback (not only Panda Mix) uses the standby deck to warm the next
song: about 2 s into the current song, the queue's true next item is loaded
silently (volume 0, never started, no play event, no queue or session change)
from the source Next would use right now (the download if there is one,
otherwise the stream for the current quality and network). While a deck is the
standby, its load control stops buffering at about 8 s ahead. Next, the song
ending, or jumping to exactly that song promotes the warm deck at once; the
following song then warms on the other deck. If the warmup is missing, failed,
stale (the queue changed) or from a different source (quality or network
changed, a download finished), PandaFM loads the song the normal way, so
playback always advances. Repeat One and offline-and-not-downloaded songs warm
nothing; a standby deck never retries on its own. Settings › Diagnostics shows
the warmup state (idle, resolving, loading, ready, failed, invalidated), track,
source, seconds buffered and the standby deck.

## Launcher icon artwork

`scripts/build-android-apk.sh` regenerates the launcher icons when either
`web/assets/app-icon-foreground.png` or `.svg` exists, after checking the PNGs
with `scripts/check-android-icons.py --sources` (damaged artwork keeps the
current icons with a warning; `PANDAFM_ANDROID_ICONS=1` fails instead). After
a regeneration it stamps `web/android/icon-sources.sha256`; `--stale` reports
launcher icons that don't match the current artwork. As of 5.4 the four
`web/assets/app-icon*.png` files are damaged (they can't be decoded) and need
re-exporting from the original artwork before the new branding can ship.


## Streams from sleeping storage (5.4.2)

If your music lives on a NAS whose disks spin down, the first song after a quiet
spell can take 10-20 s to open. PandaFM now treats that as **loading**, not a
failure:

- The server waits up to `PANDAFM_NAVIDROME_STREAM_TIMEOUT_SECONDS` (default
  30) for Navidrome to start an audio stream (Original, and the source of a
  High/Data Saver conversion). Every other Navidrome call keeps its short 10 s
  timeout. If the stream still hasn't started, the answer is `503
  navidrome_unavailable` with `Retry-After: 5`.
- The phone keeps the song selected and the intent to play, shows it as
  loading, and retries after 2, 5, 10 and 20 s (or later if the server asks),
  then shows "Your music server isn't responding". Its HTTP read timeout (45 s)
  outlasts the server's wait.
- Recovery follows the real HTTP answer (Settings › Diagnostics shows it, e.g.
  `HTTP 503 · navidrome_unavailable`, the attempt, the next retry and "HTTP 503
  → recovered after 13.4 s"): only **401** refreshes the device's sign-in
  (once); 403 and other client errors aren't retried; **404/410** (a song the
  music server no longer has) skips to the next song in a queue, at most three
  in a row, with no retries; **416** gets one fresh load; **429** waits as long as
  `Retry-After` says; `navidrome_auth` and `music_server_not_configured` stop at
  once (they need the owner, not a retry). The standby (next-song warmup)
  deck never retries, and doesn't open its request while the current song is
  still waiting at 0:00.

To see what the server answered:

```sh
docker logs pandafm-api 2>&1 | grep stream_open
```

Each request logs `waiting_for_navidrome`, then `ready elapsed_ms=… status=…`
or `failed elapsed_ms=… panda_status=… error=…` (no tokens or credentials).
