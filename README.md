# PandaFM

A self-hosted radio for your own music library. Navidrome is the media
server (scanning, metadata, artwork, streaming). PandaFM is everything on
top: listening history, preferences, Panda Radio and the phone-first UI.

```
phone ──► caddy ─┬─ /api/* ──► pandafm-api ──┬──► pandafm-db (PostgreSQL)
                 │                           └──► navidrome ──► /music (NAS, read-only)
                 └─ /*     ──► pandafm-web (static React build)
```

| Folder   | What lives there                                        |
|----------|---------------------------------------------------------|
| `api/`   | FastAPI backend (Python 3.12)                           |
| `web/`   | React + TypeScript + Vite frontend                      |
| `caddy/` | Edge proxy config                                       |
| `data/`  | Navidrome's data folder (git-ignored, created by you)   |

## First run

You need Docker with the Compose plugin, and your NAS music share mounted
on the Ubuntu host (for example at `/mnt/nas/music`).

1. Configure:

   ```bash
   cp .env.example .env
   nano .env            # fill in every empty value; see comments in the file
   mkdir -p data/navidrome
   ```

   Create `data/navidrome` yourself so it belongs to your user. If Docker
   creates it, it belongs to root and Navidrome can't write to it.

2. Start Navidrome on its own and create its first account, using the
   **same** username and password you put in `NAVIDROME_USER` /
   `NAVIDROME_PASSWORD`:

   ```bash
   docker compose up -d navidrome
   # open http://<server-ip>:4533 and create the account
   ```

   Wait until your albums appear in Navidrome's UI. A large library can
   take a while on the first scan.

3. Start everything:

   ```bash
   docker compose up -d --build
   docker compose ps     # pandafm-db and pandafm-api should become "healthy"
   ```

4. Check the wiring:

   ```bash
   curl -s http://localhost/api/health | python3 -m json.tool
   ```

   `"status": "ok"` means the API reached both PostgreSQL and Navidrome.
   Then open `http://<server-ip>/` on your phone. You should see the
   PandaFM connection check with four green rows.

## Running the API tests

No local Python needed:

```bash
docker run --rm -v "$PWD/api:/app" -w /app python:3.12-slim \
  sh -c "pip install -q -r requirements-dev.txt && pytest -q"
```

## Protect your library from a missing NAS mount

If Docker starts before the NAS share is mounted, Navidrome sees an empty
`/music` folder and marks your whole library as missing. Make Docker wait
for the mount:

```bash
sudo systemctl edit docker.service
```

Add, adjusting the path to your mount point:

```ini
[Unit]
RequiresMountsFor=/mnt/nas/music
```

Then `sudo systemctl daemon-reload`. Mount the share through `/etc/fstab`
(NFS or CIFS) so systemd knows about it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `docker compose` says a variable is required | An empty value in `.env`. |
| Navidrome shows no music | `PUID`/`PGID` can't read `MUSIC_DIR`. Check with `sudo -u '#1000' ls /mnt/nas/music`. |
| Navidrome restarts with permission errors | `data/navidrome` is owned by root. `sudo chown -R $(id -u):$(id -g) data/navidrome`. |
| Health says Navidrome rejected the login | `.env` credentials don't match a Navidrome account. Fix `.env`, then `docker compose up -d pandafm-api`. |
| Port 80 is already in use | Set `PANDAFM_HTTP_PORT` (for example `8080`) and open `http://<server-ip>:8080`. |
| Anything else | `docker compose logs -f pandafm-api navidrome caddy` |
