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

## Repository structure

```text
PandaFM/
├── docker-compose.yml
├── .env.example
├── api/
└── web/
    ├── Dockerfile
    └── nginx.conf
```

Secrets belong in Portainer environment variables and must not be committed.
