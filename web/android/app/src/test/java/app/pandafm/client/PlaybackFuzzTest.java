package app.pandafm.client;

import static app.pandafm.client.PlaybackStateModel.STATE_BUFFERING;
import static app.pandafm.client.PlaybackStateModel.STATE_ENDED;
import static app.pandafm.client.PlaybackStateModel.STATE_IDLE;
import static app.pandafm.client.PlaybackStateModel.STATE_READY;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.Assert;
import org.junit.Test;

/**
 * 5.4.1: a randomised playback simulation. The real PandaDjEngine, both EngineCores and the real
 * QueueController run against fake players that behave like ExoPlayer (prepare → BUFFERING →
 * READY, errors drop to IDLE, the end is ENDED); time, stalls, network errors and listener actions
 * happen in random order, in normal playback and in Panda Mix. After every step the invariants
 * that keep music playing and the timeline moving are checked. Seeds are fixed: failures replay.
 */
public class PlaybackFuzzTest {
    static final long SONG_MS = 60_000;

    /** A fake ExoPlayer: the test moves time and the network, the engine moves the player. */
    static final class SimPort implements EngineCore.PlayerPort {
        final String name;
        EngineCore core;
        int state = STATE_IDLE;
        boolean pwr, standbyBuffering, seekable = true;
        long position, duration = SONG_MS;
        float volume = 1f;
        String uri;
        boolean preparedPending;

        SimPort(String name) { this.name = name; }

        public void setVolume(float v) { volume = v; }
        public void setStandbyBuffering(boolean s) { standbyBuffering = s; }
        public long bufferedMs() { return state == STATE_READY ? 30_000 : 0; }
        public void setMediaItem(String id, String u, long startMs, String t, String a, String al, String art) {
            uri = u;
            position = startMs;
            state = STATE_IDLE;
            preparedPending = false;
        }
        public void prepare() { if (uri != null) { state = STATE_BUFFERING; preparedPending = true; } }
        public void setPlayWhenReady(boolean p) { pwr = p; }
        public boolean playWhenReady() { return pwr; }
        public int playbackState() { return state; }
        public boolean isPlaying() { return state == STATE_READY && pwr; }
        public int suppressionReason() { return 0; }
        public long position() { return position; }
        public long duration() { return duration; }
        public boolean seekable() { return seekable; }
        public void seekTo(long ms) { position = Math.max(0, Math.min(ms, duration)); }
        public void stop() { state = STATE_IDLE; uri = null; preparedPending = false; }
    }

    static final class Run {
        final Random rng;
        final boolean mix;
        final SimPort pa = new SimPort("A"), pb = new SimPort("B");
        final List<Runnable> tasks = new ArrayList<>();
        final EngineCore.Hooks hooks = new EngineCore.Hooks() {
            public void expireAccessToken() {}
            public String artworkUriFor(String id) { return null; }
            public long nowMs() { return 0; }
        };
        final EngineCore.Logger quiet = new EngineCore.Logger() {
            public void info(String m) {}
            public void warn(String m) {}
        };
        final EngineCore ca = new EngineCore(pa, (t, d) -> tasks.add(t), quiet, hooks), cb = new EngineCore(pb, (t, d) -> tasks.add(t), quiet, hooks);
        final PandaDjEngine dj;
        final QueueController c;
        final Map<String, Integer> starts = new HashMap<>();
        boolean userPaused;
        int ids;
        final List<String> log = new ArrayList<>();

        Run(long seed, boolean mix) {
            this.rng = new Random(seed);
            this.mix = mix;
            pa.core = ca;
            pb.core = cb;
            dj = new PandaDjEngine(ca, pa, cb, pb, (t, d) -> {}, new PandaDjEngine.Host() {
                public String uriFor(QueueItem item) { return "https://music.example.com/api/tracks/" + item.trackId() + "/stream"; }
                public void onLogicalDeck(int deck) { log.add("logical " + deck); }
                public void log(String m) {}
                public long nowMs() { return 0; }
            });
            c = new QueueController(new NativeQueue(() -> "u" + (++ids), new Random(seed)), dj,
                item -> "https://music.example.com/api/tracks/" + item.trackId() + "/stream",
                new QueueController.Store() {
                    public void save(String json) {}
                    public String load() { return null; }
                },
                e -> {
                    if ("play_started".equals(e.get("type"))) starts.merge(String.valueOf(e.get("play_id")), 1, Integer::sum);
                },
                new QueueController.Radio() {
                    public void start(String p, String k, String i, QueueController.Callback d) {}
                    public void extend(String s, List<Long> u, int t, QueueController.Callback d) {}
                    public void check(String s, QueueController.Callback d) {}
                },
                new QueueController.Env() {
                    public long nowMs() { return 0; }
                    public String newId() { return "p" + (++ids); }
                    public boolean online() { return true; }
                });
            dj.attach(c);
            if (mix) {
                c.setMixPlans((from, to, mode, playlist, window) -> {
                    Map<String, Object> p = new LinkedHashMap<>();
                    p.put("type", "smooth_blend");
                    p.put("summary", "Smooth Blend · 8 sec");
                    p.put("source", rng.nextBoolean() ? "smart" : "fallback");
                    p.put("outgoing_start_ms", 44_000L + rng.nextInt(8) * 1000L);
                    p.put("incoming_start_ms", (long) rng.nextInt(3) * 1000L);
                    p.put("overlap_ms", 4_000L + rng.nextInt(9) * 1000L);
                    p.put("curve", "equal_power");
                    return p;
                });
            }
            List<Map<String, Object>> tracks = NativeQueueTest.tracks("t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8");
            for (Map<String, Object> t : tracks) t.put("duration_seconds", SONG_MS / 1000);
            Map<String, Object> source = NativeQueueTest.source("playlist", "Fuzz");
            if (mix) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("mode", "auto");
                m.put("playlistId", "p1");
                source.put("mix", m);
            }
            c.replace(tracks, 0, source, false, true);
        }

        SimPort port(int deck) { return deck == 0 ? pa : pb; }

        int logical() { return dj.primaryDeck(); }

        /** The adapter's job: tell the deck's core what its player just did. */
        void changed(SimPort p) { p.core.onPlayerChanged(); }

        void step() {
            int r = rng.nextInt(100);
            if (r < 45) { // time passes on every deck that's actually playing
                for (SimPort p : new SimPort[] {pa, pb}) {
                    if (p.state == STATE_READY && p.pwr) {
                        p.position += 500;
                        if (p.position >= p.duration) {
                            p.position = p.duration;
                            p.state = STATE_ENDED;
                            log.add(p.name + " ended");
                            p.core.onEnded();
                        }
                    }
                }
                dj.tick();
            } else if (r < 60) { // a prepared deck becomes ready
                SimPort p = rng.nextBoolean() ? pa : pb;
                if (p.state == STATE_BUFFERING) {
                    p.state = STATE_READY;
                    changed(p);
                }
            } else if (r < 66) { // a short stall
                SimPort p = rng.nextBoolean() ? pa : pb;
                if (p.state == STATE_READY) {
                    p.state = STATE_BUFFERING;
                    log.add(p.name + " stall");
                    changed(p);
                }
            } else if (r < 69) { // a network error on a stream
                SimPort p = rng.nextBoolean() ? pa : pb;
                if (p.uri != null && p.state != STATE_IDLE) {
                    p.state = STATE_IDLE;
                    log.add(p.name + " error");
                    p.core.onError(2001, "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED");
                }
            } else if (r < 72) { // a scheduled retry fires
                if (!tasks.isEmpty()) tasks.remove(0).run();
            } else { // the listener
                int a = rng.nextInt(11);
                log.add("action " + a);
                switch (a) {
                    case 0: c.next(); userPaused = false; break;
                    case 1: c.previous(); break;
                    case 2: c.pause(); userPaused = true; break;
                    case 3: c.play(); userPaused = false; break;
                    case 4: c.seekTo(rng.nextInt((int) SONG_MS)); break;
                    case 5: c.playNext(NativeQueueTest.tracks("x" + (++ids))); break;
                    case 6: c.addToQueue(NativeQueueTest.tracks("y" + (++ids))); break;
                    case 7: if (c.queue.items.size() > c.queue.index + 2) c.remove(c.queue.items.get(c.queue.index + 1 + rng.nextInt(c.queue.items.size() - c.queue.index - 1)).uid); break;
                    case 8: c.toggleShuffle(); break;
                    case 9: c.cycleRepeat(); break;
                    default: if (c.queue.items.size() > 1) { c.jumpTo(c.queue.items.get(rng.nextInt(c.queue.items.size())).uid); userPaused = false; } break;
                }
            }
        }

        void check(int stepNo) {
            int L = logical(), S = 1 - L;
            SimPort lp = port(L), sp = port(S);
            EngineCore lc = L == 0 ? ca : cb, sc = S == 0 ? ca : cb;
            String where = (mix ? "mix" : "normal") + " step " + stepNo + " " + log.subList(Math.max(0, log.size() - 8), log.size());
            boolean running = dj.running();
            if (!running) {
                Assert.assertFalse("the standby deck is audible: " + where, sp.pwr && sp.state == STATE_READY && sp.volume > 0);
                Assert.assertFalse("the standby deck plays outside a blend: " + where, sp.pwr && sp.uri != null);
            }
            Assert.assertFalse("the logical deck is flagged as standby (no retries, capped buffer): " + where, lc.isStandby());
            Assert.assertFalse("the logical deck's buffering is capped as a standby's: " + where, lp.standbyBuffering);
            QueueItem cur = c.queue.current();
            if (cur != null && lc.item() != null && !running) {
                Assert.assertEquals("the logical deck plays a different song than the queue: " + where, cur.uid, lc.item().uid);
            }
            boolean audible = lp.pwr && (lp.state == STATE_READY || lp.state == STATE_BUFFERING);
            if (audible && lc.item() != null && cur != null && !"error".equals(c.status)) {
                Assert.assertTrue("playing but the controller doesn't intend to play (timeline/service stop): status=" + c.status + " " + where, c.intendsToPlay());
            }
            if ("paused".equals(c.status) && !userPaused && lc.item() != null) {
                Assert.assertFalse("a pause nobody asked for: " + where, lp.pwr);
            }
            for (Map.Entry<String, Integer> e : starts.entrySet()) Assert.assertEquals("a song started twice: " + where, 1, (int) e.getValue());
        }
    }

    void fuzz(boolean mix, int runs, int steps) {
        for (long seed = 1; seed <= runs; seed++) {
            Run run = new Run(seed * 7919 + (mix ? 1 : 0), mix);
            run.pa.state = STATE_READY;
            run.changed(run.pa);
            for (int k = 0; k < steps; k++) {
                run.step();
                try {
                    run.check(k);
                } catch (AssertionError e) {
                    throw new AssertionError("seed " + seed + ": " + e.getMessage(), e);
                }
            }
        }
    }

    @Test
    public void normalPlaybackWithWarmupKeepsItsInvariants() {
        fuzz(false, 400, 400);
    }

    @Test
    public void pandaMixKeepsItsInvariants() {
        fuzz(true, 400, 400);
    }
}
