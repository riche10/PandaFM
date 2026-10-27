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
    }

    static final long PRELOAD_MS = 12_000, TICK_MS = 40, READY_GRACE_MS = 1_500;

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
    private long waitedMs;
    private double progress;
    private int transitions;
    private final ArrayDeque<String> history = new ArrayDeque<>();

    PandaDjEngine(EngineCore a, EngineCore.PlayerPort pa, EngineCore b, EngineCore.PlayerPort pb, EngineCore.Scheduler scheduler, Host host) {
        cores = new EngineCore[] {a, b};
        ports = new EngineCore.PlayerPort[] {pa, pb};
        this.scheduler = scheduler;
        this.host = host;
        a.attach(new DeckSink(0));
        b.attach(new DeckSink(1));
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
            } else { // B failed to load or play: A carries on and ends normally
                record("incoming error: " + message + " → normal handoff");
                cancel("incoming failed");
            }
        }
    }

    // ── what the queue asks for ──
    @Override
    public void load(int gen, QueueItem item, String uri, long startMs, boolean play) {
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

    @Override
    public void seekTo(long ms) {
        cancel("seek"); // correctness over a clever transition: re-planned from the new position
        cores[primary].seekTo(ms);
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
        if (!running) ports[primary].setVolume(userVolume);
    }

    @Override
    public void prepareNext(int forGen, QueueItem next, Map<String, Object> newPlan) {
        if (released) return;
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
        if (ticking || released || (nextItem == null && !running)) return;
        ticking = true;
        scheduler.postDelayed(this::tick, TICK_MS);
    }

    void tick() {
        ticking = false;
        if (released) return;
        if (running) {
            if (!paused) automate();
        } else if (nextItem != null && plan != null && PlaybackStateModel.intendsToPlay(cores[primary].state())) {
            long pos = cores[primary].positionMs();
            long start = num("outgoing_start_ms", Long.MAX_VALUE);
            if (!preloaded && pos >= start - PRELOAD_MS) preload();
            if (preloaded && pos >= start) {
                if (cores[other()].ready()) begin(pos);
                else if ((waitedMs += TICK_MS) >= READY_GRACE_MS) cancel("incoming not ready in time"); // A just plays to its end
            }
        }
        tickSoon();
    }

    private void preload() {
        String uri = host.uriFor(nextItem);
        preloaded = true;
        waitedMs = 0;
        if (uri == null) { // offline and not downloaded: no transition; the queue handles it at A's end
            record("no source for the next song; normal handoff");
            nextItem = null;
            return;
        }
        ports[other()].setVolume(0f);
        cores[other()].load(planGen, nextItem, uri, num("incoming_start_ms", 0), false);
        host.log("PandaDJ preload deck=" + (other() == 0 ? "A" : "B") + " track=" + nextItem.trackId());
        record("preload " + nextItem.trackId() + " (" + plan.get("type") + ")");
    }

    private void begin(long pos) {
        running = true;
        handedOff = false;
        outDeck = primary;
        inDeck = other();
        progress = 0;
        cores[inDeck].play();
        followerHeld = false;
        transitions++;
        host.log("PandaDJ transition_start " + cores[outDeck].item().trackId() + "→" + nextItem.trackId() + " type=" + plan.get("type") + " overlap=" + num("overlap_ms", 0));
        record("transition_start " + plan.get("type") + " overlap=" + num("overlap_ms", 0) + "ms");
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
        long overlap = num("overlap_ms", 0);
        long start = num("outgoing_start_ms", 0);
        long pos = cores[outDeck].positionMs();
        progress = overlap <= 0 ? 1.0 : Math.max(0, Math.min(1, (pos - start) / (double) overlap));
        float[] g = gains(progress, String.valueOf(plan.get("curve")));
        ports[outDeck].setVolume(userVolume * g[0]);
        ports[inDeck].setVolume(userVolume * g[1]);
        if (progress >= 0.5 && !handedOff) handoffNow();
        if (running && progress >= 1.0) finish();
    }

    /** Equal-power (no dip at the midpoint) or linear gains for outgoing and incoming. */
    static float[] gains(double p, String curve) {
        p = Math.max(0, Math.min(1, p));
        if ("linear".equals(curve)) return new float[] {(float) (1 - p), (float) p};
        return new float[] {(float) Math.cos(p * Math.PI / 2), (float) Math.sin(p * Math.PI / 2)};
    }

    private void handoffNow() {
        if (handedOff || nextItem == null) return;
        handedOff = true;
        int before = primary;
        primary = inDeck;
        host.onLogicalDeck(primary);
        if (!controller.onHandoff(planGen, nextItem.uid)) { // the queue moved on meanwhile: undo, A stays current
            primary = before;
            host.onLogicalDeck(primary);
            record("handoff refused (queue changed)");
            cancel("queue changed");
            return;
        }
        host.log("PandaDJ logical_handoff " + nextItem.trackId());
        record("logical_handoff " + nextItem.trackId());
    }

    private void finish() {
        if (!running) return;
        cores[outDeck].stop(); // the outgoing deck stops and becomes the standby (its decoder is released)
        ports[outDeck].setVolume(userVolume);
        ports[inDeck].setVolume(userVolume);
        running = false;
        preloaded = false;
        handedOff = false;
        progress = 0;
        record("transition_complete");
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

    /** Drop any pending or running transition: the logical deck plays alone at full volume. */
    void cancel(String why) {
        queuedNext = null;
        queuedPlan = null;
        if (running) {
            int stray = primary == outDeck ? inDeck : outDeck;
            cores[stray].stop();
            ports[stray].setVolume(0f);
            record("transition cancelled: " + why);
        } else if (preloaded) {
            cores[other()].stop();
            record("preload dropped: " + why);
        }
        running = false;
        preloaded = false;
        handedOff = false;
        waitedMs = 0;
        progress = 0;
        if (!"load".equals(why) && !"seek".equals(why) && !"stop".equals(why)) {
            nextItem = null; // this pair is done for now; the queue re-plans on its next change
            plan = null;
        } else {
            nextItem = null;
            plan = null;
        }
        ports[primary].setVolume(userVolume);
    }

    private void resetStandby() {
        if (preloaded && !running) cores[other()].stop();
        preloaded = false;
        waitedMs = 0;
    }

    private void volumes(float primaryGain, float standbyGain) {
        ports[primary].setVolume(userVolume * primaryGain);
        ports[other()].setVolume(userVolume * standbyGain);
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
        m.put("pandaMix", plan != null || running ? "active" : "idle");
        m.put("logicalDeck", primary == 0 ? "A" : "B");
        for (int d = 0; d < 2; d++) {
            QueueItem it = cores[d].item();
            m.put("deck" + (d == 0 ? "A" : "B"), it == null ? "idle" : it.trackId() + " · " + cores[d].state() + " · " + cores[d].positionMs() / 1000 + "s");
        }
        if (plan != null) {
            m.put("transition", plan.get("summary"));
            m.put("transitionConfidence", plan.get("confidence"));
            m.put("transitionProgress", running ? Math.round(progress * 100) + "%" : preloaded ? "preloaded" : "planned");
        }
        m.put("transitionsDone", (long) transitions);
        java.util.List<Object> events = new ArrayList<>(Json.list(m.get("events")) == null ? new ArrayList<>() : Json.list(m.get("events")));
        events.addAll(history);
        m.put("events", events);
        return m;
    }
}
