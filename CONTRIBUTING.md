# Contributing and development

PandaFM has three parts: a Python API (`api/`, FastAPI + PostgreSQL), a web
app (`web/`, React + TypeScript), and the Android app (`web/android/`,
Capacitor with a native Media3 playback service).

## Tests

```bash
# API (Navidrome is faked; database tests skip without a database)
cd api && pip install -r requirements.txt -r requirements-dev.txt && pytest -q

# Including database tests, against a throwaway PostgreSQL (never your real one)
PANDAFM_TEST_DATABASE_URL=postgresql+psycopg://user:pass@127.0.0.1:5432/pandafm_test pytest -q

# Web
cd web && npm ci && npm test && npx tsc -b

# Android (JVM unit tests)
cd web/android && ./gradlew testDebugUnitTest
```

## Guidelines

- Keep PandaFM a client of an existing Navidrome/OpenSubsonic server: it never
  modifies the music library or bundles a music server.
- Never log or return secrets (passwords, tokens, the installation key).
- Database changes are additive Alembic migrations that keep existing data.
- Changes that affect playback on Android need a note on what was verified on
  a real device.
