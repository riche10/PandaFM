"""Application settings, read from PANDAFM_* environment variables.

Docker Compose maps values from the repository's .env file into these
variables (see docker-compose.yml). This module never reads .env itself,
so there is exactly one place where configuration enters the container.
"""

from typing import Annotated
from functools import lru_cache

from pydantic import field_validator, SecretStr
from pydantic_settings import NoDecode, BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PANDAFM_", extra="ignore", env_ignore_empty=True)  # unset optional variables arrive as ""

    # ── Database ──
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "pandafm"
    db_user: str = "pandafm"
    db_password: SecretStr = SecretStr("")

    # ── Navidrome ── (no defaults for credentials: startup fails loudly
    # if they are missing rather than limping along unauthenticated)
    # Legacy (≤5.2) Navidrome settings: only used once, to import an existing setup when PandaFM
    # has no saved music server yet. From 5.3 the owner connects the music server in the app.
    navidrome_url: str | None = None
    navidrome_user: str | None = None
    navidrome_password: SecretStr | None = None
    navidrome_timeout_seconds: float = 10.0

    log_level: str = "info"
    # Keep the track cache in step with Navidrome in the background.
    background_sync: bool = True

    # Downloads (Stage 4): where converted copies are cached, and how big that may grow.
    cache_dir: str = "/cache"
    cache_max_gb: float = 20.0
    conversion_concurrency: int = 1
    # Origins allowed to call the API from another origin: the Android app's WebView.
    # Browsers using PandaFM on its own address don't need this.
    cors_origins: list[str] = ["https://localhost", "http://localhost", "capacitor://localhost"]

    # 5.0 security. The setup token lets the administrator (and only them) create the
    # owner account once; it stops working as soon as an owner exists.
    setup_token: str | None = None
    # Proxies whose X-Forwarded-For / X-Forwarded-Proto are believed (pandafm-web and
    # your LAN reverse proxy). Private ranges by default: the API itself must not be public.
    trusted_proxies: Annotated[list[str], NoDecode] = ["127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def _proxy_list(cls, value):
        """Accept a JSON list or the friendlier comma-separated form (10.0.0.0/8, 192.168.1.10/32)."""
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                import json

                return json.loads(text)
            return [part.strip() for part in text.split(",") if part.strip()]
        return value
    # 5.3: PandaFM's own persistent configuration (its installation key lives here).
    config_dir: str = "/config"
    # Optional: supply the installation key yourself (32 bytes, base64 or hex) instead of the file.
    config_key: SecretStr | None = None

    # Interactive API docs: off by default; when on, owner-only.
    api_docs: bool = False

    # 5.2 Panda Mix: analysis only for tracks a Panda Mix needs, never the whole library.
    mix_enabled: bool = True
    mix_analysis_workers: int = 1  # concurrent analyses (each mostly one ffmpeg + a little numpy), niced
    mix_lookahead: int = 3  # tracks after the current one to prepare

    @property
    def database_url(self) -> URL:
        # URL.create escapes special characters in the password, which a
        # hand-built "postgresql://user:pass@host" string would not.
        # psycopg 3 serves both the async app and Alembic's sync
        # migrations (Stage 3), so the project needs only one driver.
        return URL.create(
            drivername="postgresql+psycopg",
            username=self.db_user,
            password=self.db_password.get_secret_value(),
            host=self.db_host,
            port=self.db_port,
            database=self.db_name,
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from the environment
