package app.pandafm.client;

import java.util.LinkedHashMap;
import java.util.Map;

/** The safe plan when no Panda DJ plan is known (offline, not analysed yet): mirrors the server's fallback. */
final class MixFallback {
    static final long TAIL_MS = 3000; // the blend ends this long before the file ends (out of most fades and silences)

    private MixFallback() {}

    static long overlapFor(String mode) {
        return "gentle".equals(mode) ? 3500 : "energetic".equals(mode) ? 6000 : 5000;
    }

    /** The server's own fallback (5.3): a recognisable equal-power blend that avoids A's tail. */
    static Map<String, Object> plan(QueueItem a, QueueItem b, String mode) {
        Long seconds = a.durationSeconds();
        long duration = seconds == null ? 0 : seconds * 1000;
        long overlap = duration > overlapFor(mode) + TAIL_MS ? overlapFor(mode) : 0;
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("from", a.trackId());
        p.put("to", b.trackId());
        p.put("type", "smooth_blend");
        p.put("label", "Smooth Blend");
        p.put("summary", "Smooth Blend · " + overlap / 1000 + " sec");
        p.put("overlap_ms", overlap);
        p.put("outgoing_start_ms", Math.max(0, duration - overlap - TAIL_MS));
        p.put("incoming_start_ms", 0L);
        p.put("curve", "equal_power");
        p.put("confidence", 0.3);
        p.put("ready", Boolean.FALSE);
        p.put("source", "fallback");
        p.put("intentional", Boolean.FALSE);
        p.put("explanation", "Panda hasn’t analysed these songs yet, so it uses a short, safe blend.");
        return p;
    }
}
