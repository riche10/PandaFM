# PandaFM 5.0 security and remote access

> **Do not expose an older PandaFM build (before 5.0) to the internet.**
> Before 5.0, PandaFM had no sign-in: anyone who could reach it could browse
> and stream your whole library. Upgrade first, create the owner account, then
> publish it through HTTPS.

## How sign-in works

PandaFM has one **owner** account (more people can come later without
changing the API).

- **First-time setup.** Set `PANDAFM_SETUP_TOKEN` on the API container (any
  long random value, e.g. `openssl rand -hex 24`). The first sign-in screen
  asks for it; with it you choose the owner's username and password. Without
  the token nobody can set PandaFM up, and once the owner exists setup is
  closed for good: the token no longer does anything. Your existing listening
  history, stations, presets and favourites become the owner's.
- **Passwords** are stored only as Argon2id hashes. PandaFM never uses or
  shows your Navidrome password.
- **Browsers** get an `HttpOnly`, `SameSite=Lax` session cookie (`Secure`
  over HTTPS) that page scripts can't read. Changes (POST/PUT/PATCH/DELETE)
  must also carry a CSRF token. Sessions end after 30 days without use (180
  days at most).
- **The Android app** keeps a refresh token encrypted with a key in the
  Android Keystore and uses 15-minute access tokens, sent as
  `Authorization: Bearer` and only to your PandaFM server. Tokens never go in
  URLs, logs or backups.
- The server stores only SHA-256 hashes of session tokens, so **signing a
  device out takes effect immediately**.
- **Everything needs sign-in** except `/api/health` (which says only whether
  PandaFM works) and `/api/auth/*` (sign-in itself). Interactive API docs are
  off; `PANDAFM_API_DOCS=true` turns them on for the signed-in owner only.
- **Login protection:** repeated wrong passwords lead to growing waits (per
  address and per username), and the error never says whether a username
  exists.

### Devices

Settings › **Account & devices** lists every signed-in browser and app (this
one is marked) with when each was last active. You can sign out one device,
**sign out all other devices**, sign out here, or change your password (which
signs out every other device). A signed-out phone keeps its downloaded music.

## Recommended public setup

```
Internet ──HTTPS :443──▶ your reverse proxy ──http──▶ pandafm-web :8086 ──▶ PandaFM API ──▶ PostgreSQL / Navidrome
```

Only the reverse proxy is public. **Never** publish PostgreSQL, the PandaFM
API container, Navidrome, or port 8086 itself to the internet. A LAN-only
setup (no reverse proxy) keeps working as before, now with sign-in.

### Nginx

```nginx
server {
    listen 80;
    server_name music.example.com;
    return 301 https://$host$request_uri;          # HTTPS only
}

server {
    listen 443 ssl http2;
    server_name music.example.com;
    ssl_certificate     /etc/letsencrypt/live/music.example.com/fullchain.pem;  # a real public certificate
    ssl_certificate_key /etc/letsencrypt/live/music.example.com/privkey.pem;
    # Turn HSTS on only after HTTPS works everywhere you use PandaFM:
    # add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 2m;                         # PandaFM never uploads large bodies

    location / {
        proxy_pass http://192.168.1.20:8086;         # the machine running pandafm-web
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                         # audio streams start and seek promptly
        proxy_request_buffering off;
        proxy_read_timeout 1h;                       # long songs and live transcodes
        # Range requests pass through unchanged by default; don't strip them.
        # No WebSocket settings are needed.
    }
}
```

### Nginx Proxy Manager

- **Details:** scheme `http`, forward host = the PandaFM machine, port `8086`,
  *Block common exploits* on. *WebSockets support* isn't needed.
- **SSL:** request a Let's Encrypt certificate, *Force SSL* and *HTTP/2* on.
  Enable *HSTS* only after HTTPS works from all your devices.
- **Advanced:**
  ```nginx
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 3600;
  ```

### Trusted proxies

PandaFM needs the real client address for login protection, and must know
whether the connection was HTTPS (to mark cookies `Secure`). It believes
`X-Forwarded-For` / `X-Forwarded-Proto` **only from trusted proxies**, reading
the address chain from the right, so a client can't fake its address.

The default trusts private networks (`10/8`, `172.16/12`, `192.168/16`,
loopback), which covers `pandafm-web` and a reverse proxy on your LAN. To be
stricter, list exactly your Docker network and your proxy:

```
PANDAFM_TRUSTED_PROXIES=["172.16.0.0/12","192.168.1.10/32"]
```

Settings › Account & devices shows **Connected through HTTPS** when PandaFM
sees an HTTPS connection; otherwise it reminds you to use one before
listening from outside your home. PandaFM can't configure your router,
firewall or proxy for you.

## Streaming away from home

Settings › Playback › **Streaming quality** (per device; separate from offline
download quality):

| Setting | What streams |
|---|---|
| Auto | App: original files on Wi-Fi, AAC ~256 kbps on mobile data. Browser: original files. |
| Original | The file as it is in your library. |
| High | AAC ~256 kbps. |
| Data Saver | AAC ~128 kbps. |

Smaller copies reuse PandaFM's download conversions and cache
(`PANDAFM_CACHE_MAX_GB`): a song's first play starts at once as a live AAC
stream while a cached copy is made; later plays (and seeking) use that copy.
A file that's already small enough (e.g. a 192 kbps MP3 with High) plays as
it is, and nothing is ever converted to FLAC. Downloaded songs always play
from the device. Browsers that can't decode AAC always get original files.

## Logs

PandaFM logs sign-ins, failed sign-ins (with the client address), devices
signed out, setup and rejected requests, and download or playback failures.
It never logs passwords, session cookies, access or refresh tokens,
`Authorization` headers, or Navidrome's credentials. Android logs use the
tags `PandaFM.Auth` and `PandaFM.Download`.

## Upgrading to 5.0

1. In Portainer, add `PANDAFM_SETUP_TOKEN` to the stack's environment (a long
   random value) and redeploy. The API upgrades the database (schema `0005`,
   nothing is removed).
2. Open PandaFM: it asks to **Set up PandaFM**. Enter the setup token, then
   choose the owner's username and password (at least 10 characters).
3. Install the 5.0 Android app and sign in on each phone or Walkman. Downloaded
   music stays where it is.
4. Only then publish PandaFM through your HTTPS reverse proxy.
