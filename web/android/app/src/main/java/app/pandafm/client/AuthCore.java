package app.pandafm.client;

import java.io.IOException;
import java.net.URI;
import java.util.Locale;

/**
 * This device's PandaFM sign-in (5.0), with no Android dependencies so it can
 * be unit-tested. The refresh token lives in a Vault (the Android one
 * encrypts it with a Keystore key); the 15-minute access token only in
 * memory. Native playback, downloads and the WebView all ask here, so none of
 * them needs the others to be running. Tokens never go into URLs or logs.
 */
final class AuthCore {
    interface Http {
        Response post(String url, String jsonBody, String bearer) throws IOException;
    }

    static final class Response {
        final int code;
        final String body;

        Response(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }

    /** Persistent storage; the Android implementation encrypts the refresh token at rest. */
    interface Vault {
        String get(String key);
        void put(String key, String value);
        void clear();
    }

    interface Clock {
        long nowMs();
    }

    /** A sign-in the server refused (wrong password, setup closed, too many attempts...). */
    static final class AuthException extends Exception {
        final int status;

        AuthException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    static final long REFRESH_MARGIN_MS = 120_000; // refresh 2 minutes before the access token ends

    private final Http http;
    private final Vault vault;
    private final Clock clock;
    private String access;
    private long accessExpiresMs;

    AuthCore(Http http, Vault vault, Clock clock) {
        this.http = http;
        this.vault = vault;
        this.clock = clock;
    }

    synchronized boolean signedIn() {
        return vault.get("refresh") != null && vault.get("server") != null;
    }

    synchronized String username() {
        return vault.get("username");
    }

    synchronized String server() {
        return vault.get("server");
    }

    synchronized String signIn(String server, String username, String password, String deviceName) throws IOException, AuthException {
        String body = "{\"username\":" + MiniJson.quote(username) + ",\"password\":" + MiniJson.quote(password)
            + ",\"client\":\"device\",\"device_name\":" + MiniJson.quote(deviceName) + ",\"platform\":\"android\"}";
        return keep(server, http.post(base(server) + "/api/auth/login", body, null));
    }

    synchronized String setup(String server, String setupToken, String username, String password, String deviceName) throws IOException, AuthException {
        String body = "{\"setup_token\":" + MiniJson.quote(setupToken) + ",\"username\":" + MiniJson.quote(username) + ",\"password\":" + MiniJson.quote(password)
            + ",\"client\":\"device\",\"device_name\":" + MiniJson.quote(deviceName) + ",\"platform\":\"android\"}";
        return keep(server, http.post(base(server) + "/api/auth/setup", body, null));
    }

    private String keep(String server, Response r) throws AuthException {
        if (r.code != 200) {
            String message = MiniJson.string(r.body, "message");
            throw new AuthException(r.code, message != null ? message : "PandaFM answered " + r.code + ".");
        }
        String refresh = MiniJson.string(r.body, "refresh_token");
        String token = MiniJson.string(r.body, "access_token");
        Long ttl = MiniJson.number(r.body, "access_expires_in");
        if (refresh == null || token == null) throw new AuthException(r.code, "PandaFM didn’t return a device sign-in.");
        String user = MiniJson.string(r.body, "username");
        vault.put("server", base(server));
        if (user != null) vault.put("username", user);
        vault.put("refresh", refresh); // rotated on every refresh: always keep the newest
        access = token;
        accessExpiresMs = clock.nowMs() + (ttl == null ? 900 : ttl) * 1000L;
        return user;
    }

    /**
     * A current access token, refreshed when it's (nearly) expired or forced.
     * Null when signed out or revoked. A server that can't be reached throws
     * IOException and keeps the sign-in: offline is not signed out.
     */
    synchronized String accessToken(boolean force) throws IOException {
        if (!signedIn()) return null;
        if (!force && access != null && clock.nowMs() < accessExpiresMs - REFRESH_MARGIN_MS) return access;
        Response r = http.post(server() + "/api/auth/refresh", "{\"refresh_token\":" + MiniJson.quote(vault.get("refresh")) + "}", null);
        if (r.code == 401) { // this device was signed out (revoked, password changed, expired)
            forget();
            return null;
        }
        if (r.code != 200) throw new IOException("PandaFM couldn’t refresh the sign-in (HTTP " + r.code + ")");
        try {
            keep(server(), r);
        } catch (AuthException e) {
            throw new IOException(e.getMessage());
        }
        return access;
    }

    /** The access token was refused: the next request refreshes first. */
    synchronized void expireAccess() {
        access = null;
    }

    /** Sign this device out (on the server too, when it can be reached). Downloads stay on the device. */
    synchronized void signOut() {
        String server = server();
        String token = access;
        if (server != null && token != null) {
            try {
                http.post(server + "/api/auth/logout", "{}", token);
            } catch (IOException ignored) {
                // offline: the server will expire the session by itself
            }
        }
        forget();
    }

    private void forget() {
        access = null;
        accessExpiresMs = 0;
        vault.clear();
    }

    /** "Bearer …" for requests to the PandaFM server itself; null for anything else (another host, a local file). */
    String authorizationFor(String url) throws IOException {
        String server;
        synchronized (this) {
            server = server();
        }
        if (server == null || url == null || !sameOrigin(url, server)) return null;
        String token = accessToken(false);
        return token == null ? null : "Bearer " + token;
    }

    static boolean sameOrigin(String a, String b) {
        try {
            URI x = new URI(a), y = new URI(b);
            if (x.getScheme() == null || y.getScheme() == null || x.getHost() == null || y.getHost() == null) return false;
            String sx = x.getScheme().toLowerCase(Locale.ROOT), sy = y.getScheme().toLowerCase(Locale.ROOT);
            return sx.equals(sy) && (sx.equals("http") || sx.equals("https"))
                && x.getHost().equalsIgnoreCase(y.getHost()) && port(x) == port(y);
        } catch (Exception e) {
            return false;
        }
    }

    private static int port(URI u) {
        if (u.getPort() != -1) return u.getPort();
        return "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }

    static String base(String server) {
        String s = server == null ? "" : server.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /** For logs and error messages: no query string, no fragment (never anything secret). */
    static String redact(String url) {
        if (url == null) return "";
        int cut = url.length();
        for (char c : new char[] {'?', '#'}) {
            int i = url.indexOf(c);
            if (i >= 0 && i < cut) cut = i;
        }
        return url.substring(0, cut);
    }
}
