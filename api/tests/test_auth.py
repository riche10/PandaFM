"""Owner passwords, login throttling and client addresses (no database)."""

from app.auth.limits import BASE_LOCK_S, LoginLimiter, client_ip, is_https, parse_networks
from app.auth.passwords import hash_password, verify_password, weakness

TRUSTED = parse_networks(["127.0.0.1/32", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"])


def test_passwords_are_argon2id_hashes_never_plain_text():
    stored = hash_password("correct horse battery")
    assert stored.startswith("$argon2id$") and "correct horse" not in stored
    assert verify_password(stored, "correct horse battery")
    assert not verify_password(stored, "wrong horse battery")
    assert not verify_password(None, "anything")  # unknown user: same work, same answer
    assert weakness("short") and weakness("x" * 300) and weakness("long enough pass") is None


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_login_limiter_cools_down_and_escalates():
    clock = Clock()
    limiter = LoginLimiter(clock)
    for _ in range(5):
        assert limiter.retry_after("1.2.3.4", "owner") == 0
        limiter.failure("1.2.3.4", "owner")
    assert limiter.retry_after("1.2.3.4", "owner") == 0  # five free mistakes
    limiter.failure("1.2.3.4", "owner")
    first = limiter.retry_after("1.2.3.4", "Owner ")  # same account, any spelling
    assert BASE_LOCK_S <= first <= BASE_LOCK_S + 1
    assert limiter.retry_after("9.9.9.9", "owner") > 0  # the account is protected from everywhere
    clock.t += first
    limiter.failure("1.2.3.4", "owner")
    assert limiter.retry_after("1.2.3.4", "owner") >= 2 * BASE_LOCK_S  # escalates
    clock.t += 16 * 60
    assert limiter.retry_after("1.2.3.4", "owner") == 0  # and forgets


def test_one_address_spraying_usernames_is_throttled():
    limiter = LoginLimiter(Clock())
    for i in range(31):
        limiter.failure("5.6.7.8", f"user{i}")
    assert limiter.retry_after("5.6.7.8", "someone-new") > 0


def test_success_clears_the_account_counter():
    limiter = LoginLimiter(Clock())
    for _ in range(6):
        limiter.failure("1.2.3.4", "owner")
    limiter.success("1.2.3.4", "owner")
    assert limiter.retry_after("2.2.2.2", "owner") == 0


def test_client_ip_only_believes_trusted_proxies():
    # Direct, untrusted caller: a forged X-Forwarded-For is ignored.
    assert client_ip("203.0.113.9", "1.1.1.1", TRUSTED) == "203.0.113.9"
    # Through pandafm-web (172.18.0.3) and the LAN proxy (192.168.1.10): the real client.
    assert client_ip("172.18.0.3", "198.51.100.7, 192.168.1.10", TRUSTED) == "198.51.100.7"
    # A client prepending its own fake hop gains nothing: the rightmost untrusted address wins.
    assert client_ip("172.18.0.3", "6.6.6.6, 198.51.100.7, 192.168.1.10", TRUSTED) == "198.51.100.7"
    assert client_ip("172.18.0.3", "192.168.1.20", TRUSTED) == "192.168.1.20"  # LAN-only
    assert client_ip(None, None, TRUSTED) == "unknown"


def test_https_detection_trusts_only_proxies():
    assert is_https("https", None, "203.0.113.9", TRUSTED)
    assert is_https("http", "https", "172.18.0.3", TRUSTED)
    assert not is_https("http", "https", "203.0.113.9", TRUSTED)  # a client can't claim it
    assert not is_https("http", None, "172.18.0.3", TRUSTED)
