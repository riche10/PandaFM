# PandaFM

PandaFM is a self-hosted Spotify-like radio for your own music library.

The entire application is designed to deploy as **one Portainer stack**:

```
UGREEN music library
        │
        ▼
pandafm-navidrome
        │
        ▼
pandafm-api ─── pandafm-db
        │
pandafm-web
        │
pandafm-caddy
        │
        ▼
Phone / Walkman
```

## Services in the stack

| Service | Purpose |
|---|---|
| `pandafm-navidrome` | Scans, indexes and streams the music library |
| `pandafm-db` | PostgreSQL listening history / preferences |
| `pandafm-api` | FastAPI backend and future Panda Radio engine |
| `pandafm-web` | React frontend |
| `pandafm-caddy` | Single HTTP entry point for PandaFM |

Navidrome stores its database/cache in a Docker named volume. Your music is
never copied into the stack: the Ubuntu host mount
`/mnt/ugreen/media/Music` is mounted into Navidrome **read-only**.

## Deploy with Portainer

In Portainer:

1. Open **Stacks → Add stack**.
2. Choose **Repository**.
3. Repository URL: `https://github.com/riche10/PandaFM.git`
4. Repository reference: `refs/heads/main`
5. Compose path: `docker-compose.yml`
6. Because the repo is private, provide GitHub repository credentials/token to Portainer.
7. Add the environment variables listed below.
8. Deploy the stack.

### Required environment variables

```text
MUSIC_DIR=/mnt/ugreen/media/Music
PUID=1000
PGID=1000

NAVIDROME_PORT=4533
NAVIDROME_USER=<choose a Navidrome username>
NAVIDROME_PASSWORD=<choose a password>

POSTGRES_DB=pandafm
POSTGRES_USER=pandafm
POSTGRES_PASSWORD=<strong random password>

PANDAFM_HTTP_PORT=8085
PANDAFM_LOG_LEVEL=info
```

The Compose file supplies sensible defaults for the non-secret values.

## First Navidrome startup

After deploying, open:

```text
http://<ubuntu-server-ip>:4533
```

Create the first Navidrome account using the **same username and password**
you entered as `NAVIDROME_USER` and `NAVIDROME_PASSWORD` in Portainer.

Once Navidrome has scanned the library, PandaFM can authenticate against its
Subsonic API.

## PandaFM

Open:

```text
http://<ubuntu-server-ip>:8085
```

Stage 1 currently shows a connection-check page for:

- PandaFM Web
- PandaFM API
- PostgreSQL
- Navidrome

Later stages add library browsing, playback, listening events, Panda Radio,
session learning and PWA/media controls.

## Repository structure

```text
PandaFM/
├── docker-compose.yml
├── .env.example
├── api/
├── web/
└── caddy/
```

Secrets should stay in Portainer environment variables and must never be
committed to the repository.
