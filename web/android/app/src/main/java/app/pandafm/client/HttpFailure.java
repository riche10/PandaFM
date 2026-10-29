package app.pandafm.client;

/**
 * 5.4.2: what an HTTP media request actually got back (status, Retry-After, PandaFM's safe error
 * code), instead of Media3's generic ERROR_CODE_IO_BAD_HTTP_STATUS. Never holds URLs, headers or tokens.
 */
final class HttpFailure {
    final int status;
    final Integer retryAfterS;
    final String pandaCode;

    HttpFailure(int status, Integer retryAfterS, String pandaCode) {
        this.status = status;
        this.retryAfterS = retryAfterS;
        this.pandaCode = pandaCode;
    }

    /** "HTTP 503 · navidrome_unavailable" */
    String label() {
        return "HTTP " + status + (pandaCode == null ? "" : " · " + pandaCode);
    }

    /** A safe error code from a small JSON body like {"error":{"code":"not_found"}} (first 4 KB only). */
    static String codeFromBody(byte[] body) {
        if (body == null || body.length == 0) return null;
        String text = new String(body, 0, Math.min(body.length, 4096), java.nio.charset.StandardCharsets.UTF_8);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"code\"\\s*:\\s*\"([a-z_]{1,40})\"").matcher(text);
        return m.find() ? m.group(1) : null;
    }

    static Integer seconds(String value) {
        if (value == null) return null;
        try {
            int s = Integer.parseInt(value.trim());
            return s >= 0 ? s : null;
        } catch (NumberFormatException e) {
            return null; // an HTTP date: treated as "no hint"
        }
    }
}
