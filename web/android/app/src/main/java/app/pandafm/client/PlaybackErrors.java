package app.pandafm.client;

/**
 * Pure rules for native playback (no Android or Media3 types, so plain JUnit
 * can test them): which sources may be played, and what a Media3 error code
 * means for the listener. Media3 groups its codes by thousands: 2xxx I/O,
 * 3xxx parsing, 4xxx decoding, 5xxx audio output.
 */
final class PlaybackErrors {
    private PlaybackErrors() {}

    /** http(s) streams from the PandaFM server and content:// downloads only. */
    static boolean allowedSource(String uri) {
        String s = scheme(uri);
        return "http".equals(s) || "https".equals(s) || "content".equals(s);
    }

    static String scheme(String uri) {
        if (uri == null) return null;
        int colon = uri.indexOf(':');
        return colon > 0 ? uri.substring(0, colon).toLowerCase(java.util.Locale.ROOT) : null;
    }

    /** {kind, reason} for the web app, e.g. {"network", "connect"} or {"missing", "not_found"}. */
    static String[] classify(int code, boolean localSource) {
        switch (code) {
            case 2001: return new String[] {"network", "connect"}; // IO_NETWORK_CONNECTION_FAILED
            case 2002: return new String[] {"network", "timeout"}; // IO_NETWORK_CONNECTION_TIMEOUT
            case 2004: return new String[] {"network", "http_status"}; // IO_BAD_HTTP_STATUS
            case 2005: return new String[] {localSource ? "missing" : "network", "not_found"}; // IO_FILE_NOT_FOUND
            case 2006: return new String[] {"missing", "no_permission"}; // IO_NO_PERMISSION
            case 2007: return new String[] {"network", "cleartext"}; // IO_CLEARTEXT_NOT_PERMITTED
            case 3003: // PARSING_CONTAINER_UNSUPPORTED
            case 4004: // DECODING_FORMAT_EXCEEDS_CAPABILITIES
            case 4005: // DECODING_FORMAT_UNSUPPORTED
                return new String[] {"unsupported", "format"};
            default:
                if (code >= 2000 && code < 3000) return new String[] {localSource ? "missing" : "network", "io"};
                if (code >= 3000 && code < 5000) return new String[] {"decode", "decode"};
                return new String[] {"unknown", "other"};
        }
    }
}
