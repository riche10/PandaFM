package app.pandafm.client;

/**
 * 5.4.2: what to do about a failed stream, by its actual HTTP status. Pure and table-tested.
 *
 * 401        refresh the PandaFM access token once and retry; a second 401 is terminal
 * 403        terminal (no retry)
 * 404 / 410  the song is unavailable: no network retries (the queue may skip it)
 * 416        one fresh load, then terminal
 * 429        honour Retry-After (1-30 s), at most 4 times
 * 500-504    transient (sleeping NAS disks, upstream trouble): 2, 5, 10, 20 s (or longer if
 *            Retry-After asks), then terminal; navidrome_auth and music_server_not_configured
 *            are terminal at once (retrying can't fix credentials or configuration)
 * other 4xx  terminal
 * no status  network errors keep the 1, 3, 8 s retries
 * Only 401 ever touches authentication.
 */
final class StreamRecovery {
    enum Kind { RETRY, FRESH_LOAD, UNAVAILABLE, FATAL }

    static final long[] TRANSIENT_MS = {2_000, 5_000, 10_000, 20_000};
    static final long[] NETWORK_MS = {1_000, 3_000, 8_000};
    static final int RATE_LIMIT_TRIES = 4;
    static final String SIGNED_OUT = "auth"; // EngineCore picks the right sign-in message

    static final class Decision {
        final Kind kind;
        final long delayMs;
        final boolean refreshAuth;
        final String message;

        private Decision(Kind kind, long delayMs, boolean refreshAuth, String message) {
            this.kind = kind;
            this.delayMs = delayMs;
            this.refreshAuth = refreshAuth;
            this.message = message;
        }

        static Decision retry(long ms, boolean refreshAuth) { return new Decision(Kind.RETRY, ms, refreshAuth, null); }
        static Decision fresh() { return new Decision(Kind.FRESH_LOAD, 0, false, null); }
        static Decision unavailable(String m) { return new Decision(Kind.UNAVAILABLE, 0, false, m); }
        static Decision fatal(String m) { return new Decision(Kind.FATAL, 0, false, m); }
    }

    private StreamRecovery() {}

    static Decision decide(int mediaCode, HttpFailure http, int attempts, boolean authRetried, boolean freshTried) {
        if (http != null) {
            int s = http.status;
            if (s == 401) return authRetried ? Decision.fatal(SIGNED_OUT) : Decision.retry(500, true);
            if (s == 403) return Decision.fatal("Your PandaFM server refused this song.");
            if (s == 404 || s == 410) return Decision.unavailable("This song is no longer available from your music server.");
            if (s == 416) return freshTried ? Decision.fatal("PandaFM couldn’t resume this song.") : Decision.fresh();
            if (s == 429) {
                if (attempts >= RATE_LIMIT_TRIES) return Decision.fatal("Your PandaFM server is busy. Try again in a moment.");
                long ms = http.retryAfterS == null ? 5_000 : http.retryAfterS * 1000L;
                return Decision.retry(Math.max(1_000, Math.min(30_000, ms)), false);
            }
            if (s >= 500 && s <= 599) {
                if ("navidrome_auth".equals(http.pandaCode)) {
                    return Decision.fatal("PandaFM can’t sign in to your music server. The owner can fix it in Settings › Music server.");
                }
                if ("music_server_not_configured".equals(http.pandaCode)) return Decision.fatal("PandaFM isn’t connected to a music server yet.");
                if (s == 500 || s == 502 || s == 503 || s == 504) {
                    if (attempts >= TRANSIENT_MS.length) return Decision.fatal("Your music server isn’t responding. Try again in a moment.");
                    long hint = http.retryAfterS == null ? 0 : Math.min(30_000, http.retryAfterS * 1000L);
                    return Decision.retry(Math.max(TRANSIENT_MS[attempts], hint), false);
                }
                return Decision.fatal("Your music server couldn’t play this song (HTTP " + s + ").");
            }
            if (s >= 400) return Decision.fatal("PandaFM couldn’t play this song (HTTP " + s + ").");
        }
        boolean network = mediaCode == EngineCore.IO_UNSPECIFIED || mediaCode == EngineCore.IO_NETWORK_CONNECTION_FAILED
            || mediaCode == EngineCore.IO_NETWORK_CONNECTION_TIMEOUT || mediaCode == EngineCore.TIMEOUT
            || mediaCode == EngineCore.IO_BAD_HTTP_STATUS; // a status Media3 didn't tell us: treated as transient, never as auth
        if (network && attempts < NETWORK_MS.length) return Decision.retry(NETWORK_MS[attempts], false);
        return Decision.fatal(null);
    }

    /** "attempt 2 / 5" counts the first request too. */
    static int maxAttempts(HttpFailure http) {
        if (http == null) return NETWORK_MS.length + 1;
        if (http.status == 429) return RATE_LIMIT_TRIES + 1;
        return TRANSIENT_MS.length + 1;
    }
}
