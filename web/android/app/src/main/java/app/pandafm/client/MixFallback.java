package app.pandafm.client;

import java.util.LinkedHashMap;
import java.util.Map;

/** The safe plan when no Panda DJ plan is known (offline, not analysed yet): mirrors the server's fallback. */
final class MixFallback {
    static final long OVERLAP_MS = 4000, GENTLE_MS = 2500;

    private MixFallback() {}

    static Map<String, Object> plan(QueueItem a, QueueItem b, String mode) {
        Long seconds = a.durationSeconds();
        long duration = seconds == null ? 0 : seconds * 1000;
        long overlap = "gentle".equals(mode) ? GENTLE_MS : OVERLAP_MS;
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("from", a.trackId());
        p.put("to", b.trackId());
        p.put("type", "smooth_blend");
        p.put("label", "Smooth Blend");
        p.put("summary", "Smooth Blend · " + overlap / 1000 + " sec");
        p.put("overlap_ms", duration > overlap ? overlap : 0L);
        p.put("outgoing_start_ms", Math.max(0, duration - overlap));
        p.put("incoming_start_ms", 0L);
        p.put("curve", "equal_power");
        p.put("confidence", 0.3);
        p.put("ready", Boolean.FALSE);
        p.put("explanation", "Panda hasn’t analysed these songs yet, so it uses a short, safe blend.");
        return p;
    }
}
