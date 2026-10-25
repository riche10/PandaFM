package app.pandafm.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** The device sign-in used by the WebView, Media3 streaming and downloads (5.0). */
public class AuthCoreTest {
    static final String SERVER = "https://music.example.com";

    static final class FakeVault implements AuthCore.Vault {
        final Map<String, String> data = new HashMap<>();
        public String get(String k) { return data.get(k); }
        public void put(String k, String v) { data.put(k, v); }
        public void clear() { data.clear(); }
    }

    static final class FakeHttp implements AuthCore.Http {
        final List<String> calls = new ArrayList<>();
        int refreshCode = 200;
        boolean offline = false;
        int issued = 0;

        public AuthCore.Response post(String url, String body, String bearer) throws IOException {
            calls.add(url.replace(SERVER, "") + (bearer != null ? " bearer" : ""));
            if (offline) throw new IOException("unreachable");
            if (url.endsWith("/login") || url.endsWith("/setup")) {
                if (body.contains("\"password\":\"wrong\"")) return new AuthCore.Response(401, "{\"error\":{\"code\":\"invalid_login\",\"message\":\"That username and password don’t match.\"}}");
                return pair();
            }
            if (url.endsWith("/refresh")) return refreshCode == 200 ? pair() : new AuthCore.Response(refreshCode, "{\"error\":{\"code\":\"session_expired\"}}");
            return new AuthCore.Response(204, "");
        }

        AuthCore.Response pair() {
            issued++;
            return new AuthCore.Response(200, "{\"username\":\"panda\",\"session_id\":\"s\",\"access_token\":\"access-" + issued
                + "\",\"access_expires_in\":900,\"refresh_token\":\"refresh-" + issued + "\"}");
        }
    }

    final long[] now = {1_000_000};
    final FakeVault vault = new FakeVault();
    final FakeHttp http = new FakeHttp();
    final AuthCore auth = new AuthCore(http, vault, () -> now[0]);

    @Test
    public void signInKeepsOnlyTheRefreshTokenAndTheServer() throws Exception {
        assertEquals("panda", auth.signIn(SERVER + "/", "panda", "pw", "Sony NW-A306"));
        assertTrue(auth.signedIn());
        assertEquals(SERVER, vault.get("server"));
        assertEquals("refresh-1", vault.get("refresh")); // the Android vault encrypts this one
        assertFalse(vault.data.containsValue("access-1")); // access tokens stay in memory
        assertFalse(vault.data.containsValue("pw")); // the password is never stored
    }

    @Test
    public void aWrongPasswordIsTheServersGenericMessage() throws Exception {
        try {
            auth.signIn(SERVER, "panda", "wrong", "Pixel");
            fail();
        } catch (AuthCore.AuthException e) {
            assertEquals(401, e.status);
            assertEquals("That username and password don’t match.", e.getMessage());
        }
        assertFalse(auth.signedIn());
    }

    @Test
    public void accessTokenIsCachedThenRefreshedBeforeItEndsAndRefreshTokensRotate() throws Exception {
        auth.signIn(SERVER, "panda", "pw", "Pixel");
        assertEquals("access-1", auth.accessToken(false));
        now[0] += 10 * 60_000; // 10 minutes: still fine
        assertEquals("access-1", auth.accessToken(false));
        now[0] += 4 * 60_000; // inside the 2-minute margin: refresh
        assertEquals("access-2", auth.accessToken(false));
        assertEquals("refresh-2", vault.get("refresh")); // the rotated refresh token replaced the old one
        auth.expireAccess(); // e.g. a 401 from a stream
        assertEquals("access-3", auth.accessToken(false));
    }

    @Test
    public void aRevokedDeviceForgetsItsSignIn() throws Exception {
        auth.signIn(SERVER, "panda", "pw", "Pixel");
        http.refreshCode = 401;
        assertNull(auth.accessToken(true));
        assertFalse(auth.signedIn());
        assertTrue(vault.data.isEmpty());
        assertNull(auth.authorizationFor(SERVER + "/api/tracks/1/stream"));
    }

    @Test
    public void losingTheServerIsNotSigningOut() throws Exception {
        auth.signIn(SERVER, "panda", "pw", "Pixel");
        http.offline = true;
        try {
            auth.accessToken(true);
            fail();
        } catch (IOException expected) {
            // offline
        }
        assertTrue(auth.signedIn()); // downloads keep playing; sign-in resumes when the server is back
        assertNull(auth.authorizationFor("content://com.android.externalstorage.documents/tree/x/document/song.flac")); // local files need nothing
        http.offline = false;
        http.refreshCode = 500;
        try {
            auth.accessToken(true);
            fail();
        } catch (IOException expected) {
            assertTrue(auth.signedIn()); // a server error isn't a revocation either
        }
    }

    @Test
    public void theHeaderGoesOnlyToThePandaFMServer() throws Exception {
        auth.signIn(SERVER, "panda", "pw", "Pixel");
        assertEquals("Bearer access-1", auth.authorizationFor(SERVER + "/api/tracks/1/stream?quality=high"));
        assertEquals("Bearer access-1", auth.authorizationFor("HTTPS://Music.Example.com:443/api/covers/c1"));
        assertNull(auth.authorizationFor("https://evil.example.net/api/tracks/1/stream"));
        assertNull(auth.authorizationFor("http://music.example.com/api/x")); // a different scheme is a different origin
        assertNull(auth.authorizationFor("https://music.example.com:8443/api/x"));
        assertNull(auth.authorizationFor("https://music.example.com.evil.net/api/x"));
        assertNull(auth.authorizationFor(null));
    }

    @Test
    public void redirectsAreFollowedOnlyWithinTheSameOrigin() {
        assertEquals(SERVER + "/api/downloads/files/s1/original", AuthHttp.redirectTarget(SERVER + "/api/a", "/api/downloads/files/s1/original"));
        assertNull(AuthHttp.redirectTarget(SERVER + "/api/a", "https://cdn.example.org/file"));
        assertNull(AuthHttp.redirectTarget(SERVER + "/api/a", "http://music.example.com/api/a")); // https -> http
        assertNull(AuthHttp.redirectTarget(SERVER + "/api/a", null));
    }

    @Test
    public void signOutTellsTheServerAndClearsEverything() throws Exception {
        auth.signIn(SERVER, "panda", "pw", "Pixel");
        auth.signOut();
        assertTrue(http.calls.contains("/api/auth/logout bearer"));
        assertFalse(auth.signedIn());
        assertTrue(vault.data.isEmpty());
    }

    @Test
    public void secretsStayOutOfMessagesAndLoggedUrls() throws Exception {
        auth.signIn(SERVER, "panda", "pw", "Pixel");
        http.refreshCode = 503;
        try {
            auth.accessToken(true);
            fail();
        } catch (IOException e) {
            assertFalse(e.getMessage().contains("refresh-") || e.getMessage().contains("access-"));
        }
        assertEquals(SERVER + "/api/tracks/1/stream", AuthCore.redact(SERVER + "/api/tracks/1/stream?quality=low#x"));
        for (String call : http.calls) assertFalse(call.contains("refresh-") || call.contains("access-"));
    }

    @Test
    public void miniJsonRoundTrips() {
        assertEquals("\"a\\\"b\\\\c\\n\"", MiniJson.quote("a\"b\\c\n"));
        assertEquals("pan\"da", MiniJson.string("{\"username\":\"pan\\\"da\"}", "username"));
        assertEquals(Long.valueOf(900), MiniJson.number("{\"access_expires_in\": 900}", "access_expires_in"));
        assertNull(MiniJson.string("{}", "x"));
    }

    @Test
    public void concurrentRefreshesShareOneRotation() throws Exception {
        final java.util.concurrent.CountDownLatch inFlight = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        final int[] refreshes = {0};
        AuthCore.Http slow = (url, body, bearer) -> {
            if (url.endsWith("/refresh")) {
                refreshes[0]++;
                inFlight.countDown();
                try { release.await(); } catch (InterruptedException ignored) {}
            }
            return http.post(url, body, bearer);
        };
        AuthCore core = new AuthCore(slow, vault, () -> now[0]);
        core.signIn(SERVER, "panda", "pw", "Pixel");
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(3);
        java.util.concurrent.Future<String> first = pool.submit(() -> core.accessToken(true)); // e.g. Media3 got a 401
        inFlight.await();
        java.util.List<java.util.concurrent.Future<String>> waiting = new java.util.ArrayList<>();
        for (int k = 0; k < 2; k++) waiting.add(pool.submit(() -> core.accessToken(true))); // artwork, downloads
        Thread.sleep(100);
        release.countDown();
        String token = first.get();
        for (java.util.concurrent.Future<String> f : waiting) assertEquals(token, f.get());
        assertEquals(1, refreshes[0]); // one rotation, shared
        pool.shutdown();
    }
}
