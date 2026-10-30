package app.pandafm.client;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Panda DJ on Android (5.2): HOW Track A becomes Track B, with two decks.
 *
 * Each deck is a 5.1 EngineCore over its own ExoPlayer (state model,
 * generations, bounded retries, signed sources, safe artwork). Without a
 * Panda Mix this engine is exactly the 5.1 single-deck engine: everything goes
 * to the primary deck and the standby deck stays idle.
 *
 * During a Panda Mix: the next song is preloaded on the standby deck (silent,
 * paused, at its planned start) about 12 s before the transition; at the plan's
 * start (measured on the outgoing deck's own clock, every 40 ms) the incoming
 * deck plays and equal-power gains cross over; at the midpoint the incoming song
 * becomes the logical current track (QueueController.onHandoff: history, lock
 * screen, Next/Previous); at the end the outgoing deck stops and becomes the
 * standby. The queue still decides WHAT plays; this never chooses songs.
 */
final class PandaDjEngine implements QueueController.Engine {
    interface Host {
        /** Resolve the incoming song when it's preloaded (local file first, else a stream for the current network). */
        String uriFor(QueueItem item);
        /** The logical current deck changed: the media session follows it. */
        void onLogicalDeck(int deck);
        void log(String message);
        long nowMs();
        /** Whether a stream could be opened right now (warmups never try offline). */
        default boolean online() {
            return true;
        }
    }

    static final long WARM_AFTER_MS = 2_000; // let the current song settle before opening the next stream

    static final long PRELOAD_MS = 20_000, TICK_MS = 40, MIN_OVERLAP_MS = 1_500;
    /** 5.5: a streamed incoming deck needs this much buffered (or the whole overlap, if shorter) to start a blend. */
    static final long NEED_BUFFER_MS = 6_000, MIN_START_BUFFER_MS = 1_500;
    static final int HISTORY = 20;

    private final EngineCore[] cores;
    private final EngineCore.PlayerPort[] ports;
    private final EngineCore.Scheduler scheduler;
    private final Host host;
    private QueueController controller;

    private int primary = 0;
    private float userVolume = 1f;
    private QueueItem nextItem;
    private Map<String, Object> plan;
    private int planGen;
    private QueueItem queuedNext;
    private Map<String, Object> queuedPlan;
    private int queuedGen;
    private boolean preloaded, running, handedOff, paused, ticking, released, followerHeld;
    private int outDeck, inDeck;
    private long effStart, effOverlap; // a late start (incoming not ready, or a seek into the blend) shortens the overlap
    // 5.5: what actually happened, for tuning on a real device
    private long plannedStart, plannedOverlap, bufferedAtStart, handoffAt;
    private String degradation;
    private Map<String, Object> current; // the running transition's record
    private final java.util.ArrayDeque<Map<String, Object>> transitionLog = new java.util.ArrayDeque<>();
    private double progress;
    private int transitions;
    // 5.3 diagnostics: what actually happened, so a deliberately subtle transition can't be mistaken for a failure
    private int smart, fallbacks, manual, intentional, cancelled, notReady;
    private String lastReason, lastPlan;
    private final float[] vol = {1f, 0f};
    // 5.4 next-track warmup (ordinary playback): at most one song, on the standby deck
    private QueueItem warmItem;
    private String warmUri, warmState = "idle";
    private int warmGen;
    private boolean warmLoaded;
    private String preloadUri; // the Panda Mix incoming song's source (it may be promoted on Next too)
    private final ArrayDeque<String> history = new ArrayDeque<>();

    PandaDjEngine(EngineCore a, EngineCore.PlayerPort pa, EngineCore b, EngineCore.PlayerPort pb, EngineCore.Scheduler scheduler, Host host) {
        cores = new EngineCore[] {a, b};
        ports = new EngineCore.PlayerPort[] {pa, pb};
        this.scheduler = scheduler;
        this.host = host;
        a.attach(new DeckSink(0));
        b.attach(new DeckSink(1));
        b.setStandby(true);
    }

    void attach(QueueController c) {
        controller = c;
    }

    void release() {
        released = true;
        cores[0].release();
        cores[1].release();
    }

    private int other() {
        return 1 - primary;
    }

    private void setVol(int deck, float v) {
        vol[deck] = v;
        ports[deck].setVolume(v);
    }

    /** Deck events: only the logical current deck speaks for the player (incoming buffering never pauses it). */
    private final class DeckSink implements PlaybackSink {
        final int deck;

        DeckSink(int deck) {
            this.deck = deck;
        }

        @Override
        public void onEngineState(int gen, String state) {
            if (released || controller == null) return;
            if (deck == primary && !(running && handedOff == false && deck != outDeck)) controller.onEngineState(gen, state);
        }

        @Override
        public void onEnded(int gen) {
            if (released || controller == null) return;
            if (running && deck == outDeck) { // the outgoing song ran out during the blend
                if (!handedOff) handoffNow();
                finish();
                return;
            }
            if (deck == primary) controller.onEnded(gen);
        }

        @Override
        public void onUnavailable(int gen, String message) {
            if (released || controller == null) return;
            if (deck == primary && !(running && deck == outDeck && !handedOff)) {
                cancel("song unavailable");
                controller.onUnavailable(gen, message);
            } else {
                onError(gen, message); // a standby or mid-blend deck: the usual isolated handling
            }
        }

        @Override
        public void onError(int gen, String message) {
            if (released || controller == null) return;
            if (running && deck == outDeck && !handedOff) { // A failed mid-blend: B is already playing, hand over
                record("outgoing error: " + message + " → handing over to B");
                handoffNow();
                finish();
                return;
            }
            if (deck == primary) {
                cancel("player error");
                controller.onError(gen, message);
            } else if (warmLoaded && !running) { // a warmed next song failed: the next song simply loads normally later
                warmState = "failed";
                warmLoaded = false;
                cores[deck].stop();
                record("warmup failed → normal load: " + message);
            } else { // B failed to load or play: A carries on and ends normally
                record("incoming error: " + message + " → normal handoff");
                cancel("incoming failed");
            }
        }
    }

    // ── what the queue asks for ──
    @Override
    public void load(int gen, QueueItem item, String uri, long startMs, boolean play) {
        if (!running && promote(gen, item, uri, startMs, play)) return;
        if (warmItem != null) invalidateWarm("a different song was loaded");
        cancel("load");
        paused = !play;
        cores[primary].load(gen, item, uri, startMs, play);
        volumes(1f, 0f);
    }

    @Override
    public void play() {
        paused = false;
        cores[primary].play();
        if (running) cores[outDeck == primary ? inDeck : outDeck].play(); // both decks of a paused blend
        tickSoon();
    }

    @Override
    public void pause() {
        paused = true;
        cores[primary].pause();
        if (running) cores[outDeck == primary ? inDeck : outDeck].pause(); // the automation freezes where it is
    }

    /**
     * A seek re-arms the pending transition (5.2 dropped it, so that song ended with a plain handoff):
     * a blend in progress is cancelled cleanly, then planned again from the new position.
     */
    @Override
    public void seekTo(long ms) {
        Map<String, Object> keepPlan = handedOff ? null : plan;
        QueueItem keepNext = handedOff ? null : nextItem;
        int keepGen = planGen;
        cancel("seek");
        cores[primary].seekTo(ms);
        if (keepNext != null && keepPlan != null) {
            nextItem = keepNext;
            plan = keepPlan;
            planGen = keepGen;
        }
        tickSoon();
    }

    @Override public long positionMs() { return cores[primary].positionMs(); }
    @Override public long durationMs() { return cores[primary].durationMs(); }
    @Override public boolean playWhenReady() { return cores[primary].playWhenReady(); }

    @Override
    public void stop() {
        cancel("stop");
        cores[primary].stop();
    }

    void setUserVolume(float v) {
        userVolume = Math.max(0f, Math.min(1f, v));
        if (!running) setVol(primary, userVolume);
    }

    /**
     * 5.4: the next song is already warm on the standby deck (or preloaded for a Panda Mix
     * blend): adopt it instead of reloading it. Only when it is exactly this queue item, from the
     * source that would be used now; otherwise the normal load path runs.
     */
    private boolean promote(int gen, QueueItem item, String uri, long startMs, boolean play) {
        int standby = other();
        boolean warm = warmLoaded && warmItem != null && warmItem.uid.equals(item.uid) && uri != null && uri.equals(warmUri);
        boolean mixed = preloaded && nextItem != null && nextItem.uid.equals(item.uid) && uri != null && uri.equals(preloadUri);
        if (!(warm || mixed) || cores[standby].item() == null || !cores[standby].item().uid.equals(item.uid)) return false;
        int old = primary;
        cores[old].stop(); // the old song's decoder goes; that deck becomes the standby
        setVol(old, 0f);
        primary = standby;
        cores[old].setStandby(true);
        cores[primary].setStandby(false);
        cores[primary].adopt(gen);
        if (Math.abs(cores[primary].positionMs() - startMs) > 250) cores[primary].seekTo(startMs); // e.g. a mix preload at its planned start
        setVol(primary, userVolume);
        paused = !play;
        if (play) cores[primary].play();
        else cores[primary].pause();
        // 5.4.1: only now do the session, lock screen and audio focus follow. In 5.4 they moved first,
        // so for a moment Media3 saw a paused logical player at every song change, the state it
        // uses to keep the service in the foreground.
        host.onLogicalDeck(primary);
        record((warm ? "warmup adopted " : "preloaded mix song adopted ") + item.trackId());
        host.log("PandaDJ " + (warm ? "warmup adopted" : "preload adopted") + " track=" + item.trackId());
        warmItem = null;
        warmUri = null;
        warmLoaded = false;
        warmState = "idle";
        preloaded = false;
        nextItem = null;
        plan = null;
        cores[primary].onPlayerChanged();
        return true;
    }

    @Override
    public void warmNext(int forGen, QueueItem next) {
        if (released) return;
        if (next == null) {
            invalidateWarm("no next song");
            return;
        }
        if (running || plan != null) return; // a Panda Mix preload owns the standby deck
        String uri = host.uriFor(next); // the source that would be used if Next were pressed now
        if (warmItem != null && warmItem.uid.equals(next.uid) && uri != null && uri.equals(warmUri) && !"failed".equals(warmState)) return;
        invalidateWarm(warmItem == null ? null : warmItem.uid.equals(next.uid) ? "source changed (quality or download)" : "queue changed");
        warmItem = next;
        warmGen = forGen;
        warmUri = uri;
        if (uri == null || (uri.startsWith("http") && !host.online())) {
            warmState = "failed"; // offline and not downloaded: nothing to warm, and no retrying
            record("warmup skipped (offline) " + next.trackId());
            return;
        }
        warmState = "resolving"; // opened once the current song has settled
        tickSoon();
    }

    private void startWarm() {
        int deck = other();
        cores[deck].setStandby(true);
        setVol(deck, 0f);
        cores[deck].load(warmGen, warmItem, warmUri, 0, false);
        warmLoaded = true;
        warmState = "loading";
        record("warmup start " + warmItem.trackId() + " (" + sourceOf(warmUri) + ")");
    }

    private void invalidateWarm(String why) {
        if (warmLoaded && !running && !preloaded) cores[other()].stop();
        if (why != null && warmItem != null) record("warmup invalidated: " + why);
        warmItem = null;
        warmUri = null;
        warmLoaded = false;
        warmState = why == null ? "idle" : "invalidated";
    }

    static String sourceOf(String uri) {
        if (uri == null) return "none";
        if (!uri.startsWith("http")) return "downloaded";
        return uri.contains("quality=low") ? "Data Saver" : uri.contains("quality=high") ? "High" : "Original";
    }

    @Override
    public void prepareNext(int forGen, QueueItem next, Map<String, Object> newPlan) {
        if (released) return;
        if (next != null && newPlan != null && warmItem != null) invalidateWarm("Panda Mix takes over the standby deck");
        if (running) { // the current blend finishes first; this one is planned right after
            queuedNext = next;
            queuedPlan = newPlan;
            queuedGen = forGen;
            return;
        }
        if (next == null || newPlan == null) {
            resetStandby();
            nextItem = null;
            plan = null;
            return;
        }
        if (nextItem == null || !nextItem.uid.equals(next.uid)) resetStandby(); // the queue changed: re-plan this pair only
        nextItem = next;
        plan = newPlan;
        planGen = forGen;
        tickSoon();
    }

    @Override
    public void adopt(int newGen) {
        cores[primary].adopt(newGen);
    }

    @Override
    public boolean inTransitionBeforeHandoff() {
        return running && !handedOff;
    }

    @Override
    public void completeTransitionNow() {
        if (!running) return;
        if (!handedOff) handoffNow();
        finish();
    }

    // ── the transition ──
    private long num(String key, long dflt) {
        Object v = plan == null ? null : plan.get(key);
        return v instanceof Number ? ((Number) v).longValue() : dflt;
    }

    private void tickSoon() {
        if (ticking || released || (nextItem == null && !running && !warmWaiting())) return;
        ticking = true;
        scheduler.postDelayed(this::tick, TICK_MS);
    }

    private boolean warmWaiting() {
        return warmItem != null && ("resolving".equals(warmState) || "loading".equals(warmState));
    }

    void tick() {
        ticking = false;
        if (released) return;
        if (warmWaiting()) {
            if ("resolving".equals(warmState) && PlaybackStateModel.intendsToPlay(cores[primary].state()) && cores[primary].positionMs() >= WARM_AFTER_MS) startWarm();
            else if ("loading".equals(warmState) && cores[other()].ready()) {
                warmState = "ready";
                record("warmup ready " + warmItem.trackId());
            }
        }
        if (running) {
            if (!paused) automate();
        } else if (nextItem != null && plan != null && PlaybackStateModel.intendsToPlay(cores[primary].state())) {
            long pos = cores[primary].positionMs();
            long start = num("outgoing_start_ms", Long.MAX_VALUE);
            long overlap = num("overlap_ms", 0);
            long latest = start + Math.max(0, overlap - MIN_OVERLAP_MS); // past this there's no room left for a blend
            if (pos > latest && overlap > MIN_OVERLAP_MS && !preloaded) { // e.g. a seek past the transition
                note("seeked past the transition; this song ends normally");
                nextItem = null;
                plan = null;
            } else {
                if (!preloaded && pos >= start - PRELOAD_MS) preload();
                if (preloaded && pos >= start) {
                    EngineCore in = cores[other()];
                    long buffered = in.bufferedMs();
                    long need = Math.min(overlap, NEED_BUFFER_MS);
                    boolean enough = in.ready() && (!in.isRemote() || buffered >= need);
                    if (enough) begin(pos, null);
                    else if (in.ready() && pos >= latest - 250 && buffered >= MIN_START_BUFFER_MS) {
                        begin(pos, "incoming buffer " + String.format(java.util.Locale.ROOT, "%.1f", buffered / 1000.0) + " s: blend shortened");
                    } else if (pos > latest) { // A just plays to its end; the queue advances the ordinary way
                        notReady++;
                        recordHistory(null, in.ready() ? "incoming buffer insufficient: plain handoff" : "incoming deck not ready: plain handoff");
                        cancel(in.ready() ? "incoming buffer insufficient" : "incoming deck not ready");
                    }
                }
            }
        }
        tickSoon();
    }

    private void preload() {
        String uri = host.uriFor(nextItem);
        preloaded = true;
        if (uri == null) { // offline and not downloaded: no transition; the queue handles it at A's end
            record("no source for the next song; normal handoff");
            nextItem = null;
            return;
        }
        cores[other()].setStandby(true);
        setVol(other(), 0f);
        cores[other()].load(planGen, nextItem, uri, num("incoming_start_ms", 0), false);
        preloadUri = uri;
        host.log("PandaDJ preload deck=" + (other() == 0 ? "A" : "B") + " track=" + nextItem.trackId());
        record("preload " + nextItem.trackId() + " (" + plan.get("type") + ")");
    }

    private void begin(long pos, String degraded) {
        running = true;
        degradation = degraded;
        plannedStart = num("outgoing_start_ms", 0);
        plannedOverlap = num("overlap_ms", 0);
        bufferedAtStart = cores[other()].isRemote() ? cores[other()].bufferedMs() : -1;
        handoffAt = -1;
        handedOff = false;
        outDeck = primary;
        inDeck = other();
        progress = 0;
        long start = num("outgoing_start_ms", 0), overlap = num("overlap_ms", 0);
        effStart = Math.max(start, pos);
        effOverlap = Math.max(0, overlap - (effStart - start)); // late: the same ending, a shorter blend
        String source = String.valueOf(plan.get("source"));
        boolean deliberate = Boolean.TRUE.equals(plan.get("intentional"));
        if (deliberate) intentional++;
        else if ("manual".equals(source)) manual++;
        else if ("smart".equals(source)) smart++;
        else fallbacks++;
        lastPlan = plan.get("summary") + " (" + (deliberate ? "intentional" : source) + ")";
        cores[inDeck].play();
        followerHeld = false;
        transitions++;
        host.log("PandaDJ transition_start " + cores[outDeck].item().trackId() + "→" + nextItem.trackId() + " type=" + plan.get("type") + " source=" + source
            + " overlap=" + effOverlap + (effOverlap < overlap ? " (late, planned " + overlap + ")" : ""));
        record("transition_start " + lastPlan + " overlap=" + effOverlap + "ms" + (effOverlap < overlap ? " (late start)" : "")
            + (degraded == null ? "" : " · " + degraded));
        current = new LinkedHashMap<>();
        current.put("from", cores[outDeck].item().trackId());
        current.put("to", nextItem.trackId());
        current.put("plan", String.valueOf(plan.get("summary")));
        current.put("tier", plan.get("tier"));
        current.put("confidence", plan.get("confidence"));
        current.put("plannedMs", overlap);
        current.put("effectiveMs", effOverlap);
        current.put("lateMs", effStart - start);
        current.put("bufferedAtStartMs", bufferedAtStart);
        automate();
    }

    private void automate() {
        // Only the logical deck holds audio focus. If it stops making sound mid-blend (a call, a
        // navigation prompt, buffering), the other deck waits with it rather than playing on alone.
        int follower = primary == outDeck ? inDeck : outDeck;
        boolean leadAudible = ports[primary].isPlaying();
        if (!leadAudible && ports[follower].playWhenReady()) {
            ports[follower].setPlayWhenReady(false);
            followerHeld = true;
        } else if (leadAudible && followerHeld) {
            ports[follower].setPlayWhenReady(true);
            followerHeld = false;
        }
        if (!leadAudible) return; // the automation runs on the outgoing deck's clock: frozen while silent
        long pos = cores[outDeck].positionMs();
        progress = effOverlap <= 0 ? 1.0 : Math.max(0, Math.min(1, (pos - effStart) / (double) effOverlap));
        float[] g = gains(progress, String.valueOf(plan.get("curve")), dbl("gain_out_db"), dbl("gain_in_db"));
        setVol(outDeck, userVolume * g[0]);
        setVol(inDeck, userVolume * g[1]);
        if (progress >= 0.5 && !handedOff) handoffNow();
        if (running && progress >= 1.0) finish();
    }

    static float[] gains(double p, String curve) {
        return gains(p, curve, 0, 0);
    }

    /**
     * 5.5: the transition envelope, identical to the browser's (web/src/player/mixPlan.ts gains()):
     * equal_power (no dip at the midpoint), linear, sharp (the change concentrated around the midpoint,
     * so two low ends overlap only briefly), under_tail (A's held note rings out while B rises slowly at
     * first: in = p², out = 1 - p², so the two gains always sum to exactly 1 and the mix can't clip; A stays
     * at 75% or more for the first half). Levelling only attenuates (never above unity): A eases down to
     * outDb, B rises from inDb to 0 dB.
     */
    static float[] gains(double p, String curve, double outDb, double inDb) {
        p = Math.max(0, Math.min(1, p));
        double out, in;
        if ("linear".equals(curve)) {
            out = 1 - p;
            in = p;
        } else if ("under_tail".equals(curve)) {
            in = p * p; // headroom: out + in == 1 at every point (5.5 had out = 1 under a rising B: up to 2x full scale)
            out = 1 - in;
        } else {
            double q = "sharp".equals(curve) ? sharp(p) : p;
            out = Math.cos(q * Math.PI / 2);
            in = Math.sin(q * Math.PI / 2);
        }
        out *= Math.pow(10, Math.min(0, outDb) * p / 20);
        in *= Math.pow(10, Math.min(0, inDb) * (1 - p) / 20);
        return new float[] {(float) Math.max(0, Math.min(1, out)), (float) Math.max(0, Math.min(1, in))};
    }

    /** A logistic step through the midpoint, normalised to 0..1. */
    static double sharp(double p) {
        double lo = 1 / (1 + Math.exp(5)), hi = 1 / (1 + Math.exp(-5));
        return (1 / (1 + Math.exp(-10 * (p - 0.5))) - lo) / (hi - lo);
    }

    private double dbl(String key) {
        Object v = plan == null ? null : plan.get(key);
        return v instanceof Number ? ((Number) v).doubleValue() : 0;
    }

    private void handoffNow() {
        if (handedOff || nextItem == null) return;
        handedOff = true;
        int before = primary;
        primary = inDeck;
        cores[primary].setStandby(false);
        cores[before].setStandby(true);
        host.onLogicalDeck(primary);
        if (!controller.onHandoff(planGen, nextItem.uid)) { // the queue moved on meanwhile: undo, A stays current
            primary = before;
            // 5.4.1: give the decks their roles back. 5.4 left the deck still playing flagged as the standby,
            // so it stopped retrying network errors (a blip then ended the song) and capped its buffer.
            cores[primary].setStandby(false);
            cores[inDeck].setStandby(true);
            host.onLogicalDeck(primary);
            record("handoff refused (queue changed)");
            cancelled++;
            cancel("queue changed");
            return;
        }
        handoffAt = cores[outDeck].positionMs();
        if (current != null) current.put("handoffAtMs", handoffAt);
        host.log("PandaDJ logical_handoff " + nextItem.trackId());
        record("logical_handoff " + nextItem.trackId());
    }

    private void finish() {
        if (!running) return;
        cores[outDeck].stop(); // the outgoing deck stops and becomes the standby (its decoder is released)
        setVol(outDeck, userVolume);
        setVol(inDeck, userVolume);
        running = false;
        preloaded = false;
        handedOff = false;
        progress = 0;
        record("transition_complete");
        if (current != null) {
            current.put("completedMs", Math.max(0, cores[inDeck].positionMs() - num("incoming_start_ms", 0)));
            recordHistory(current, degradation);
            current = null;
        }
        nextItem = null;
        plan = null;
        if (queuedNext != null) {
            QueueItem n = queuedNext;
            Map<String, Object> p = queuedPlan;
            queuedNext = null;
            queuedPlan = null;
            prepareNext(queuedGen, n, p);
        }
    }

    private void recordHistory(Map<String, Object> entry, String degraded) {
        Map<String, Object> e = entry != null ? entry : new LinkedHashMap<>();
        if (entry == null && plan != null && nextItem != null) {
            e.put("to", nextItem.trackId());
            e.put("plan", String.valueOf(plan.get("summary")));
            e.put("tier", plan.get("tier"));
            e.put("plannedMs", num("overlap_ms", 0));
            e.put("effectiveMs", 0L);
        }
        e.put("outcome", entry != null ? "completed" : "plain handoff");
        if (degraded != null) e.put("degraded", degraded);
        transitionLog.addFirst(e);
        while (transitionLog.size() > HISTORY) transitionLog.removeLast();
    }

    /** Recent transitions as readable lines (newest first). */
    java.util.List<String> historyLines() {
        java.util.List<String> lines = new java.util.ArrayList<>();
        for (Map<String, Object> e : transitionLog) {
            StringBuilder b = new StringBuilder();
            b.append(e.getOrDefault("from", "?")).append(" → ").append(e.getOrDefault("to", "?")).append(" · ").append(e.getOrDefault("plan", ""));
            if (e.get("tier") != null) b.append(" · ").append(e.get("tier"));
            b.append(String.format(java.util.Locale.ROOT, " · planned %.1f s", ((Number) e.getOrDefault("plannedMs", 0L)).longValue() / 1000.0));
            if ("completed".equals(e.get("outcome"))) {
                b.append(String.format(java.util.Locale.ROOT, " · actual %.1f s · start late %d ms",
                    ((Number) e.getOrDefault("effectiveMs", 0L)).longValue() / 1000.0, ((Number) e.getOrDefault("lateMs", 0L)).longValue()));
                Object buf = e.get("bufferedAtStartMs");
                if (buf instanceof Number && ((Number) buf).longValue() >= 0) b.append(String.format(java.util.Locale.ROOT, " · buffered %.1f s", ((Number) buf).longValue() / 1000.0));
                if (e.get("confidence") != null) b.append(" · confidence ").append(e.get("confidence"));
            } else {
                b.append(" · ").append(e.get("outcome"));
            }
            if (e.get("degraded") != null) b.append(" · ").append(e.get("degraded"));
            lines.add(b.toString());
        }
        return lines;
    }

    /** Drop any pending or running transition: the logical deck plays alone at full volume. */
    void cancel(String why) {
        queuedNext = null;
        queuedPlan = null;
        boolean listener = "load".equals(why) || "seek".equals(why) || "stop".equals(why);
        if (running) {
            int stray = primary == outDeck ? inDeck : outDeck;
            cores[stray].stop();
            setVol(stray, 0f);
            record("transition cancelled: " + why);
            if (!listener) cancelled++;
        } else if (preloaded) {
            cores[other()].stop();
            record("preload dropped: " + why);
        }
        if (!listener && (running || preloaded || nextItem != null)) note(why);
        running = false;
        preloaded = false;
        handedOff = false;
        progress = 0;
        nextItem = null; // seekTo re-arms its own pair; otherwise the queue re-plans on its next change
        plan = null;
        setVol(primary, userVolume);
    }

    private void resetStandby() {
        if (preloaded && !running) cores[other()].stop();
        preloaded = false;
    }

    private void note(String reason) {
        lastReason = reason;
        record(reason);
        host.log("PandaDJ " + reason);
    }

    private void volumes(float primaryGain, float standbyGain) {
        setVol(primary, userVolume * primaryGain);
        setVol(other(), userVolume * standbyGain);
    }

    private void record(String what) {
        String stamp = new SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date(host.nowMs()));
        history.addLast(stamp + " PandaDJ " + what);
        while (history.size() > EngineCore.HISTORY) history.removeFirst();
    }

    int primaryDeck() {
        return primary;
    }

    boolean running() {
        return running;
    }

    /** Settings › Diagnostics: the logical deck's facts plus the mix (no URLs, no tokens). */
    Map<String, Object> diagnostics() {
        Map<String, Object> m = new LinkedHashMap<>(cores[primary].diagnostics());
        m.put("pandaMix", plan != null || running ? "active" : nextItem == null ? "idle" : "active");
        m.put("logicalDeck", primary == 0 ? "A" : "B");
        for (int d = 0; d < 2; d++) {
            QueueItem it = cores[d].item();
            m.put("deck" + (d == 0 ? "A" : "B"), it == null ? "idle" : it.trackId() + " · " + cores[d].state() + " · " + cores[d].positionMs() / 1000 + "s · vol "
                + Math.round(vol[d] * 100) + "%");
        }
        m.put("standbyReady", preloaded && cores[other()].ready());
        m.put("transitionRunning", running);
        if (plan != null) {
            QueueItem cur = cores[running ? outDeck : primary].item();
            m.put("currentPair", (cur == null ? "?" : cur.trackId()) + " → " + (nextItem == null ? "?" : nextItem.trackId()));
            m.put("transition", plan.get("summary"));
            m.put("planSource", Boolean.TRUE.equals(plan.get("intentional")) ? plan.get("source") + " (intentional " + plan.get("label") + ")" : plan.get("source"));
            m.put("transitionConfidence", plan.get("confidence"));
            m.put("bpmOut", plan.get("bpm_out"));
            m.put("bpmIn", plan.get("bpm_in"));
            m.put("transitionStartMs", num("outgoing_start_ms", 0));
            m.put("overlapMs", running ? effOverlap : num("overlap_ms", 0));
            m.put("transitionProgress", running ? Math.round(progress * 100) + "%" : preloaded ? "preloaded" : "planned");
        }
        m.put("lastTransition", lastPlan);
        m.put("transitionHistory", historyLines());
        if (plan != null) {
            m.put("plannedTier", plan.get("tier"));
            m.put("plannedConfidence", plan.get("confidence"));
            m.put("plannedAlignment", plan.get("aligned"));
            m.put("plannedGains", String.format(java.util.Locale.ROOT, "out %.1f dB · in %.1f dB", dbl("gain_out_db"), dbl("gain_in_db")));
            Object facts = plan.get("facts");
            if (facts instanceof Map) m.put("plannedFacts", String.valueOf(facts));
            Object reasons = plan.get("reasons");
            if (reasons != null) m.put("plannedReasons", String.valueOf(reasons));
        }
        if (running) {
            m.put("transitionLateMs", effStart - plannedStart);
            m.put("transitionBufferedAtStart", bufferedAtStart < 0 ? "downloaded" : String.format(java.util.Locale.ROOT, "%.1f s", bufferedAtStart / 1000.0));
            m.put("transitionDegraded", degradation);
        }
        m.put("lastReason", lastReason);
        m.put("transitionsDone", (long) transitions);
        m.put("warmupState", warmState);
        m.put("warmupTrack", warmItem == null ? null : warmItem.trackId() + " · " + warmItem.title());
        m.put("warmupSource", warmItem == null ? null : sourceOf(warmUri));
        m.put("warmupBuffered", warmLoaded ? String.format(java.util.Locale.ROOT, "~%.1f s", cores[other()].bufferedMs() / 1000.0) : null);
        m.put("standbyDeck", other() == 0 ? "A" : "B");
        m.put("standbyEngineState", cores[other()].item() == null ? "idle" : cores[other()].state());
        m.put("standbyPlaybackState", EngineCore.stateName(ports[other()].playbackState()));
        m.put("standbyTrack", cores[other()].item() == null ? null : cores[other()].item().trackId());
        m.put("logicalSuppression", (long) ports[primary].suppressionReason());
        m.put("logicalFlaggedStandby", cores[primary].isStandby()); // must always be false
        m.put("transitionKinds", "smart " + smart + " · fallback " + fallbacks + " · manual " + manual + " · intentional " + intentional
            + " · cancelled " + cancelled + " · not ready " + notReady);
        java.util.List<Object> events = new ArrayList<>(Json.list(m.get("events")) == null ? new ArrayList<>() : Json.list(m.get("events")));
        events.addAll(history);
        m.put("events", events);
        return m;
    }
}
