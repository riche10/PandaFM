"""Application settings, read from PANDAFM_* environment variables.

Docker Compose maps values from the repository's .env file into these
variables (see docker-compose.yml). This module never reads .env itself,
so there is exactly one place where configuration enters the container.
"""

from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PANDAFM_", extra="ignore")

    # ── Database ──
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "pandafm"
    db_user: str = "pandafm"
    db_password: SecretStr = SecretStr("")

    # ── Navidrome ── (no defaults for credentials: startup fails loudly
    # if they are missing rather than limping along unauthenticated)
    navidrome_url: str = "http://localhost:4533"
    navidrome_user: str
    navidrome_password: SecretStr
    navidrome_timeout_seconds: float = 10.0

    log_level: str = "info"

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
