package app.pandafm.client;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One song in the native queue: the full PandaFM track object (as the API and
 * the web app know it, so the phone UI shows the same details), its place
 * (context = from the collection, manual = Play next / Add to queue), and,
 * for Panda Radio picks, the radio session and selection.
 * Holds no URL and no credential: the source is resolved when it plays.
 */
final class QueueItem {
    final String uid;
    final Map<String, Object> track;
    final String origin; // "context" | "manual"
    final String radioSession; // null unless a radio pick
    final Long radioSelection;

    QueueItem(String uid, Map<String, Object> track, String origin, String radioSession, Long radioSelection) {
        this.uid = uid;
        this.track = track;
        this.origin = "manual".equals(origin) ? "manual" : "context";
        this.radioSession = radioSession;
        this.radioSelection = radioSelection;
    }

    QueueItem withOrigin(String o) {
        return new QueueItem(uid, track, o, radioSession, radioSelection);
    }

    boolean isRadio() {
        return radioSession != null && radioSelection != null;
    }

    String trackId() { return Json.str(track, "id"); }
    String title() { String t = Json.str(track, "title"); return t == null ? "Untitled" : t; }
    String artist() { String a = Json.str(track, "artist"); return a == null ? "Unknown artist" : a; }
    String album() { return Json.str(track, "album"); }
    String coverArtId() { return Json.str(track, "cover_art_id"); }
    Long durationSeconds() { return Json.num(track, "duration_seconds"); }

    Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("uid", uid);
        m.put("track", track);
        m.put("origin", origin);
        if (isRadio()) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("sessionId", radioSession);
            r.put("selectionId", radioSelection);
            m.put("radio", r);
        }
        return m;
    }

    /** From the web app's / persisted shape; null if it isn't a usable item. */
    static QueueItem fromMap(Map<String, Object> m) {
        if (m == null) return null;
        Map<String, Object> track = Json.map(m.get("track"));
        String uid = Json.str(m, "uid");
        if (track == null || uid == null || Json.str(track, "id") == null) return null;
        Map<String, Object> r = Json.map(m.get("radio"));
        return new QueueItem(uid, track, Json.str(m, "origin"), Json.str(r, "sessionId"), Json.num(r, "selectionId"));
    }
}
