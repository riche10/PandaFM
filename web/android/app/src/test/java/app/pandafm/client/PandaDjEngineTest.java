package app.pandafm.client;

import static app.pandafm.client.PlaybackStateModel.STATE_BUFFERING;
import static app.pandafm.client.PlaybackStateModel.STATE_ENDED;
import static app.pandafm.client.PlaybackStateModel.STATE_READY;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.Test;

/** Panda DJ's two decks, driven through the real QueueController with fake players (5.2). */
public class PandaDjEngineTest {
    final EngineCoreTest.FakePort pa = new EngineCoreTest.FakePort(), pb = new EngineCoreTest.FakePort();
    final List<Runnable> delayed = new ArrayList<>();
    final EngineCore.Hooks hooks = new EngineCore.Hooks() {
        public void expireAccessToken() {}
        public String artworkUriFor(String id) { return "content://app.pandafm.client.artwork/cover/" + id; }
        public long nowMs() { return 0; }
    };
    final EngineCore.Logger quiet = new EngineCore.Logger() {
        public void info(String m) {}
        public void warn(String m) {}
    };
    final EngineCore ca = new EngineCore(pa, (t, d) -> delayed.add(t), quiet, hooks), cb = new EngineCore(pb, (t, d) -> delayed.add(t), quiet, hooks);
    final List<Integer> logicalDecks = new ArrayList<>();
    final PandaDjEngine dj = new PandaDjEngine(ca, pa, cb, pb, (t, d) -> {}, new PandaDjEngine.Host() {
        public String uriFor(QueueItem item) { return "https://music.example.com/api/tracks/" + item.trackId() + "/stream"; }
        public void onLogicalDeck(int deck) { logicalDecks.add(deck); }
        public void log(String m) {}
        public long nowMs() { return 0; }
    });
    final List<Map<String, Object>> events = new ArrayList<>();
    int ids;
    final QueueController controller = new QueueController(new NativeQueue(() -> "u" + (++ids), new Random(2)), dj,
        item -> "https://music.example.com/api/tracks/" + item.trackId() + "/stream",
        new QueueController.Store() {
            public void save(String json) {}
            public String load() { return null; }
        },
        events::add,
        new QueueController.Radio() {
            public void start(String p, String k, String i, QueueController.Callback d) {}
            public void extend(String s, List<Long> u, int t, QueueController.Callback d) {}
            public void check(String s, QueueController.Callback d) {}
        },
        new QueueController.Env() {
            public long nowMs() { return 0; }
            public String newId() { return "id" + (++ids); }
            public boolean online() { return true; }
        });
    final List<String> planned = new ArrayList<>();

    {
        dj.attach(controller);
        controller.setMixPlans((from, to, mode, playlist, window) -> {
            planned.add(from.trackId() + "→" + to.trackId());
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("type", "smooth_blend");
            p.put("summary", "Smooth Blend · 10 sec");
            p.put("outgoing_start_ms", 190_000L);
            p.put("incoming_start_ms", 2_000L);
            p.put("overlap_ms", 10_000L);
            p.put("curve", "equal_power");
            p.put("confidence", 0.8);
            return p;
        });
    }

    static Map<String, Object> mix() {
        Map<String, Object> s = NativeQueueTest.source("playlist", "Mix");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("mode", "auto");
        m.put("playlistId", "p1");
        s.put("mix", m);
        return s;
    }

    EngineCoreTest.FakePort port(int deck) {
        return deck == 0 ? pa : pb;
    }

    EngineCore core(int deck) {
        return deck == 0 ? ca : cb;
    }

    void playing(int deck, long ms) {
        EngineCoreTest.FakePort p = port(deck);
        p.state = STATE_READY;
        p.playing = p.pwr;
        p.position = ms;
        core(deck).onPlayerChanged();
    }

    void at(long ms) { // the outgoing deck's clock reaches ms (the incoming deck moves along with it)
        int out = dj.running() ? (logicalDecks.isEmpty() || dj.primaryDeck() == lastOut ? dj.primaryDeck() : 1 - dj.primaryDeck()) : dj.primaryDeck();
        port(out).position = ms;
        dj.tick();
    }

    int lastOut;

    void startMix(String... ids) {
        controller.replace(NativeQueueTest.tracks(ids), 0, mix(), false, true);
        playing(0, 0);
        assertEquals("playing", controller.status);
    }

    /** Run one whole transition from the current deck to the other, on the plan's timings. */
    void blend(int from) {
        lastOut = from;
        port(from).position = 178_500;
        dj.tick(); // preload
        int to = 1 - from;
        port(to).state = STATE_READY;
        core(to).onPlayerChanged();
        port(from).position = 190_000;
        dj.tick(); // transition starts
        port(to).playing = true;
        for (long t = 192_500; t <= 200_000; t += 2_500) {
            port(from).position = t;
            dj.tick();
        }
    }

    List<String> types() {
        List<String> out = new ArrayList<>();
        for (Map<String, Object> e : events) out.add(e.get("type") + ":" + ((Map<?, ?>) e.get("track")).get("id"));
        return out;
    }

    @Test
    public void aBlendPreloadsCrossesOverHandsOffAndCompletes() {
        startMix("a", "b", "c");
        assertEquals(Arrays.asList("a→b"), planned);
        pa.position = 170_000;
        dj.tick();
        assertTrue(pb.calls.isEmpty()); // too early to preload
        pa.position = 178_500;
        dj.tick();
        assertEquals(Arrays.asList("setMediaItem track:b @2000", "playWhenReady false", "prepare"), pb.calls); // silent, paused, at its planned start
        assertEquals(0f, pb.volume, 0f);
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 190_000;
        dj.tick();
        assertTrue(pb.pwr && dj.running());
        pb.playing = true;
        pa.position = 192_500;
        dj.tick(); // a quarter of the way
        assertEquals(1.0, pa.volume * pa.volume + pb.volume * pb.volume, 1e-4); // equal power: no dip
        assertEquals("a", controller.queue.current().trackId());
        pa.position = 195_000;
        dj.tick(); // midpoint: B becomes the current song
        assertEquals("b", controller.queue.current().trackId());
        assertEquals(Arrays.asList(1), logicalDecks); // the lock screen / car follow deck B
        assertEquals(controller.gen, cb.generation());
        assertEquals(Arrays.asList("play_started:a", "play_completed:a", "play_started:b"), types());
        pa.position = 200_000;
        dj.tick();
        assertFalse(dj.running());
        assertTrue(pa.calls.contains("stop")); // the outgoing deck is released and becomes the standby
        assertEquals(1f, pb.volume, 0f);
        assertEquals(Arrays.asList("a→b", "b→c"), planned); // and the next pair is planned
    }

    @Test
    public void aLongMixAdvancesExactlyOncePerSongAndLeaksNothing() {
        startMix("a", "b", "c", "d", "e");
        int deck = 0;
        for (String next : new String[] {"b", "c", "d", "e"}) {
            blend(deck);
            deck = 1 - deck;
            assertEquals(next, controller.queue.current().trackId());
            playing(deck, 10_000);
        }
        assertEquals(4, controller.queue.index);
        assertEquals(Arrays.asList("play_started:a", "play_completed:a", "play_started:b", "play_completed:b", "play_started:c",
            "play_completed:c", "play_started:d", "play_completed:d", "play_started:e"), types());
        long loadsA = pa.calls.stream().filter(c -> c.startsWith("setMediaItem")).count(), loadsB = pb.calls.stream().filter(c -> c.startsWith("setMediaItem")).count();
        assertEquals(5, loadsA + loadsB); // each song loaded once, alternating decks
        assertEquals(Arrays.asList(1, 0, 1, 0), logicalDecks);
    }

    @Test
    public void incomingBufferingNeverPausesTheMix() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 190_000;
        dj.tick();
        pb.state = STATE_BUFFERING;
        pb.playing = false;
        cb.onPlayerChanged(); // B stalls while A still plays
        assertEquals("playing", controller.status);
        assertTrue(controller.intendsToPlay());
    }

    @Test
    public void anIncomingFailureFallsBackToANormalHandoff() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick();
        cb.onError(4001, "ERROR_CODE_DECODER_INIT_FAILED"); // B can't play
        assertTrue(pb.calls.contains("stop"));
        assertTrue(pa.pwr && pa.volume == 1f); // A plays on, untouched
        assertEquals("playing", controller.status);
        pa.state = STATE_ENDED;
        ca.onEnded(); // A ends: the queue advances the ordinary way
        assertEquals("b", controller.queue.current().trackId());
    }

    @Test
    public void anIncomingDeckThatIsntReadyInTimeIsDropped() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_BUFFERING;
        pa.position = 190_000;
        for (int k = 0; k < 40; k++) dj.tick(); // 1.6 s of waiting
        assertFalse(dj.running());
        assertTrue(pb.calls.contains("stop"));
        assertEquals(1f, pa.volume, 0f);
        assertEquals("a", controller.queue.current().trackId());
    }

    @Test
    public void anOutgoingFailureMidBlendHandsOverAtOnce() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 190_000;
        dj.tick();
        pb.playing = true;
        ca.onError(4001, "ERROR_CODE_DECODER_INIT_FAILED");
        assertEquals("b", controller.queue.current().trackId());
        assertFalse(dj.running());
    }

    @Test
    public void nextDuringTheOverlapGoesToTheSongAlreadyFadingIn() {
        startMix("a", "b", "c");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 191_000;
        dj.tick();
        pb.playing = true;
        controller.next(); // before the midpoint
        assertEquals("b", controller.queue.current().trackId());
        assertEquals(1, pb.calls.stream().filter(c -> c.startsWith("setMediaItem")).count()); // B wasn't restarted
        assertTrue(pa.calls.contains("stop")); // no ghost A
        assertEquals(1, types().stream().filter(t -> t.equals("play_started:b")).count());
        assertEquals(1f, pb.volume, 0f);
    }

    @Test
    public void nextAfterTheHandoffStopsTheFadingSong() {
        startMix("a", "b", "c");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 190_000;
        dj.tick();
        pb.playing = true;
        pa.position = 196_000;
        dj.tick(); // past the midpoint: B is current, A still fading
        assertEquals("b", controller.queue.current().trackId());
        pa.calls.clear();
        controller.next();
        assertEquals("c", controller.queue.current().trackId());
        assertTrue(pa.calls.contains("stop")); // the fading A is gone at once
        assertFalse(dj.running());
    }

    @Test
    public void pausingABlendFreezesBothDecksAndResumeContinues() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 190_000;
        dj.tick();
        pb.playing = true;
        pa.position = 192_500;
        dj.tick();
        float va = pa.volume, vb = pb.volume;
        controller.pause();
        assertFalse(pa.pwr || pb.pwr);
        pa.playing = pb.playing = false;
        dj.tick();
        assertEquals(va, pa.volume, 0f);
        assertEquals(vb, pb.volume, 0f); // the automation waits
        controller.play();
        assertTrue(pa.pwr && pb.pwr);
        pa.playing = pb.playing = true;
        pa.position = 194_000;
        dj.tick();
        assertTrue(pb.volume > vb); // and carries on from where it was
    }

    @Test
    public void seekingCancelsTheTransition() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 190_000;
        dj.tick();
        controller.seekTo(60_000);
        assertFalse(dj.running());
        assertTrue(pb.calls.contains("stop"));
        assertEquals(1f, pa.volume, 0f);
        assertEquals(60_000, pa.position);
    }

    @Test
    public void aQueueEditReplansOnlyThatPair() {
        startMix("a", "b", "c");
        pa.position = 178_500;
        dj.tick(); // B preloaded
        controller.playNext(NativeQueueTest.tracks("x"));
        assertTrue(pb.calls.contains("stop")); // the preloaded B is dropped
        assertEquals("a→x", planned.get(planned.size() - 1));
    }

    @Test
    public void normalPlayNeverTouchesTheSecondDeck() {
        controller.replace(NativeQueueTest.tracks("a", "b"), 0, NativeQueueTest.source("playlist", "Mix"), false, true);
        playing(0, 0);
        for (long t = 170_000; t <= 200_000; t += 2_000) {
            pa.position = t;
            dj.tick();
        }
        pa.state = STATE_ENDED;
        ca.onEnded();
        assertEquals("b", controller.queue.current().trackId());
        assertTrue(pb.calls.isEmpty()); // exactly the 5.1 single-deck path
        assertTrue(planned.isEmpty());
    }

    @Test
    public void repeatOnePlansNoTransition() {
        startMix("a", "b");
        controller.cycleRepeat(); // all (still continues to b: planned)
        controller.cycleRepeat(); // one: the same song again, no transition
        assertEquals("one", controller.queue.repeat);
        planned.clear();
        pa.position = 185_000;
        dj.tick();
        assertTrue(pb.calls.isEmpty());
        assertTrue(planned.isEmpty());
    }

    @Test
    public void nothingMovesAfterRelease() {
        startMix("a", "b");
        dj.release();
        controller.release();
        pa.calls.clear();
        pa.position = 190_000;
        dj.tick();
        ca.onEnded();
        assertTrue(pa.calls.isEmpty() && pb.calls.isEmpty());
    }

    @Test
    public void equalPowerHasNoDipAtTheMidpoint() {
        float[] mid = PandaDjEngine.gains(0.5, "equal_power");
        assertEquals(Math.sqrt(0.5), mid[0], 1e-6);
        assertEquals(1.0, mid[0] * mid[0] + mid[1] * mid[1], 1e-6);
        float[] lin = PandaDjEngine.gains(0.25, "linear");
        assertEquals(0.75f, lin[0], 1e-6f);
    }

    @Test
    public void theFallbackPlanIsASafeShortBlend() {
        QueueItem a = new QueueItem("u", NativeQueueTest.track("a"), "context", null, null); // 200 s
        Map<String, Object> p = MixFallback.plan(a, new QueueItem("v", NativeQueueTest.track("b"), "context", null, null), "auto");
        assertEquals(196_000L, p.get("outgoing_start_ms"));
        assertEquals(4_000L, p.get("overlap_ms"));
        assertEquals(Boolean.FALSE, p.get("ready"));
    }

    @Test
    public void theServiceStillRegistersItsSessionForForegroundPlayback() throws Exception {
        String src = new String(Files.readAllBytes(Paths.get("src/main/java/app/pandafm/client/PlaybackService.java")), "UTF-8");
        assertTrue("addSession(session) must stay: without it the service isn't a foreground media service (the 5.0.1 bug)", src.contains("addSession(session);"));
        assertEquals(Collections.emptyList(), Collections.emptyList());
    }
}
