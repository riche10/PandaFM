package app.pandafm.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.Test;

/** The authoritative Android queue path, without Android, React or a network. */
public class QueueControllerTest {
    static final class FakeEngine implements QueueController.Engine {
        final List<String> loads = new ArrayList<>();
        int lastGen;
        boolean lastPlay;
        long position, duration = 200_000, lastStart;
        boolean stopped;
        public void load(int gen, QueueItem item, String uri, long startMs, boolean play) { loads.add(item.trackId() + "@" + uri); lastGen = gen; lastPlay = play; lastStart = startMs; position = startMs; }
        public void play() { lastPlay = true; }
        public void pause() { lastPlay = false; }
        public void seekTo(long ms) { position = ms; }
        public long positionMs() { return position; }
        public long durationMs() { return duration; }
        public void stop() { stopped = true; }
        public boolean playWhenReady() { return lastPlay; }
    }

    static final class FakeRadio implements QueueController.Radio {
        final List<String> calls = new ArrayList<>();
        QueueController.Callback pending;
        int checkCode = 200;
        public void start(String preset, String kind, String id, QueueController.Callback done) { calls.add("start " + preset + " " + kind + ":" + id); pending = done; }
        public void extend(String sid, List<Long> upcoming, int target, QueueController.Callback done) { calls.add("extend " + sid + " " + upcoming); pending = done; }
        public void check(String sid, QueueController.Callback done) { calls.add("check " + sid); done.done(null, checkCode); }
    }

    final FakeEngine engine = new FakeEngine();
    final FakeRadio radio = new FakeRadio();
    final List<Map<String, Object>> events = new ArrayList<>();
    final String[] stored = {null};
    final Map<String, String> local = new LinkedHashMap<>();
    boolean online = true;
    int ids = 0;
    final QueueController.Store store = new QueueController.Store() {
        public void save(String json) { stored[0] = json; }
        public String load() { return stored[0]; }
    };

    QueueController controller() {
        NativeQueue q = new NativeQueue(() -> "u" + (++ids), new Random(3));
        return new QueueController(q, engine,
            item -> local.containsKey(item.trackId()) ? local.get(item.trackId()) : online ? "https://music.example.com/api/tracks/" + item.trackId() + "/stream" : null,
            store, events::add, radio,
            new QueueController.Env() {
                public long nowMs() { return 1_700_000_000_000L; }
                public String newId() { return "id" + (++ids); }
                public boolean online() { return online; }
            });
    }

    static List<Map<String, Object>> tracks(String... ids) {
        return NativeQueueTest.tracks(ids);
    }

    static Map<String, Object> src(String kind) {
        return NativeQueueTest.source(kind, kind);
    }

    List<String> types() {
        List<String> out = new ArrayList<>();
        for (Map<String, Object> e : events) out.add((String) e.get("type"));
        return out;
    }

    @Test
    public void aFinishedSongAdvancesNativelyWithoutReact() {
        QueueController c = controller();
        c.replace(tracks("a", "b", "c"), 0, src("playlist"), false, true);
        c.onEngineState(engine.lastGen, "playing");
        c.onEnded(engine.lastGen);
        assertEquals("b", c.queue.current().trackId());
        assertTrue(engine.lastPlay);
        assertEquals(Arrays.asList("play_started", "play_completed"), types());
        assertEquals("playlist", events.get(0).get("source"));
    }

    @Test
    public void nextAndAStaleEndedEventAdvanceOnlyOnce() {
        QueueController c = controller();
        c.replace(tracks("a", "b", "c"), 0, null, false, true);
        int gen = engine.lastGen;
        c.onEngineState(gen, "playing");
        c.next(); // the user presses Next as the song ends...
        c.onEnded(gen); // ...and the old song's "ended" arrives late
        assertEquals("b", c.queue.current().trackId());
        assertEquals(Arrays.asList("play_started", "skip"), types());
    }

    @Test
    public void repeatOneReplaysAndRepeatAllWraps() {
        QueueController c = controller();
        c.replace(tracks("a", "b"), 1, null, false, true);
        c.cycleRepeat();
        c.cycleRepeat(); // one
        c.onEnded(engine.lastGen);
        assertEquals("b", c.queue.current().trackId());
        c.cycleRepeat(); // off
        c.cycleRepeat(); // all
        c.onEnded(engine.lastGen);
        assertEquals("a", c.queue.current().trackId());
    }

    @Test
    public void previousRestartsLateInASongAndGoesBackEarly() {
        QueueController c = controller();
        c.replace(tracks("a", "b"), 1, null, false, true);
        engine.position = 10_000;
        c.previous();
        assertEquals("b", c.queue.current().trackId());
        assertEquals(0, engine.position);
        c.previous();
        assertEquals("a", c.queue.current().trackId());
    }

    @Test
    public void restoredQueueIsPausedAndResumesWhereItWas() {
        QueueController c = controller();
        c.replace(tracks("a", "b", "c"), 1, src("album"), false, true);
        engine.position = 42_000;
        c.save();
        engine.loads.clear();
        QueueController after = controller(); // a new process
        after.restore();
        assertEquals("idle", after.status);
        assertEquals("b", after.queue.current().trackId());
        assertTrue(engine.loads.isEmpty()); // nothing plays on its own
        after.play();
        assertEquals(42_000, engine.lastStart);
        assertTrue(engine.lastPlay);
    }

    @Test
    public void corruptSavedStateStartsEmpty() {
        stored[0] = "{\"v\":1,\"items\":[{\"uid\":";
        QueueController c = controller();
        c.restore();
        assertNull(c.queue.current());
        assertEquals("idle", c.status);
    }

    @Test
    public void downloadedSongsPlayLocallyAndOfflineRemoteSongsFailGracefully() {
        local.put("b", "content://tree/PandaFM/b.flac");
        QueueController c = controller();
        online = false;
        c.replace(tracks("a", "b"), 0, null, false, true);
        assertEquals("error", c.status);
        assertEquals(QueueController.OFFLINE_UNAVAILABLE, c.error);
        assertEquals(2, c.queue.items.size()); // the queue stays intact
        c.next();
        assertEquals("b@content://tree/PandaFM/b.flac", engine.loads.get(engine.loads.size() - 1));
    }

    @Test
    public void radioRefillsWhenRunningLowAndKeepsHandPickedSongs() {
        QueueController c = controller();
        Map<String, Object> out = radioOut("S", 1, 2);
        c.applyRadioStart(out, false, false);
        assertEquals("extend S [2]", radio.calls.get(radio.calls.size() - 1)); // only one pick ahead after the first plays
        Map<String, Object> more = new LinkedHashMap<>();
        more.put("replaced", new ArrayList<>(Arrays.asList(2L)));
        more.put("picks", new ArrayList<>(Arrays.asList(NativeQueueTest.pick("r3", 3), NativeQueueTest.pick("r4", 4))));
        radio.pending.done(more, 200);
        List<String> ids = new ArrayList<>();
        for (QueueItem i : c.queue.items) ids.add(i.trackId());
        assertEquals(Arrays.asList("r1", "r3", "r4"), ids);
    }

    @Test
    public void anEndedRadioSessionKeepsTheSongs() {
        QueueController c = controller();
        c.applyRadioStart(radioOut("S", 1, 2), false, false);
        radio.pending.done(null, 404);
        assertNull(c.queue.radioSessionId());
        assertEquals(2, c.queue.items.size());
        radio.checkCode = 404;
        c.save();
        QueueController after = controller();
        stored[0] = stored[0].replace("\"kind\":\"tracks\"", "\"kind\":\"radio\",\"radio\":{\"sessionId\":\"S\"}");
        after.restore();
        assertNull(after.queue.radioSessionId());
        assertEquals(2, after.queue.items.size());
    }

    @Test
    public void autoplayContinuesAfterTheQueueUnlessRadioWasEnded() {
        QueueController c = controller();
        c.replace(tracks("a"), 0, src("album"), false, true);
        c.onEnded(engine.lastGen);
        assertEquals("start panda track:a", radio.calls.get(0));
        radio.pending.done(radioOut("S", 7, 8), 200);
        assertEquals("r7", c.queue.current().trackId());
        assertEquals("a", c.queue.items.get(0).trackId()); // what played stays
        QueueController d = controller();
        d.replace(tracks("x"), 0, src("album"), false, true);
        d.endRadio();
        radio.calls.clear();
        d.onEnded(engine.lastGen);
        assertTrue(radio.calls.isEmpty()); // "End radio" means no Autoplay for this queue
    }

    @Test
    public void manualQueueOperationsFromThePhoneOrTheCar() {
        QueueController c = controller();
        List<String> reasons = new ArrayList<>();
        c.addListener(reasons::add);
        c.addToQueue(tracks("a")); // empty queue: shown, ready, not playing
        assertEquals("idle", c.status);
        c.playNext(tracks("b"));
        c.addToQueue(tracks("c"));
        String c3 = c.queue.items.get(2).uid;
        c.move(c3, -1);
        c.jumpTo(c3);
        assertEquals("c", c.queue.current().trackId());
        c.toggleShuffle();
        c.clear("all");
        assertEquals(1, c.queue.items.size());
        assertTrue(reasons.contains("queue") && reasons.contains("current") && reasons.contains("shuffle"));
        assertFalse(stored[0].contains("token"));
    }

    static Map<String, Object> radioOut(String sid, long... sels) {
        Map<String, Object> session = new LinkedHashMap<>();
        session.put("id", sid);
        session.put("mode", "panda");
        session.put("mode_label", "Rock Radio");
        List<Object> picks = new ArrayList<>();
        for (long s : sels) picks.add(NativeQueueTest.pick("r" + s, s));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("session", session);
        out.put("picks", picks);
        return out;
    }
}
