"""A stable handle on PandaFM's music server connection (5.3).

The syncer, streaming, conversions and Panda Mix keep this object; the actual
NavidromeClient behind it is set when the owner connects (or changes) the
music server, without restarting anything. Unconfigured, every call raises
NavidromeNotConfigured, which the API turns into a clear 503.
"""

from app.navidrome.client import NavidromeClient, NavidromeUnavailable


class NavidromeNotConfigured(NavidromeUnavailable):
    def __init__(self) -> None:
        super().__init__("PandaFM isn’t connected to a music server yet.")


class NavidromeHandle:
    def __init__(self, client: NavidromeClient | None = None) -> None:
        self._client = client

    @property
    def configured(self) -> bool:
        return self._client is not None

    def swap(self, client: NavidromeClient | None) -> NavidromeClient | None:
        """Use a new client from now on; returns the old one (for the caller to close)."""
        old, self._client = self._client, client
        return old

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    def __getattr__(self, name: str):
        client = self.__dict__.get("_client")
        if client is None:
            raise NavidromeNotConfigured()
        return getattr(client, name)
