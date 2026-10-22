# PandaFM

PandaFM is a self-hosted Spotify-like radio for your own music library.

The application is packaged as one Portainer stack without its own public
reverse proxy:

```text
Existing Nginx / Nginx Proxy Manager
                 │
                 ▼
       Ubuntu host :8085
                 │
                 ▼
         pandafm-web (Nginx)
          ├── React files
          └── /api/* ──► pandafm-api
                          ├──► pandafm-db
                          └──► pandafm-navidrome
                                  │
                                  ▼
                         UGREEN music library
```

The small Nginx inside `pandafm-web` is only the application's static-file
server and internal `/api` router. TLS, domains, certificates and public
reverse-proxy duties remain with your existing Nginx installation.

## Containers

| Container | Purpose |
|---|---|
| `pandafm-navidrome` | Scans, indexes and streams the music library |
| `pandafm-db` | PostgreSQL listening history and preferences |
| `pandafm-api` | FastAPI backend and future Panda Radio engine |
| `pandafm-web` | React frontend plus internal /api routing |

Navidrome stores its database/cache in a Docker named volume. The actual
music stays on the UGREEN mount and is passed to Navidrome read-only.

## Deploy from Portainer

Use:

```text
Repository:
https://github.com/riche10/PandaFM.git

Reference:
refs/heads/main

Compose path:
docker-compose.yml
```

Because the repository is private, Portainer needs GitHub repository
credentials/token.

Add these environment variables:

```text
MUSIC_DIR=/mnt/ugreen/media/Music
PUID=1000
PGID=1000

NAVIDROME_PORT=4533
NAVIDROME_USER=<choose username>
NAVIDROME_PASSWORD=<choose password>

POSTGRES_DB=pandafm
POSTGRES_USER=pandafm
POSTGRES_PASSWORD=<strong random password>

PANDAFM_WEB_PORT=8085
PANDAFM_LOG_LEVEL=info
```

Then deploy the stack.

## First Navidrome setup

Open:

```text
http://<ubuntu-server-ip>:4533
```

Create the first Navidrome account with the same username/password configured
as `NAVIDROME_USER` and `NAVIDROME_PASSWORD` in Portainer.

## PandaFM before adding your external proxy

The app itself is available at:

```text
http://<ubuntu-server-ip>:8085
```

The frontend container automatically forwards `/api/*` to the private
`pandafm-api` container, so PandaFM works on that one port.

## Existing Nginx / Nginx Proxy Manager

Your public reverse proxy only needs one upstream:

```text
http://<ubuntu-server-ip>:8085
```

For example, a hostname such as `pandafm.example.com` can point entirely to
port 8085. Do not create a separate public route to FastAPI; the web container
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
- **Search**: results grouped into Songs, Artists and Albums.
- **Library**: Albums (recently added, A–Z, random), Artists, Songs (all,
  in Navidrome's order, or random) and Playlists.
- **Favorites**: tap a heart on any song, album or artist. Favorites are
  Navidrome's "starred" items, so other Subsonic apps see them too.
- **Playlists**: create from the sidebar or Library, add songs from any
  song's ⋯ menu (or a whole album from its ⋯ menu), remove, rename or delete
  from the playlist page. They are stored in Navidrome.
- Space plays and pauses. Playback keeps going while you move around.

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

## Running the tests

```bash
# API (no Navidrome or database needed; Navidrome is faked)
docker run --rm -v "$PWD/api:/app" -w /app python:3.12-slim \
  sh -c "pip install -q -r requirements-dev.txt && pytest -q"

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
│       ├── routers/     # health, library, media, favorites, playlists
│       ├── schemas/     # PandaFM's library models
│       └── errors.py    # user-safe error responses
└── web/
    ├── Dockerfile
    ├── nginx.conf
    └── src/
        ├── api/         # typed calls to /api
        ├── player/      # audio engine (two decks), player store
        ├── library/     # favorites, playlists and toast state
        ├── shell/       # sidebar, bottom nav, player bar, mini player
        ├── components/  # cards, track lists, menus, dialogs
        ├── dialogs/     # new / rename / delete playlist, add to playlist
        └── views/       # Home, Search, Library, Favorites, Playlist,
                         # Album, Artist, Now Playing, Status
```

Secrets belong in Portainer environment variables and must not be committed.
