# Upgrading to PandaFM 5.3 (standalone)

Up to 5.2, PandaFM's Docker stack also started Navidrome. From 5.3, PandaFM is
its own application: it connects to a Navidrome (or other OpenSubsonic) server
that you run separately. Nothing of yours is deleted by upgrading: your owner
account, devices, listening history, favourites, playlists, Radio Styles,
Stations, Panda Mix data, downloads and the Android sign-in all stay.

## If you used the bundled Navidrome

Your Navidrome data lives in the Docker volume `pandafm_navidrome-data`
(your music folder was only mounted read-only). Keep using it:

1. **Before** redeploying PandaFM 5.3, start Navidrome as its own stack with
   that volume: `examples/navidrome-compose.yml` with `external: true` and
   `name: pandafm_navidrome-data` uncommented, and `MUSIC_DIR` set to the same
   music folder. Navidrome keeps its users, play data and scan, so there's no
   rescan.
2. Redeploy PandaFM 5.3 (`docker compose up -d --build`). The old
   `navidrome-init` and `navidrome` services are no longer part of it.
3. Tell PandaFM where Navidrome is, either way:
   - **In the app** (simplest): sign in, and PandaFM asks for the music
     server's address, username and password; or Settings › Music server.
   - **Once, from the environment**: set `PANDAFM_NAVIDROME_URL` (for example
     `http://192.168.1.20:4533`; the old `http://navidrome:4533` only works if
     both stacks share a Docker network) and keep `NAVIDROME_USER` /
     `NAVIDROME_PASSWORD`. On start, PandaFM imports them (password encrypted)
     because nothing is saved yet. After that the saved settings win; you can
     remove the variables.

## What PandaFM now stores

The music server's address and username are stored in PostgreSQL; its password
only as AES-256-GCM ciphertext. The key is in the new `pandafm-config` volume
(`/config/installation.key`, created on first start), or `PANDAFM_CONFIG_KEY`.
Back up `pandafm-db` and `pandafm-config` together: the database alone doesn't
reveal the password, and without the key you'd simply enter it again.

## Owner setup without a token

New in 5.3: on a fresh install the owner account can be created without
`PANDAFM_SETUP_TOKEN` when you open PandaFM from your home network (LAN or
VPN). From the internet the token is still required. Existing installations
already have an owner, so nothing changes for you.

## Schema

The database moves to revision `0008`. Both 5.3 migrations are additive:
`0007` stores the external music-server configuration and `0008` stores
persistent Panda Mix playlist state. Migrations run automatically when the API
starts.
