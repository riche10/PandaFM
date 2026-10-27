# PandaFM

PandaFM is a self-hosted music app for your own library: a fast web player and
an Android app with offline downloads, Android Auto, **Panda Radio** (radio
from your own listening), **Stations**, and **Panda Mix** (playlists played
continuously, with each song blended into the next).

PandaFM doesn't store or scan music itself. It plays from **your own
[Navidrome](https://www.navidrome.org/) server** (or another
[OpenSubsonic](https://opensubsonic.netlify.app/) server), which keeps your
files read-only. PandaFM adds its own database for listening history, radio,
mixes and settings.

```
browser / Android app
        │  one port (8086 by default)
   pandafm-web (Nginx) ──► pandafm-api (FastAPI) ──► PostgreSQL (pandafm-db)
                                   │
                                   └──► your Navidrome / OpenSubsonic server
```

## Requirements

- Docker with Compose (any host; Portainer or another Compose UI works too).
- A running Navidrome (or OpenSubsonic) server PandaFM can reach over the
  network, and a user on it for PandaFM.

## Quick start

1. Clone this repository and create a `.env` next to `docker-compose.yml`
   (see [.env.example](.env.example)). At minimum:

   ```env
   POSTGRES_PASSWORD=<a long random password>
   PANDAFM_SETUP_TOKEN=<a long random one-time token>
   ```

2. Start it:

   ```sh
   docker compose up -d --build
   ```

3. Open `http://<host>:8086`, enter the setup token and create the owner
   account (this works once; afterwards the token is refused).
4. **Connect your music server**: its address (for example
   `http://192.0.2.10:4533`), and the username and password PandaFM should
   use. PandaFM tests the connection before saving it. The password is stored
   encrypted (AES-GCM) and is never shown again. Change it later in
   **Settings › Music server**.

PandaFM's encryption key comes from `PANDAFM_SECRET_KEY` if you set one;
otherwise it is generated once into the `pandafm-data` volume. Keep that volume
(or set the variable): without the key, PandaFM asks you to re-enter the music
server's password.

## Configuration

| Variable | Default | |
|---|---|---|
| `POSTGRES_PASSWORD` | (required) | PandaFM's database password |
| `PANDAFM_SETUP_TOKEN` | (empty) | One-time token for creating the owner account |
| `PANDAFM_WEB_PORT` | `8086` | The single port PandaFM listens on |
| `PANDAFM_SECRET_KEY` | (generated) | Encrypts the stored music-server password |
| `PANDAFM_CACHE_MAX_GB` | `20` | Converted-audio cache for streaming and downloads |
| `PANDAFM_MIX_ANALYSIS_WORKERS` | `1` | Panda Mix analysis concurrency (niced below streaming) |
| `PANDAFM_TRUSTED_PROXIES` | private networks | Reverse proxies whose `X-Forwarded-For` is trusted |
| `PANDAFM_NAVIDROME_URL/USER/PASSWORD` | (empty) | **Legacy**, see "Upgrading" below |

Remote access, HTTPS, reverse-proxy recipes and device sign-in are covered in
[docs/security.md](docs/security.md). Put PandaFM behind HTTPS before exposing
it to the internet.

## Upgrading from 5.2 or earlier (bundled Navidrome)

Before 5.3 the stack also ran Navidrome. 5.3 removes that service from
`docker-compose.yml`, but **its data volume is kept** (Compose doesn't delete
named volumes), so nothing is lost.

1. Keep your Navidrome running on its own with
   [deploy/navidrome/docker-compose.yml](deploy/navidrome/docker-compose.yml):
   it reuses the existing `pandafm_navidrome-data` volume, so your Navidrome
   users, playlists, favourites and play counts stay exactly as they were.
   Point `MUSIC_DIR` at the same music folder as before.
2. Tell PandaFM where it is, either way:
   - **Keep your old variables** (`PANDAFM_NAVIDROME_URL/USER/PASSWORD`):
     they still work. PandaFM copies them into its database (password
     encrypted) and, while they are set, they manage the server (Settings
     shows this). Set the URL to an address the PandaFM container can reach,
     e.g. `http://<docker-host-ip>:4533`.
   - **Or remove them** and enter the server in Settings › Music server.
3. Update the stack. PandaFM applies its database migrations on start
   (additive only: schema `0008` for 5.3).

## Android app

Build the APK with `scripts/build-android-apk.sh` (see
[docs/android.md](docs/android.md)), install it, and enter your PandaFM
address. If the server can't be reached, the app says so, retries on its own,
lets you change the address, and keeps playing your downloads.

## Using PandaFM

On a computer, the sidebar has Home, Search, Library, Favorites and your
playlists, and the player bar along the bottom has artwork, favorite,
previous / play / next, progress and volume. On a phone (or the Walkman),
Home, Search and Library sit along the bottom with a mini player just above;
tap it for Now Playing.

- **Home**: quick access, Recently added, Favorite songs, your playlists
  and a random selection. *Recently played* appears only when Navidrome has
  play history (PandaFM doesn't report plays yet).
- **Search**: results grouped into Songs, Artists and Albums.
- **Library**: Albums (recently added, A–Z, random), Artists, Songs (all,
  in Navidrome's order, or random) and Playlists.
- **Favorites**: tap a heart on any song, album or artist. Favorites are
  Navidrome's "starred" items, so other Subsonic apps see them too.
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

PandaFM works behind your proxy with one upstream (port 8085). For smooth
audio, turn off response buffering so songs stream as they arrive and
seeking starts quickly:

```nginx
location / {
    proxy_pass http://<ubuntu-server-ip>:8085;
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

## Panda Radio and listening history (Stage 3)

PandaFM now remembers how you listen (plays, songs you finish, early and
late skips, pauses and seeks) in its own PostgreSQL database, and uses
that, plus your Navidrome favorites, for **Panda Radio**:

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

To deploy: point your stack at the branch (or `main` after
merging) and **Pull and redeploy**. Do **not** tick anything that removes
volumes. Then check:

```bash
docker logs pandafm-api 2>&1 | grep "schema is at revision"   # → 0006 (5.2)
docker exec pandafm-api python -m app.migrate check           # database: 0006, code expects: 0006
```

About 20 seconds after start-up, PandaFM copies Navidrome's song list into
its cache (and again after each Navidrome rescan, or every 6 hours).
Starting Panda Radio before that simply waits for the first copy. You can
also run it from `/stats`, or with `curl -X POST http://<server>:8085/api/library/sync`.

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

Secrets belong in your stack's environment variables and must not be committed.

## Android app and offline downloads (Stage 4)

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

Server side, Stage 4 adds:

- migration `0002` (additive): audio facts on cached tracks and a
  `conversions` table;
- ffmpeg in the API image, used only to convert copies for downloads;
- a `pandafm-cache` volume for converted copies (`PANDAFM_CACHE_MAX_GB`,
  default 20; safe to delete, copies are remade on demand);
- CORS for the app's WebView origin (`https://localhost`).

After redeploying, `docker logs pandafm-api 2>&1 | grep "schema is at revision"`
should show the latest revision (`0004` after Stage 4.3). Quality badges appear once the next library sync (within
a minute of start-up) has stored the new audio facts.

## Personalisation and Autoplay (Stage 4.1)

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
same Stage 3 engine; repeat protection always applies. Migration `0003`
(additive) adds `radio_presets`, `users.preferences` and preset snapshots
on radio sessions.

**Autoplay** (Settings › Playback, per device, on by default): when a song,
album, artist, playlist or other finite queue ends naturally, PandaFM
continues with Panda Radio seeded from it, in the same queue. Repeat, songs
you queued, End Radio, and being offline all keep the normal ending.

## Radio coherence and My Stations (Stage 4.3)

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
This stage also fixes a Stage 3 bug: a skip used to make a session forget
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

## Panda Mix

Play a playlist continuously with **Panda DJ** blending each song into the
next: Auto, Gentle, Flow or Energetic, with transitions chosen from tempo,
key, loudness and the songs' intros and outros (and conservative when Panda
isn't sure). PandaFM analyses only the songs a Panda Mix is about to play, not
your whole library. Adjust any transition, preview it and save it for that
playlist. See **[docs/panda-mix.md](docs/panda-mix.md)**.

## PandaFM 5.0: sign-in and remote access

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

## Library explorer (Stage 4.5)

Everything here comes from **your own Navidrome library and PandaFM's
listening history**; no external recommendation, metadata or catalogue
service is involved.

- **Genres** (Library › Genres): every genre in your library, once. Spellings
  like "Pop-Punk", "pop punk" and "Pop Punk" are one genre (the Stage 4.3
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
