package app.pandafm.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 5.4.2: the response-aware recovery table. */
public class StreamRecoveryTest {
    static StreamRecovery.Decision d(int status, Integer retryAfter, String code, int attempts) {
        return StreamRecovery.decide(EngineCore.IO_BAD_HTTP_STATUS, new HttpFailure(status, retryAfter, code), attempts, false, false);
    }

    @Test
    public void onlyA401TouchesAuthentication() {
        assertTrue(d(401, null, null, 0).refreshAuth);
        for (int s : new int[] {403, 404, 410, 416, 429, 500, 502, 503, 504}) assertFalse(String.valueOf(s), d(s, null, null, 0).refreshAuth);
        assertEquals(StreamRecovery.Kind.FATAL, StreamRecovery.decide(EngineCore.IO_BAD_HTTP_STATUS, new HttpFailure(401, null, null), 1, true, false).kind);
    }

    @Test
    public void eachStatusClassHasItsOwnBehaviour() {
        assertEquals(StreamRecovery.Kind.FATAL, d(403, null, null, 0).kind);
        assertEquals(StreamRecovery.Kind.UNAVAILABLE, d(404, null, "not_found", 0).kind);
        assertEquals(StreamRecovery.Kind.UNAVAILABLE, d(410, null, null, 0).kind);
        assertEquals(StreamRecovery.Kind.FRESH_LOAD, d(416, null, null, 0).kind);
        assertEquals(StreamRecovery.Kind.FATAL, StreamRecovery.decide(EngineCore.IO_BAD_HTTP_STATUS, new HttpFailure(416, null, null), 0, false, true).kind);
        assertEquals(StreamRecovery.Kind.FATAL, d(400, null, null, 0).kind);
        assertEquals(StreamRecovery.Kind.FATAL, d(503, null, "navidrome_auth", 0).kind);
        assertEquals(StreamRecovery.Kind.FATAL, d(503, null, "music_server_not_configured", 0).kind);
    }

    @Test
    public void transientServerErrorsToleratATenOfSecondsWake() {
        long total = 0;
        for (int s : new int[] {500, 502, 503, 504}) {
            for (int k = 0; k < 4; k++) assertEquals(StreamRecovery.Kind.RETRY, d(s, null, null, k).kind);
            assertEquals(StreamRecovery.Kind.FATAL, d(s, null, null, 4).kind); // finite
        }
        for (int k = 0; k < 4; k++) total += d(503, null, null, k).delayMs;
        assertEquals(37_000, total); // 2 + 5 + 10 + 20 s between tries, besides each request's own wait (up to 30 s on the server)
        assertEquals(30_000, d(503, 120, null, 0).delayMs); // Retry-After is honoured, within reason
    }

    @Test
    public void rateLimitsFollowRetryAfterAndStop() {
        assertEquals(7_000, d(429, 7, null, 0).delayMs);
        assertEquals(5_000, d(429, null, null, 0).delayMs);
        assertEquals(1_000, d(429, 0, null, 0).delayMs);
        assertEquals(StreamRecovery.Kind.FATAL, d(429, 7, null, 4).kind);
    }

    @Test
    public void plainNetworkErrorsKeepTheirShortRetries() {
        StreamRecovery.Decision n = StreamRecovery.decide(EngineCore.IO_NETWORK_CONNECTION_FAILED, null, 0, false, false);
        assertEquals(StreamRecovery.Kind.RETRY, n.kind);
        assertEquals(1_000, n.delayMs);
        assertFalse(n.refreshAuth);
        assertEquals(StreamRecovery.Kind.FATAL, StreamRecovery.decide(EngineCore.IO_NETWORK_CONNECTION_FAILED, null, 3, false, false).kind);
    }
}
