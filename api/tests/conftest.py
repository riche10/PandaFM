import pytest


@pytest.fixture
def anyio_backend() -> str:
    # Async tests run on asyncio, the same loop uvicorn uses.
    return "asyncio"
