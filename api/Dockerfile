FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first so code changes don't reinstall them.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

RUN useradd --system --uid 10001 --no-create-home pandafm
USER pandafm

EXPOSE 8000

# Bring the database schema up to date (safe to repeat; see app/migrate.py),
# then serve. The web container's Nginx is the only client, so trust its
# X-Forwarded-* headers.
CMD ["sh", "-c", "python -m app.migrate upgrade && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'"]
