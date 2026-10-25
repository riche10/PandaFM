"""Login abuse protection and the real client address behind trusted proxies."""

import ipaddress
import time
from collections import deque

WINDOW_S = 15 * 60  # failures older than this are forgotten
USER_FREE_FAILURES = 5  # then a cooldown starts...
IP_FREE_FAILURES = 30
BASE_LOCK_S = 30  # ...and doubles with each further failure
MAX_LOCK_S = 15 * 60
MAX_KEYS = 10_000


class LoginLimiter:
    """Per-IP and per-username failure counting with escalating cooldowns (in memory, per API process)."""

    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self._failures: dict[str, deque[float]] = {}
        self._locked_until: dict[str, float] = {}

    @staticmethod
    def _keys(ip: str, username: str) -> list[tuple[str, int]]:
        return [(f"ip:{ip}", IP_FREE_FAILURES), (f"user:{username.strip().lower()}", USER_FREE_FAILURES)]

    def retry_after(self, ip: str, username: str) -> int:
        """Seconds to wait before another attempt may be checked (0: go ahead)."""
        now = self._clock()
        return max([0] + [int(self._locked_until.get(k, 0) - now) + 1 for k, _ in self._keys(ip, username) if self._locked_until.get(k, 0) > now])

    def failure(self, ip: str, username: str) -> None:
        now = self._clock()
        if len(self._failures) > MAX_KEYS:  # bounded memory under a spray of usernames
            self._failures.clear()
        for key, free in self._keys(ip, username):
            q = self._failures.setdefault(key, deque())
            q.append(now)
            while q and now - q[0] > WINDOW_S:
                q.popleft()
            if len(q) > free:
                self._locked_until[key] = now + min(MAX_LOCK_S, BASE_LOCK_S * 2 ** (len(q) - free - 1))

    def success(self, ip: str, username: str) -> None:
        key = f"user:{username.strip().lower()}"
        self._failures.pop(key, None)
        self._locked_until.pop(key, None)


def parse_networks(values: list[str]) -> list[ipaddress._BaseNetwork]:
    return [ipaddress.ip_network(v.strip(), strict=False) for v in values if v.strip()]


def _trusted(addr: str, networks) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in n for n in networks)


def client_ip(peer: str | None, forwarded_for: str | None, trusted) -> str:
    """The client's address. X-Forwarded-For is only believed when it arrives from a trusted
    proxy, and is read right to left: the first address that isn't a trusted proxy is the client
    (anything a client writes into the header itself sits further left and is ignored)."""
    peer = peer or "unknown"
    if not forwarded_for or not _trusted(peer, trusted):
        return peer
    hops = [h.strip() for h in forwarded_for.split(",") if h.strip()]
    for hop in reversed(hops):
        if not _trusted(hop, trusted):
            return hop
    return hops[0] if hops else peer


def is_https(scheme: str, forwarded_proto: str | None, peer: str | None, trusted) -> bool:
    if scheme == "https":
        return True
    return bool(forwarded_proto) and _trusted(peer or "", trusted) and forwarded_proto.split(",")[0].strip().lower() == "https"
