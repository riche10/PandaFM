package app.pandafm.client;

/**
 * Streaming quality on Android (5.0.1), decided when a song is loaded so a
 * Wi-Fi ↔ mobile change applies from the next song on. Mirrors
 * web/src/player/streamQuality.ts. Downloaded songs never get here.
 */
final class StreamQuality {
    private StreamQuality() {}

    /** auto: original on Wi-Fi/unmetered, high (AAC ~256) on metered data. */
    static String resolve(String setting, boolean metered, boolean wifi) {
        if ("original".equals(setting) || "high".equals(setting) || "low".equals(setting)) return setting;
        return metered && !wifi ? "high" : "original";
    }

    static String streamUrl(String server, String trackId, String quality) {
        String url = AuthCore.base(server) + "/api/tracks/" + LibraryTree.enc(trackId) + "/stream";
        return "original".equals(quality) ? url : url + "?quality=" + quality;
    }
}
