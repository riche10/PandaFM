FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# ffmpeg converts songs for portable downloads (Stage 4). Library files are
# read through Navidrome and never modified.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first so code changes don't reinstall them.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

# Both writable folders belong to the runtime user. A new named volume mounted on either
# starts with this folder's ownership, so a fresh deployment can create
# /config/installation.key without any host-side chown (5.4 fix; 5.3 forgot /config).
RUN useradd --system --uid 10001 --no-create-home pandafm \
    && mkdir -p /cache /config && chown pandafm:pandafm /cache /config && chmod 0700 /config
VOLUME ["/cache", "/config"]
USER pandafm

EXPOSE 8000

# Bring the database schema up to date (safe to repeat; see app/migrate.py),
# then serve. The web container's Nginx is the only client, so trust its
# X-Forwarded-* headers.
CMD ["sh", "-c", "python -m app.migrate upgrade && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'"]
