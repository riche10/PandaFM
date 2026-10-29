package app.pandafm.client;

import static app.pandafm.client.PlaybackStateModel.STATE_BUFFERING;
import static app.pandafm.client.PlaybackStateModel.STATE_ENDED;
import static app.pandafm.client.PlaybackStateModel.STATE_IDLE;
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
    final List<String> sessionMoves = new ArrayList<>();
    boolean networkUp = true;
    String quality = "";
    final Map<String, String> local = new LinkedHashMap<>();

    String source(QueueItem item) {
        return local.containsKey(item.trackId()) ? local.get(item.trackId()) : "https://music.example.com/api/tracks/" + item.trackId() + "/stream" + quality;
    }

    final PandaDjEngine dj = new PandaDjEngine(ca, pa, cb, pb, (t, d) -> {}, new PandaDjEngine.Host() {
        public String uriFor(QueueItem item) { return source(item); }
        public boolean online() { return networkUp; }
        public void onLogicalDeck(int deck) {
            logicalDecks.add(deck);
            sessionMoves.add(deck + (port(deck).pwr ? ":playing" : ":paused")); // what Media3 would see at the swap
        }
        public void log(String m) {}
        public long nowMs() { return 0; }
    });
    final List<Map<String, Object>> events = new ArrayList<>();
    int ids;
    final QueueController controller = new QueueController(new NativeQueue(() -> "u" + (++ids), new Random(2)), dj,
        this::source,
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
        pa.position = 160_000;
        dj.tick();
        assertTrue(pb.calls.isEmpty()); // too early to preload (the lead is 20 s)
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
    public void aLateIncomingDeckGetsAShorterBlendNotACut() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_BUFFERING; // e.g. a first play while the server converts it
        pa.position = 190_000;
        dj.tick();
        assertFalse(dj.running()); // waiting; A carries on at full volume
        assertEquals(1f, pa.volume, 0f);
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 194_000;
        dj.tick(); // ready 4 s late: the same ending, a 6 s blend
        assertTrue(dj.running());
        pb.playing = true;
        pa.position = 197_000;
        dj.tick(); // halfway through the shortened blend
        assertEquals("b", controller.queue.current().trackId());
        assertTrue(String.valueOf(dj.diagnostics().get("events")).contains("late start"));
    }

    @Test
    public void anIncomingDeckThatNeverGetsReadyIsDroppedAndExplained() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_BUFFERING;
        pa.position = 190_000;
        dj.tick();
        pa.position = 199_000; // no room left for a blend
        dj.tick();
        assertFalse(dj.running());
        assertTrue(pb.calls.contains("stop"));
        assertEquals(1f, pa.volume, 0f);
        assertEquals("a", controller.queue.current().trackId());
        Map<String, Object> d = dj.diagnostics();
        assertEquals("incoming deck not ready", d.get("lastReason"));
        assertTrue(String.valueOf(d.get("transitionKinds")).contains("not ready 1"));
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
    public void seekingDuringABlendCancelsItAndReArmsThePair() {
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
        pb.calls.clear();
        pa.position = 178_500;
        dj.tick(); // the same pair is prepared again (5.2 forgot it: a plain handoff)
        assertTrue(pb.calls.contains("setMediaItem track:b @2000"));
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 190_000;
        dj.tick();
        assertTrue(dj.running());
    }

    @Test
    public void seekingPastTheTransitionSkipsItWithAReason() {
        startMix("a", "b");
        controller.seekTo(199_500);
        dj.tick();
        assertTrue(pb.calls.isEmpty());
        assertEquals("seeked past the transition; this song ends normally", dj.diagnostics().get("lastReason"));
    }

    @Test
    public void withNoSmartPlanTheFallbackCrossfadeReallyPlays() {
        controller.setMixPlans((from, to, mode, playlist, window) -> MixFallback.plan(from, to, mode)); // offline, nothing analysed
        startMix("a", "b"); // 200 s songs: a 5 s blend from 192 s (ending 3 s before the end)
        pa.position = 172_500;
        dj.tick();
        assertTrue(pb.calls.contains("setMediaItem track:b @0"));
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 192_000;
        dj.tick();
        assertTrue(dj.running());
        pb.playing = true;
        pa.position = 193_250;
        dj.tick(); // a quarter in: both decks clearly audible
        assertTrue(pa.volume > 0.9f && pb.volume > 0.35f);
        pa.position = 194_500;
        dj.tick();
        assertEquals("b", controller.queue.current().trackId());
        Map<String, Object> d = dj.diagnostics();
        assertEquals("fallback", d.get("planSource"));
        assertTrue(String.valueOf(d.get("transitionKinds")).startsWith("smart 0 · fallback 1"));
    }

    @Test
    public void anIntentionalCleanHandoffIsNotAFailure() {
        controller.setMixPlans((from, to, mode, playlist, window) -> {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("type", "clean_handoff");
            p.put("label", "Clean Handoff");
            p.put("summary", "Clean Handoff · 2 sec");
            p.put("source", "smart");
            p.put("intentional", Boolean.TRUE);
            p.put("outgoing_start_ms", 196_000L);
            p.put("incoming_start_ms", 0L);
            p.put("overlap_ms", 2_000L);
            p.put("curve", "equal_power");
            return p;
        });
        startMix("a", "b");
        blend(0);
        assertEquals("b", controller.queue.current().trackId());
        String kinds = String.valueOf(dj.diagnostics().get("transitionKinds"));
        assertTrue(kinds, kinds.contains("intentional 1") && kinds.contains("cancelled 0") && kinds.contains("not ready 0"));
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
    public void normalPlayOnlyWarmsTheSecondDeckNeverMixes() {
        controller.replace(NativeQueueTest.tracks("a", "b"), 0, NativeQueueTest.source("playlist", "Mix"), false, true);
        playing(0, 0);
        for (long t = 170_000; t <= 200_000; t += 2_000) {
            pa.position = t;
            dj.tick();
        }
        assertFalse(pb.calls.contains("playWhenReady true")); // warm, never audible before the song changes
        assertEquals(0f, pb.volume, 0f);
        assertFalse(dj.running());
        assertTrue(planned.isEmpty()); // no Panda Mix plan: no crossfade
        pa.state = STATE_ENDED;
        ca.onEnded();
        assertEquals("b", controller.queue.current().trackId());
    }

    // ── 5.4 next-track warmup ──
    void playNormal(String... ids) {
        controller.replace(NativeQueueTest.tracks(ids), 0, NativeQueueTest.source("playlist", "Mix"), false, true);
        playing(0, 0);
    }

    void warmB() {
        pa.position = 2_500;
        dj.tick();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        dj.tick();
    }

    long loads(EngineCoreTest.FakePort port, String id) {
        return port.calls.stream().filter(c -> c.startsWith("setMediaItem track:" + id + " ")).count();
    }

    @Test
    public void ordinaryPlaybackWarmsTheNextSongSilently() {
        playNormal("a", "b", "c");
        pa.position = 1_000;
        dj.tick();
        assertTrue(pb.calls.isEmpty()); // the current song settles first
        warmB();
        assertEquals(Arrays.asList("setMediaItem track:b @0", "playWhenReady false", "prepare"), pb.calls);
        assertEquals(0f, pb.volume, 0f);
        assertEquals(Arrays.asList("play_started:a"), types()); // no play event, no scrobble for the warm song
        assertEquals(0, controller.queue.index);
        assertTrue(logicalDecks.isEmpty()); // the session stays with the current song
        Map<String, Object> d = dj.diagnostics();
        assertEquals("ready", d.get("warmupState"));
        assertEquals("Original", d.get("warmupSource"));
        assertEquals("B", d.get("standbyDeck"));
    }

    @Test
    public void nextAdoptsTheWarmDeckInsteadOfReloading() {
        playNormal("a", "b", "c");
        warmB();
        controller.next();
        assertEquals("b", controller.queue.current().trackId());
        assertEquals(1, loads(pb, "b")); // the prepared decoder is kept
        assertTrue(pb.pwr && pb.volume == 1f);
        assertTrue(pa.calls.contains("stop")); // the old song lets go; that deck becomes the standby
        assertEquals(Arrays.asList(1), logicalDecks);
        pb.playing = true;
        playing(1, 0);
        assertEquals("playing", controller.status);
        assertEquals(1, types().stream().filter(t -> t.equals("play_started:b")).count());
        pb.position = 2_500;
        dj.tick(); // and the following song warms on the other deck
        assertTrue(pa.calls.contains("setMediaItem track:c @0"));
        assertTrue(String.valueOf(dj.diagnostics().get("events")).contains("warmup adopted b"));
    }

    @Test
    public void aNaturalEndAdoptsTheWarmDeckWithoutAMix() {
        playNormal("a", "b");
        warmB();
        pa.state = STATE_ENDED;
        ca.onEnded();
        assertEquals("b", controller.queue.current().trackId());
        assertEquals(1, loads(pb, "b"));
        assertFalse(dj.running());
    }

    @Test
    public void aQueueChangeInvalidatesTheWarmup() {
        playNormal("a", "b", "c");
        warmB();
        controller.playNext(NativeQueueTest.tracks("x"));
        assertTrue(pb.calls.contains("stop")); // b is no longer next
        dj.tick();
        assertEquals(1, loads(pb, "x"));
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        controller.next();
        assertEquals("x", controller.queue.current().trackId());
        assertEquals(1, loads(pb, "x")); // never the stale b
        assertTrue(String.valueOf(dj.diagnostics().get("events")).contains("warmup invalidated: queue changed"));
    }

    @Test
    public void aDifferentSourceAtNextTimeLoadsNormally() {
        playNormal("a", "b");
        warmB();
        quality = "?quality=low"; // e.g. the phone moved to mobile data with Data Saver
        controller.next();
        assertEquals(1, loads(pa, "b")); // loaded fresh with the right source
        assertTrue(pb.calls.contains("stop"));
        assertTrue(logicalDecks.isEmpty());
    }

    @Test
    public void aFailedWarmupNeverBlocksNext() {
        playNormal("a", "b");
        warmB();
        cb.onError(2001, "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED");
        assertEquals("failed", dj.diagnostics().get("warmupState"));
        controller.next();
        assertEquals("b", controller.queue.current().trackId());
        assertEquals(1, loads(pa, "b")); // the ordinary load path
    }

    @Test
    public void offlineAndNotDownloadedIsNeverWarmed() {
        networkUp = false;
        playNormal("a", "b");
        pa.position = 2_500;
        dj.tick();
        assertTrue(pb.calls.isEmpty()); // no stream opened, nothing retried
        assertEquals("failed", dj.diagnostics().get("warmupState"));
    }

    @Test
    public void aDownloadedNextSongWarmsItsLocalFileEvenOffline() {
        networkUp = false;
        local.put("b", "content://tree/PandaFM/b.flac");
        playNormal("a", "b");
        pa.position = 2_500;
        dj.tick();
        assertEquals(1, loads(pb, "b"));
        assertEquals("content://tree/PandaFM/b.flac", pb.uri);
        assertEquals("downloaded", dj.diagnostics().get("warmupSource"));
    }

    @Test
    public void repeatOneWarmsNothing() {
        playNormal("a", "b");
        controller.cycleRepeat();
        controller.cycleRepeat(); // one
        pb.calls.clear();
        pa.position = 2_500;
        dj.tick();
        assertTrue(pb.calls.isEmpty());
    }

    @Test
    public void nextBeforeABlendAdoptsTheMixPreload() {
        startMix("a", "b");
        pa.position = 178_500;
        dj.tick(); // b preloaded at its planned start (2 s in)
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        controller.next();
        assertEquals("b", controller.queue.current().trackId());
        assertEquals(1, loads(pb, "b"));
        assertTrue(pb.calls.contains("seekTo 0")); // from the top, as Next means
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
        assertEquals(192_000L, p.get("outgoing_start_ms")); // 5 s, ending 3 s before the end (out of the tail)
        assertEquals(5_000L, p.get("overlap_ms"));
        assertEquals(Boolean.FALSE, p.get("ready"));
        assertEquals("fallback", p.get("source"));
    }

    @Test
    public void theServiceStillRegistersItsSessionForForegroundPlayback() throws Exception {
        String src = new String(Files.readAllBytes(Paths.get("src/main/java/app/pandafm/client/PlaybackService.java")), "UTF-8");
        assertTrue("addSession(session) must stay: without it the service isn't a foreground media service (the 5.0.1 bug)", src.contains("addSession(session);"));
        assertEquals(Collections.emptyList(), Collections.emptyList());
    }

    // ── 5.4.1: the standby deck is isolated; promotions and handoffs keep the service and timeline right ──
    @Test
    public void standbyBufferingReadyAndEndedNeverTouchTheCurrentSong() {
        playNormal("a", "b", "c");
        pa.position = 2_500;
        dj.tick(); // b warming on deck B
        pb.state = STATE_BUFFERING;
        cb.onPlayerChanged();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        dj.tick();
        pb.state = STATE_ENDED;
        cb.onEnded(); // even a stray ENDED from the standby
        assertEquals("playing", controller.status);
        assertTrue(pa.pwr && pa.volume == 1f && !pb.pwr && pb.volume == 0f);
        assertEquals(0, controller.queue.index);
        assertTrue(logicalDecks.isEmpty()); // the session never moved
        assertEquals(Arrays.asList("play_started:a"), types());
        assertEquals(pa.position, controller.positionMs()); // the timeline reads the logical deck
    }

    @Test
    public void aStandbyNetworkOrSignInFailureNeverStopsTheCurrentSong() {
        playNormal("a", "b");
        warmB();
        int retries = delayed.size();
        cb.onError(EngineCore.IO_BAD_HTTP_STATUS, "ERROR_CODE_IO_BAD_HTTP_STATUS"); // e.g. an expired token on the warm stream
        assertEquals(retries, delayed.size()); // a standby never retries on its own
        assertEquals("playing", controller.status);
        assertEquals(null, controller.error);
        assertTrue(pa.pwr);
        assertEquals("a", controller.queue.current().trackId());
        assertEquals("failed", dj.diagnostics().get("warmupState"));
    }

    @Test
    public void lateCallbacksFromAnAbandonedWarmupAreIgnored() {
        playNormal("a", "b", "c");
        pa.position = 2_500;
        dj.tick(); // b loading
        controller.playNext(NativeQueueTest.tracks("x")); // b is no longer next
        pb.state = STATE_READY;
        cb.onPlayerChanged(); // late events from the abandoned b
        cb.onError(2001, "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED");
        cb.onEnded();
        assertEquals("playing", controller.status);
        assertEquals("a", controller.queue.current().trackId());
        dj.tick();
        assertTrue(String.valueOf(dj.diagnostics().get("warmupTrack")).startsWith("x"));
        assertEquals(1, loads(pb, "x"));
    }

    @Test
    public void aPromotionStartsTheNewDeckBeforeTheSessionMoves() {
        playNormal("a", "b");
        warmB();
        controller.next();
        assertEquals(Arrays.asList("1:playing"), sessionMoves); // Media3 never sees a paused logical player
    }

    @Test
    public void theTimelineFollowsThePromotedDeckAtOnce() {
        playNormal("a", "b");
        warmB();
        pb.duration = 123_000;
        controller.next();
        pb.playing = true;
        pb.position = 1_234;
        assertEquals(1_234, controller.positionMs());
        assertEquals(123_000, controller.durationMs());
        assertTrue(PandaPlayerPlugin.shouldTick(controller.status));
    }

    @Test
    public void bufferingAndRecoveryKeepTheSongAndTheTicker() {
        playNormal("a", "b");
        pa.position = 30_000;
        pa.state = STATE_BUFFERING;
        pa.playing = false;
        ca.onPlayerChanged();
        assertEquals("buffering", controller.status);
        assertTrue(controller.intendsToPlay() && PandaPlayerPlugin.shouldTick(controller.status));
        pa.state = STATE_READY;
        pa.playing = true;
        pa.position = 30_500;
        ca.onPlayerChanged();
        assertEquals("playing", controller.status);
        assertEquals("a", controller.queue.current().trackId());
        assertEquals(30_500, controller.positionMs());
        assertEquals(Arrays.asList("play_started:a"), types()); // no pause/resume recorded
    }

    @Test
    public void aRefusedHandoffGivesTheDecksTheirRolesBack() {
        startMix("a", "b", "c");
        pa.position = 178_500;
        dj.tick();
        pb.state = STATE_READY;
        cb.onPlayerChanged();
        pa.position = 190_000;
        dj.tick(); // blending a → b
        pb.playing = true;
        controller.remove(controller.queue.items.get(1).uid); // b leaves the queue mid-blend
        pa.position = 195_500;
        dj.tick(); // the midpoint: the handoff is refused, a stays current
        assertEquals("a", controller.queue.current().trackId());
        assertFalse(ca.isStandby()); // 5.4 left the playing deck flagged as the standby
        assertFalse(pa.standbyBuffering);
        assertTrue(cb.isStandby());
    }

    @Test
    public void onlyIntendedPlaybackKeepsTheServiceInTheForeground() {
        playNormal("a", "b");
        assertTrue(PlaybackService.keepForeground(controller));
        pa.state = STATE_BUFFERING;
        pa.playing = false;
        ca.onPlayerChanged();
        assertTrue(PlaybackService.keepForeground(controller)); // buffering still means to play
        pa.state = STATE_READY;
        pa.playing = true;
        ca.onPlayerChanged();
        warmB();
        controller.pause();
        assertFalse(PlaybackService.keepForeground(controller)); // a warmed next song alone keeps nothing alive
        assertFalse(PlaybackService.keepForeground(null));
    }

    @Test
    public void twentyNaturalSongChangesWithWarmupAdvanceExactlyOnceEach() {
        String[] ids = new String[21];
        for (int k = 0; k < ids.length; k++) ids[k] = "s" + k;
        playNormal(ids);
        int deck = 0;
        for (int k = 1; k <= 20; k++) {
            EngineCoreTest.FakePort cur = port(deck), nxt = port(1 - deck);
            cur.position = 2_500;
            dj.tick(); // warm the next song
            nxt.state = STATE_READY;
            core(1 - deck).onPlayerChanged();
            dj.tick();
            cur.position = cur.duration;
            cur.state = STATE_ENDED;
            cur.playing = false;
            core(deck).onEnded(); // the song ends naturally
            deck = 1 - deck;
            assertEquals("s" + k, controller.queue.current().trackId());
            assertEquals(k, controller.queue.index);
            playing(deck, 0);
            assertEquals("playing", controller.status);
            assertFalse(dj.running()); // ordinary playback: never a blend
        }
        for (String id : ids) assertEquals(id, 1, loads(pa, id) + loads(pb, id)); // every song loaded exactly once
        assertEquals(21, types().stream().filter(t -> t.startsWith("play_started")).count());
    }


    // ── 5.4.2: HTTP failures and the standby deck ──
    @Test
    public void aStandby404NeverTouchesTheCurrentSong() {
        playNormal("a", "b", "c");
        warmB();
        cb.onError(EngineCore.IO_BAD_HTTP_STATUS, "ERROR_CODE_IO_BAD_HTTP_STATUS", new HttpFailure(404, null, "not_found"));
        assertTrue(pa.pwr && pa.volume == 1f);
        assertEquals("playing", controller.status);
        assertEquals(0, controller.queue.index);
        assertTrue(delayed.isEmpty()); // standbys never retry
        assertEquals("failed", dj.diagnostics().get("warmupState"));
    }

    @Test
    public void noStandbyRequestWhileTheCurrentSongIsStuckAtZero() {
        controller.replace(NativeQueueTest.tracks("a", "b"), 0, NativeQueueTest.source("playlist", "Mix"), false, true);
        pa.state = STATE_IDLE;
        ca.onError(EngineCore.IO_BAD_HTTP_STATUS, "ERROR_CODE_IO_BAD_HTTP_STATUS", new HttpFailure(503, 5, "navidrome_unavailable"));
        for (int k = 0; k < 10; k++) dj.tick(); // waiting for the NAS
        assertTrue(pb.calls.isEmpty()); // no second request piling onto waking disks
        assertEquals(0L, pa.position);
        assertTrue(controller.intendsToPlay());
    }

    @Test
    public void aMissingCurrentSongAdvancesToAPlayableOne() {
        playNormal("a", "b", "c");
        ca.onError(EngineCore.IO_BAD_HTTP_STATUS, "ERROR_CODE_IO_BAD_HTTP_STATUS", new HttpFailure(404, null, "not_found"));
        assertEquals("b", controller.queue.current().trackId());
        assertTrue(delayed.isEmpty());
    }

}
