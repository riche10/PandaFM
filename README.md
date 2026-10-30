# PandaFM

**PandaFM is a self-hosted music frontend, radio/recommendation engine and
Android player for an existing Navidrome/OpenSubsonic library.**

```text
Navidrome / OpenSubsonic server   (your music library: you run it, PandaFM reads it)
              ↓
           PandaFM                (this project: web app, API, PostgreSQL)
              ↓
 Browser · Android app · Android Auto
```

- **Listen anywhere**: a fast web player and an Android app with a native
  background player, lock-screen controls, Android Auto and offline downloads.
- **Panda Radio and Stations**: radio built from your own library and
  listening history.
- **Panda Mix**: play a playlist continuously with DJ-style transitions.
- **Your library, explored**: genres, decades, smart collections, filters.
- **Private by design**: one owner account, encrypted credentials, nothing
  leaves your server.

PandaFM never modifies your music; Navidrome stays the source of truth.

## Where your data lives (5.5.2)

- **Your music server (Navidrome / OpenSubsonic)**: the music library, the audio streams, your playlists,
  and album/artist favorites. It also gets a copy of your song likes (as stars), best-effort.
- **PandaFM's own database**: your liked songs, listening history, Panda Radio's sense of your taste,
  stations, Panda Mix settings and app state. Moving to another music server with the same music keeps
  all of it: likes and history follow songs whose ids change when the match is unambiguous.

## Install

1. **Have a Navidrome (or other OpenSubsonic) server** with your music. Any
   machine PandaFM can reach is fine. Don't have one?
   [examples/navidrome-compose.yml](examples/navidrome-compose.yml) is a
   separate, optional stack.
2. **Deploy PandaFM** (Docker Compose, or a Portainer stack from this
   repository):
   ```bash
   git clone https://github.com/riche10/PandaFM.git && cd PandaFM
   cp .env.example .env        # set POSTGRES_PASSWORD; everything else is optional
   docker compose up -d --build
   ```
3. **Open PandaFM** at `http://<your server>:8086`.
4. **Create the owner account.** From your home network that's all it takes;
   if PandaFM is reachable from the internet before setup, set
   `PANDAFM_SETUP_TOKEN` and enter it here.
5. **Connect your music server**: its address, username and password. PandaFM
   tests the connection, stores the password encrypted, and imports your
   library in the background.
6. **Enjoy.** On Android, install the app and enter PandaFM's address.

Upgrading from 5.2 or earlier (which bundled Navidrome)? Read
[docs/upgrading-to-5.3.md](docs/upgrading-to-5.3.md) first: your data stays.

## Configuration

Only `POSTGRES_PASSWORD` is required; see [.env.example](.env.example) for the
optional settings (web port, setup token, trusted proxies, cache size, log
level, Panda Mix workers). The music server is configured in the app (setup,
or Settings › Music server), not in environment variables.

| Volume | Holds | Back up |
|---|---|---|
| `pandafm-db` | owner, devices, history, playlists' extras, stations, settings | yes |
| `pandafm-config` | the installation key that decrypts the saved music server password | yes, with the database |
| `pandafm-cache` | conversions and scratch space (re-creatable) | no |

## Putting PandaFM behind a reverse proxy

### PandaFM before adding your external proxy

The app itself is available at:

```text
http://<ubuntu-server-ip>:8086
```

The frontend container automatically forwards `/api/*` to the private
`pandafm-api` container, so PandaFM works on that one port.

### Existing Nginx / Nginx Proxy Manager

Your public reverse proxy only needs one upstream:

```text
http://<ubuntu-server-ip>:8086
```

For example, a hostname such as `pandafm.example.com` can point entirely to
port 8086. Do not create a separate public route to FastAPI; the web container
already handles `/api/*` internally.

This keeps PandaFM portable: someone can deploy the Docker stack and use
whatever edge proxy they already run (Nginx, Traefik, Caddy, Cloudflare
Tunnel, etc.).


## Using PandaFM

On a computer, the sidebar has Home, Search, Library, Favorites and your
playlists, and the player bar along the bottom has artwork, favorite,
previous / play / next, progress and volume. On a phone (or the Walkman),
Home, Search and Library sit along the bottom with a mini player just above;
tap it for Now Playing.

- **Home**: quick access, Recently added, Favorite songs, your playlists
  and a random selection. *Recently played* appears only when Navidrome has
  play history (PandaFM doesn't report plays yet).
- **Search**: results grouped into Songs, Artists and Albums. Songs come in pages: *Show all* loads
  every matching song (5.5.2; it used to stop at 20), and playing from there plays all of them.
- **Library**: Albums (recently added, A–Z, random), Artists, Songs (all,
  in Navidrome's order, or random) and Playlists.
- **Favorites**: tap a heart on any song, album or artist. Song likes belong to PandaFM (5.5.2):
  they're saved in PandaFM first and mirrored to your music server's stars so other Subsonic apps see
  them too, but a music server with no stars (a fresh install, a new server) never removes them. Album
  and artist favorites still follow your music server's stars.
- **Playlists**: create from the sidebar or Library, add songs from any
  song's ⋯ menu (or a whole album from its ⋯ menu), remove, rename or delete
  from the playlist page. They are stored in Navidrome.
- **Queue**: one shared queue for everything you play. Use *Play next* or
  *Add to queue* from any song's ⋯ menu (or an album's). Open it with the
  queue button in the player (a panel on computers, its own page on
  phones) to jump to a song, remove songs, move them up or down, or clear
  what's coming. Hand-picked songs play before the rest of the album or
  playlist.
- **Shuffle and repeat**: Shuffle on any album, artist, playlist or
  Favorites page, or toggle it in the player; the current song keeps
  playing and turning shuffle off restores the original order. Repeat
  cycles off → all → this song.
- **Lock screen and notification**: over HTTPS (for example through your
  reverse proxy), Android shows the song, artist and artwork with working
  previous / play / next / seek. Over plain `http://<server-ip>`, browsers
  don't offer this, and Chrome shows its basic media notification instead.
- Space plays and pauses. Playback keeps going while you move around; a
  full page refresh brings your queue back, paused (the Android app keeps its
  queue in its playback service).

All music and artwork go through PandaFM's API (`/api/...`). The browser
never talks to Navidrome and never sees its credentials. The API reference
is at `/api/docs`.

PandaFM streams your original files, so seeking always works. Phones play
MP3, AAC/M4A, FLAC and Ogg/Opus; ALAC and WMA files won't play in the
browser yet.

If something is down, a banner explains it. The full connection check is
at `/status`.

### External Nginx / Nginx Proxy Manager settings for audio

PandaFM works behind your proxy with one upstream (port 8086). For smooth
audio, turn off response buffering so songs stream as they arrive and
seeking starts quickly:

```nginx
location / {
    proxy_pass http://<ubuntu-server-ip>:8086;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

In Nginx Proxy Manager, put `proxy_buffering off;` in the proxy host's
Advanced tab. Range headers (used for seeking) pass through Nginx by
default; don't enable response caching for `/api`.

## Panda Radio and listening history

PandaFM now remembers how you listen (plays, songs you finish, early and
late skips, pauses and seeks) in its own PostgreSQL database, and uses
that, plus your liked songs, for **Panda Radio**:

- Start it from any song's ⋯ menu, an album or artist page, or the mode
  cards on Home: **Panda Radio** (balanced), **Study** (steady),
  **Familiar** (favorites and songs you finish), **Discovery** (rarely
  played corners of your library) and **Chaos** (anything goes).
- Radio fills the normal queue and keeps it topped up. *Play next* and
  *Add to queue* still work and are never removed by radio.
- Skip two or three radio songs in a row and the session changes direction
  straight away; one session's skips barely move your long-term taste.
- *Why this song?* explains any radio pick. `/stats` shows what PandaFM has
  learned and lets you re-sync the library.
- Real listens (a finished song, or half a song / 4 minutes) are also
  scrobbled to Navidrome, so its own history stays useful.

### Database migrations (automatic, safe on your existing volume)

The API container runs `python -m app.migrate upgrade` before it starts.
Migrations only add tables and columns (the first one, `0001`, created
PandaFM's schema; 5.0's `0005` added sign-in and devices); nothing is
dropped and the PostgreSQL and Navidrome volumes are never touched. A
PostgreSQL advisory lock stops two API containers from migrating at once.

To deploy: in Portainer, point the stack at the branch (or `main` after
merging) and **Pull and redeploy**. Do **not** tick anything that removes
volumes. Then check:

```bash
docker logs pandafm-api 2>&1 | grep "schema is at revision"   # → 0008 (5.3)
docker exec pandafm-api python -m app.migrate check           # database: 0008, code expects: 0008
```

About 20 seconds after start-up, PandaFM copies Navidrome's song list into
its cache (and again after each Navidrome rescan, or every 6 hours).
Starting Panda Radio before that simply waits for the first copy. You can
also run it from `/stats`, or with `curl -X POST http://<server>:8086/api/library/sync`.

If a migration ever fails, the API container stops (it won't run on a
half-updated schema): `docker logs pandafm-api` shows why, and your data
is untouched.

## Running the tests

```bash
# API (no Navidrome or database needed; Navidrome is faked; database tests skip)
docker run --rm -v "$PWD/api:/app" -w /app python:3.12-slim \
  sh -c "pip install -q -r requirements-dev.txt && pytest -q"

# Including the database tests, against a throwaway PostgreSQL (never your real one)
docker network create pandafm-test
docker run -d --rm --name pandafm-testdb --network pandafm-test \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test postgres:17-alpine
docker run --rm --network pandafm-test -v "$PWD/api:/app" -w /app \
  -e PANDAFM_TEST_DATABASE_URL=postgresql+psycopg://test:test@pandafm-testdb/test \
  python:3.12-slim sh -c "pip install -q -r requirements-dev.txt && sleep 3 && pytest -q"
docker stop pandafm-testdb && docker network rm pandafm-test

# Web player logic (Node's built-in test runner)
docker run --rm -v "$PWD/web:/app" -w /app node:22-alpine \
  sh -c "npm install --no-audit --no-fund && npm test"
```

## Repository structure

```text
PandaFM/
├── docker-compose.yml
├── .env.example
├── api/
│   └── app/
│       ├── navidrome/   # the only code that speaks Subsonic
│       ├── routers/     # health, library, media, favorites, playlists,
│       │                # events, sync, radio, me (home + stats)
│       ├── radio/       # Panda Radio engine: config (all weights), signals,
│       │                # session, scoring, selection, explain (no database)
│       ├── services/    # library sync, events, radio sessions, insights
│       ├── migrations/  # Alembic migrations (run by app/migrate.py)
│       ├── models.py    # PandaFM's tables
│       ├── schemas/     # PandaFM's library models
│       └── errors.py    # user-safe error responses
└── web/
    ├── Dockerfile
    ├── nginx.conf
    └── src/
        ├── api/         # typed calls to /api
        ├── player/      # audio engine (two decks), shared queue, player store,
        │                # Media Session
        ├── library/     # favorites, playlists and toast state
        ├── shell/       # sidebar, bottom nav, player bar, mini player
        ├── components/  # cards, track lists, menus, dialogs
        ├── dialogs/     # new / rename / delete playlist, add to playlist
        └── views/       # Home, Search, Library, Favorites, Playlist,
                         # Album, Artist, Now Playing, Queue, Status
```

Secrets belong in your deployment's environment variables (or Portainer's) and must not be committed.

## Android app and offline downloads

PandaFM builds as an Android app (Capacitor) for phones and Android
Walkmans: stream your whole library, or download songs, albums, playlists
and Favorites as ordinary files to a folder you choose, including on an SD
card. Downloads can be the original files or portable conversions made on
the server (Lossless Portable, High Quality AAC 256, Space Saver AAC 128).
Lossy files are never converted to FLAC. See [docs/android.md](docs/android.md)
for building the APK, how storage and sync work, and a test checklist.
On the build server, `scripts/build-android-apk.sh [branch]` updates the
checkout and builds the APK in one command; the launcher icon (a panda with
headphones) is generated from `web/assets/` with `npm run android:icons`.

Server side, offline downloads add:

- migration `0002` (additive): audio facts on cached tracks and a
  `conversions` table;
- ffmpeg in the API image, used only to convert copies for downloads;
- a `pandafm-cache` volume for converted copies (`PANDAFM_CACHE_MAX_GB`,
  default 20; safe to delete, copies are remade on demand);
- CORS for the app's WebView origin (`https://localhost`).

After redeploying, `docker logs pandafm-api 2>&1 | grep "schema is at revision"`
should show the latest revision (`0008` as of 5.3: `0007` music-server settings, `0008` persistent mixed playlists). Quality badges appear once the next library sync (within
a minute of start-up) has stored the new audio facts.

## Personalisation and Autoplay

**Appearance** (Settings › Appearance) is chosen per device and applied
instantly: Panda Classic (default), Dark, AMOLED, Light, Walkman Midnight,
or System. Album artwork can tint the music screens (Off, Subtle,
Immersive), always kept readable. Pick an accent, or build a custom theme
from six colours and a corner style; themes export and import as small
JSON files containing colours only. If a look ever goes wrong, Settings ›
Appearance › Reset to Panda Classic.

**Panda Radio presets** (Settings › Radio) are stored on the server, so
every device shares them. Rename built-in modes (Study → Lock In) without
changing how they choose songs, or create your own from any built-in with
six controls: familiarity, discovery, continuity, artist variety, genre
variety and wildcards. The server turns these into bounded weights for the
same radio engine; repeat protection always applies. Migration `0003`
(additive) adds `radio_presets`, `users.preferences` and preset snapshots
on radio sessions.

**Autoplay** (Settings › Playback, per device, on by default): when a song,
album, artist, playlist or other finite queue ends naturally, PandaFM
continues with Panda Radio seeded from it, in the same queue. Repeat, songs
you queued, End Radio, and being offline all keep the normal ending.

## Radio coherence and My Stations

**One genre model** (`api/app/radio/genres.py`) is used by all radio:
genre tags are normalized ("Pop-Punk" = "pop punk", "Alt. Rock" =
"alternative rock"), grouped into families (rock, punk, metal, pop,
electronic, hip hop, r&b, jazz, classical, soundtrack, ambient, folk...),
and compared by similarity (same 1, family root/child 0.85, siblings 0.7,
neighbouring families less, unrelated 0).

**Song-seeded Panda Radio stays coherent.** It fits songs to the seed by
genre similarity rather than exact tags, and a clearly unrelated song (a
film score on rock radio) gets a penalty. The seed's pull fades gently as
the session goes on (92% per song, never below 35%), so radio drifts
towards what you actually listen to without forgetting where it started.
This also fixed an early radio bug: a skip used to make a session forget
its seed entirely.

**My Stations** (on Home) are music neighbourhoods you create: a name, one
or more genres from your library, and a radio style (any built-in or custom
preset). A station is anchored for its whole session: it only plays songs
close to its genres (Rock includes Alternative Rock, Pop Punk, J-Rock and
rock-adjacent Metal; not Film Score or Classical), however much the radio
explores. Stations live on the server (migration `0004`), so every device
sees them. Edit, duplicate or delete them from a station's ⋯ menu.
Deleting one never stops it if it's playing, and never touches songs,
presets or history. If a station's custom radio style is deleted, it plays
as Panda.

In the Android app, the system Back button now closes an open dialog or
menu first, then goes back through PandaFM's pages, and only leaves the app
from Home. With music queued, it moves PandaFM to the background so the
music keeps going.

## Android app updates (5.4.1)

Your server can publish the Android app: run `scripts/build-and-publish-android.sh`
on the build host, and phones update from **Settings › App** (Android's own
installer asks you to confirm; downloads are checked against the release's
SHA-256 and PandaFM's signing certificate). New devices install from
`/download/android/`. See **[docs/android-updates.md](docs/android-updates.md)**.

## Panda Mix

Turn **Panda Mix** on for a playlist and it stays mixed until you turn it off.
PandaFM analyses that playlist (never the rest of your library), builds a stable
playback order from BPM/key/loudness compatibility, and **Panda DJ** blends each
adjacent pair using Auto, Gentle, Flow or Energetic transitions. The primary
Play button uses the saved mixed order while Panda Mix is enabled; Remix makes
a new order, and the original Navidrome playlist/order is never modified.
Adjust any transition, preview it and save it for that playlist. See
**[docs/panda-mix.md](docs/panda-mix.md)**.

## Sign-in and remote access

> **Do not expose a PandaFM build older than 5.0 to the internet.** It has no sign-in.

5.0 adds an owner account and makes PandaFM safe to reach from outside your
home through an HTTPS reverse proxy. See **[docs/security.md](docs/security.md)**
for the full model, reverse-proxy recipes and upgrade steps.

- **Secure first-time setup** with `PANDAFM_SETUP_TOKEN` (an environment variable). Only
  works until the owner exists; your existing history becomes the owner's.
- **Owner sign-in:** Argon2id passwords; HttpOnly session cookies with CSRF
  protection in browsers; Keystore-protected device sign-in in the Android app.
  Every library, media and radio API needs sign-in; API docs are off.
- **Settings › Account & devices:** see where you're signed in, sign out a
  device or all others, change your password.
- **Streaming quality** per device: Auto (app: original on Wi-Fi, AAC 256 on
  mobile data), Original, High (AAC ~256 kbps), Data Saver (AAC ~128 kbps).
- **Your queue survives a restart**, restored paused.

Recommended public topology: Internet → HTTPS :443 → your reverse proxy →
`pandafm-web` :8086 → PandaFM API → PostgreSQL / Navidrome. Publish only the
reverse proxy.

## Library explorer

Everything here comes from **your own Navidrome library and PandaFM's
listening history**; no external recommendation, metadata or catalogue
service is involved.

- **Genres** (Library › Genres): every genre in your library, once. Spellings
  like "Pop-Punk", "pop punk" and "Pop Punk" are one genre (the radio coherence
  genre model in `api/app/radio/genres.py`), shown with your library's most
  common spelling. Related genres (Pop Punk, Alternative Rock) stay separate.
- **Genre pages** (`/genres/<genre>`): artists, albums and songs, Play,
  Shuffle and **Genre Radio** ("Rock Radio", or with any built-in or custom
  preset from the menu). Genre Radio is a normal Panda Radio session with the
  same genre anchor My Stations use, without saving a station; "Save as
  station" prefills one.
- **Album and artist genres**: albums show their genres as chips (deduplicated,
  wrapping on small screens); artists show their 1-3 dominant genres.
- **More like this** on album pages: other albums from your library by genre
  similarity (then era and your genre taste). Albums by the same artist and
  albums that aren't genuinely alike are left out; with no real match the
  shelf is hidden.
- **Decades** (Library › Decades): only decades you have music from; songs
  without a year are left out.
- **Smart Collections** (Library › Collections), generated live: Recently
  Added, Unplayed (no PandaFM play history), Favorites, Rediscover (the
  existing listening-history rule), Lossless and Hi-Res (PandaFM's own quality
  rules), and Downloaded in the Android app.
- **Filters** on Albums (genre, decade, favorites) and Songs (also lossless,
  hi-res, and downloaded on this device in the app). They're in the URL, so
  Back undoes them, and the server does the filtering and paging.
- **Info** in song and album menus: only facts PandaFM actually has (codec,
  sample rate, bit depth, …). An album gets one quality line only when it's
  true of every song; otherwise "Lossless · mixed formats" or "Mixed quality".
- **Search** also finds genres ("pop punk"), and **Home** shows your genres
  and a few ways into your library.

API: `GET /api/genres`, `/api/genres/top`, `/api/genres/{genre}`,
`/api/browse/albums`, `/api/browse/tracks`, `/api/library/decades`,
`/api/albums/{id}/related`, `/api/collections`, `/api/collections/{id}/tracks`.
They read PandaFM's synced track cache (refreshed by the library sync);
Navidrome stays the source of truth.
