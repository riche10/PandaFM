package app.pandafm.client;

import android.content.Context;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Map;

/**
 * Native GETs to the PandaFM server (downloads, artwork) with the device's
 * sign-in. The Authorization header goes only to the server's own origin;
 * redirects are followed by hand and only within that origin, so a token can
 * never be carried to another host. A refused access token is refreshed once.
 */
final class AuthHttp {
    private static final int MAX_HOPS = 4;

    private AuthHttp() {}

    static HttpURLConnection open(Context ctx, String url, Map<String, String> headers, int connectMs, int readMs) throws IOException {
        AuthCore auth = AuthStore.get(ctx);
        String target = url;
        boolean retried = false;
        for (int hop = 0; hop < MAX_HOPS; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            String authorization = auth.authorizationFor(target);
            if (authorization != null) c.setRequestProperty("Authorization", authorization);
            int code = c.getResponseCode();
            if (code == 401 && authorization != null && !retried) {
                c.disconnect();
                auth.expireAccess(); // refreshed on the next attempt
                retried = true;
                hop--;
                continue;
            }
            if (code >= 300 && code < 400 && code != 304) {
                String next = redirectTarget(target, c.getHeaderField("Location"));
                c.disconnect();
                if (next == null) throw new IOException("Refused a redirect to another server");
                target = next;
                continue;
            }
            return c;
        }
        throw new IOException("Too many redirects");
    }

    /** A signed JSON POST to the PandaFM server (no redirects at all: a POST is never forwarded). */
    static HttpURLConnection post(Context ctx, String url, String json, int connectMs, int readMs) throws IOException {
        AuthCore auth = AuthStore.get(ctx);
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            String authorization = auth.authorizationFor(url);
            if (authorization != null) c.setRequestProperty("Authorization", authorization);
            try (java.io.OutputStream out = c.getOutputStream()) {
                out.write(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            if (code == 401 && authorization != null && attempt == 0) {
                c.disconnect();
                auth.expireAccess();
                continue;
            }
            if (code >= 300 && code < 400) {
                c.disconnect();
                throw new IOException("Refused a redirect");
            }
            return c;
        }
        throw new IOException("Not signed in");
    }

    /** The redirect's absolute URL if it stays on the same origin; null otherwise. */
    static String redirectTarget(String from, String location) {
        if (location == null || location.isEmpty()) return null;
        try {
            String next = new URI(from).resolve(location).toString();
            return AuthCore.sameOrigin(from, next) ? next : null;
        } catch (Exception e) {
            return null;
        }
    }
}
