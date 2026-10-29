package app.pandafm.client;

import static app.pandafm.client.PlaybackStateModel.STATE_BUFFERING;
import static app.pandafm.client.PlaybackStateModel.STATE_IDLE;
import static app.pandafm.client.PlaybackStateModel.STATE_READY;
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

/**
 * The 5.1 playback state machine, end to end through EngineCore and
 * QueueController, with a fake Media3 player. Reproduces the 5.0.1 bugs
 * (buffering taken for a pause, artwork touching the player) and pins the fixes.
 */
public class EngineCoreTest {
    static final class FakePort implements EngineCore.PlayerPort {
        final List<String> calls = new ArrayList<>();
        int state = STATE_IDLE, suppression;
        boolean pwr, playing, seekable = true;
        long position, duration = 200_000;
        float volume = 1f;
        boolean standbyBuffering;
        String uri, artwork;

        public void setVolume(float v) { volume = v; }
        public void setStandbyBuffering(boolean s) { standbyBuffering = s; }

        public void setMediaItem(String id, String u, long startMs, String t, String a, String al, String art) {
            calls.add("setMediaItem " + id + " @" + startMs);
            uri = u;
            artwork = art;
            position = startMs;
            state = STATE_IDLE;
            playing = false;
        }
        public void prepare() { calls.add("prepare"); } // like ExoPlayer: the state changes later, via the listener
        public void setPlayWhenReady(boolean p) { calls.add("playWhenReady " + p); pwr = p; if (!p) playing = false; }
        public boolean playWhenReady() { return pwr; }
        public int playbackState() { return state; }
        public boolean isPlaying() { return playing; }
        public int suppressionReason() { return suppression; }
        public long position() { return position; }
        public long duration() { return duration; }
        public boolean seekable() { return seekable; }
        public void seekTo(long ms) { calls.add("seekTo " + ms); position = ms; }
        public void stop() { calls.add("stop"); state = STATE_IDLE; playing = false; }
    }

    final FakePort port = new FakePort();
    final List<long[]> scheduled = new ArrayList<>();
    final List<Runnable> tasks = new ArrayList<>();
    final List<String> expired = new ArrayList<>();
    final List<String> warnings = new ArrayList<>();
    long now = 1_700_000_000_000L;
    final EngineCore core = new EngineCore(port, (task, delay) -> { tasks.add(task); scheduled.add(new long[] {delay}); },
        new EngineCore.Logger() {
            public void info(String m) {}
            public void warn(String m) { warnings.add(m); }
        },
        new EngineCore.Hooks() {
            public void expireAccessToken() { expired.add("x"); }
            public String artworkUriFor(String coverArtId) { return "content://app.pandafm.client.artwork/cover/" + coverArtId; }
            public long nowMs() { return now; }
        });
    final List<Map<String, Object>> events = new ArrayList<>();
    final Map<String, String> local = new LinkedHashMap<>();
    int ids;
    final String[] saved = {null};
    final QueueController controller = new QueueController(new NativeQueue(() -> "u" + (++ids), new Random(1)), core,
        item -> local.containsKey(item.trackId()) ? local.get(item.trackId()) : "https://music.example.com/api/tracks/" + item.trackId() + "/stream",
        new QueueController.Store() {
            public void save(String json) { saved[0] = json; }
            public String load() { return saved[0]; }
        },
        events::add,
        new QueueController.Radio() {
            public void start(String p, String k, String i, QueueController.Callback d) {}
            public void extend(String s, List<Long> u, int t, QueueController.Callback d) {}
            public void check(String s, QueueController.Callback d) {}
        },
        new QueueController.Env() {
            public long nowMs() { return now; }
            public String newId() { return "id" + (++ids); }
            public boolean online() { return true; }
        });

    {
        core.attach(controller);
    }

    List<String> types() {
        List<String> out = new ArrayList<>();
        for (Map<String, Object> e : events) out.add((String) e.get("type"));
        return out;
    }

    static List<Map<String, Object>> tracks(String... ids) {
        List<Map<String, Object>> out = NativeQueueTest.tracks(ids);
        for (Map<String, Object> t : out) t.put("cover_art_id", "c-" + t.get("id"));
        return out;
    }

    void ready(boolean isPlaying) {
        port.state = STATE_READY;
        port.playing = isPlaying && port.pwr;
        core.onPlayerChanged();
    }

    void buffering() {
        port.state = STATE_BUFFERING;
        port.playing = false;
        core.onPlayerChanged();
    }

    void startPlaying(String... ids) {
        controller.replace(tracks(ids), 0, NativeQueueTest.source("playlist", "Mix"), false, true);
        assertEquals("loading", controller.status);
        buffering();
        assertEquals("buffering", controller.status);
        ready(true);
        assertEquals("playing", controller.status);
    }

    @Test
    public void idleToLoadingToBufferingToPlaying() {
        startPlaying("a", "b");
        assertEquals(Arrays.asList("play_started"), types());
        assertTrue(controller.intendsToPlay());
    }

    @Test
    public void bufferingIsNotAPauseAndRecovers() {
        startPlaying("a", "b");
        port.position = 120_000;
        buffering(); // the network stalls: isPlaying=false, playWhenReady still true
        assertEquals("buffering", controller.status); // 5.0.1 said "paused" here and the timeline stopped
        assertTrue(controller.intendsToPlay());
        assertTrue(PandaPlayerPlugin.shouldTick(controller.status));
        ready(true);
        assertEquals("playing", controller.status);
        assertEquals("a", controller.queue.current().trackId()); // same song, same place
        assertEquals(Arrays.asList("play_started"), types()); // no pause, no resume, no skip recorded
        assertFalse(port.calls.contains("playWhenReady false")); // nothing paused it
    }

    @Test
    public void briefAudioFocusLossIsNotAPause() {
        startPlaying("a");
        port.suppression = 1;
        ready(false); // READY, playWhenReady=true, not playing: suppressed
        assertEquals("buffering", controller.status);
        port.suppression = 0;
        ready(true);
        assertEquals("playing", controller.status);
    }

    @Test
    public void aRealPauseIsStillAPauseAndPlayResumes() {
        startPlaying("a");
        controller.pause();
        assertEquals("paused", controller.status);
        assertFalse(controller.intendsToPlay());
        assertFalse(PandaPlayerPlugin.shouldTick(controller.status)); // the ticker may rest
        ready(false); // a late READY doesn't resume an intentional pause
        assertEquals("paused", controller.status);
        controller.play();
        ready(true);
        assertEquals("playing", controller.status);
        assertEquals(Arrays.asList("play_started", "pause", "resume"), types());
    }

    @Test
    public void pausingWhileBufferingStaysPaused() {
        startPlaying("a");
        buffering();
        controller.pause();
        assertEquals("paused", controller.status);
        port.state = STATE_READY;
        core.onPlayerChanged();
        assertEquals("paused", controller.status); // never auto-resumed
    }

    @Test
    public void seekingWhilePlayingAndWhileBufferingMovesThePosition() {
        startPlaying("a");
        controller.seekTo(30_000);
        assertEquals(30_000, controller.positionMs());
        buffering();
        controller.seekTo(90_000);
        assertEquals(90_000, controller.positionMs());
        ready(true);
        assertEquals("playing", controller.status);
    }

    @Test
    public void aLiveStreamThatCantSeekIsReloadedAtTheNewPosition() {
        startPlaying("a");
        port.seekable = false; // first play of an uncached AAC stream
        port.calls.clear();
        controller.seekTo(45_000);
        assertEquals(Arrays.asList("setMediaItem track:a @45000", "playWhenReady true", "prepare"), port.calls);
        assertEquals(45_000, controller.positionMs()); // not stuck at the old position
    }

    @Test
    public void aFinishedSongAdvancesOnce() {
        startPlaying("a", "b", "c");
        port.state = PlaybackStateModel.STATE_ENDED;
        core.onEnded();
        core.onEnded(); // a late, duplicate ENDED for A after B was loaded
        assertEquals("b", controller.queue.current().trackId());
    }

    @Test
    public void eventsFromAnOlderLoadAreIgnored() {
        startPlaying("a", "b", "c");
        int oldGen = controller.gen;
        buffering();
        controller.next(); // the user presses Next while A buffers
        assertEquals("b", controller.queue.current().trackId());
        controller.onEngineState(oldGen, "paused"); // A's late events
        controller.onEnded(oldGen);
        controller.onError(oldGen, "A failed");
        assertEquals("b", controller.queue.current().trackId());
        assertEquals("loading", controller.status);
        assertNull(controller.error);
    }

    @Test
    public void networkErrorsRetryWithBackoffAndRecover() {
        startPlaying("a", "b");
        port.position = 150_000;
        port.state = STATE_IDLE;
        port.playing = false;
        core.onError(EngineCore.IO_NETWORK_CONNECTION_FAILED, "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED");
        assertEquals("buffering", controller.status); // still meaning to play, not an error yet
        assertEquals(1_000, scheduled.get(0)[0]);
        port.calls.clear();
        tasks.get(0).run();
        assertEquals(Arrays.asList("prepare"), port.calls); // reconnect at the same place
        ready(true);
        assertEquals("playing", controller.status);
        assertEquals("a", controller.queue.current().trackId());
        assertTrue(expired.isEmpty()); // a network blip leaves the sign-in alone
        assertEquals(1, types().size()); // no extra listening events
    }

    @Test
    public void anExpiredTokenMidSongRefreshesBeforeRetrying() {
        startPlaying("a");
        core.onError(EngineCore.IO_BAD_HTTP_STATUS, "ERROR_CODE_IO_BAD_HTTP_STATUS");
        assertEquals(1, expired.size());
        tasks.get(0).run();
        ready(true);
        assertEquals("playing", controller.status);
    }

    @Test
    public void persistentFailureIsAClearErrorAndTheQueueStays() {
        startPlaying("a", "b");
        for (int k = 0; k < 4; k++) {
            port.state = STATE_IDLE; // ExoPlayer drops to IDLE on an error
            port.playing = false;
            core.onError(EngineCore.IO_NETWORK_CONNECTION_TIMEOUT, "ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT");
            if (k < 3) {
                tasks.get(k).run();
                buffering(); // reconnecting... and failing again
            }
        }
        assertEquals("error", controller.status);
        assertTrue(controller.error != null && !controller.error.isEmpty());
        assertEquals(2, controller.queue.items.size());
        assertEquals(3, scheduled.size()); // bounded: 1 s, 3 s, 8 s, then stop
        port.calls.clear();
        controller.play(); // Play retries the same song
        assertEquals("setMediaItem track:a @0", port.calls.get(0));
    }

    @Test
    public void downloadedFilesAreNeverRetried() {
        local.put("a", "content://tree/PandaFM/a.flac");
        startPlaying("a");
        core.onError(EngineCore.IO_UNSPECIFIED, "ERROR_CODE_IO_UNSPECIFIED");
        assertEquals("error", controller.status);
        assertTrue(scheduled.isEmpty());
    }

    @Test
    public void aRetryFromAnOlderLoadDoesNothing() {
        startPlaying("a", "b");
        core.onError(EngineCore.IO_NETWORK_CONNECTION_FAILED, "x");
        controller.next();
        port.calls.clear();
        tasks.get(0).run(); // A's retry fires after B started
        assertTrue(port.calls.isEmpty());
        assertEquals("b", controller.queue.current().trackId());
    }

    @Test
    public void artworkNeverTouchesThePlayingSong() {
        startPlaying("a", "b");
        assertEquals("content://app.pandafm.client.artwork/cover/c-a", port.artwork); // no URL with a token
        port.calls.clear();
        // Time passes; the session's bitmap loader fetches the artwork through ArtworkProvider.
        for (int k = 0; k < 5; k++) {
            port.position += 1000;
            ready(true);
        }
        assertTrue(port.calls.isEmpty()); // no replace, no re-prepare, no seek: the audio source is untouched
        assertEquals(5000, controller.positionMs());
        assertEquals("playing", controller.status);
        assertEquals(Arrays.asList("play_started"), types()); // no duplicate start
        assertEquals("a", controller.queue.current().trackId());
    }

    @Test
    public void noArtworkStillPlays() {
        EngineCore bare = new EngineCore(port, (t, d) -> {}, new EngineCore.Logger() {
            public void info(String m) {}
            public void warn(String m) {}
        }, new EngineCore.Hooks() {
            public void expireAccessToken() {}
            public String artworkUriFor(String id) { return null; } // e.g. the provider can't fetch it
            public long nowMs() { return 0; }
        });
        QueueItem item = new QueueItem("u", NativeQueueTest.track("a"), "context", null, null);
        bare.load(1, item, "https://music.example.com/api/tracks/a/stream", 0, true);
        assertNull(port.artwork);
        assertTrue(port.calls.contains("prepare"));
    }

    @Test
    public void nothingHappensAfterTheServiceIsGone() {
        startPlaying("a", "b");
        controller.release();
        core.release();
        port.calls.clear();
        core.onEnded();
        core.onError(EngineCore.IO_NETWORK_CONNECTION_FAILED, "x");
        buffering();
        controller.next();
        assertTrue(port.calls.isEmpty());
        assertEquals("a", controller.queue.current().trackId());
    }

    @Test
    public void diagnosticsAreBoundedAndSafe() {
        startPlaying("a", "b");
        for (int k = 0; k < 40; k++) {
            buffering();
            ready(true);
        }
        Map<String, Object> d = core.diagnostics();
        assertEquals(EngineCore.HISTORY, Json.list(d.get("events")).size());
        String text = Json.write(d);
        assertFalse(text.contains("http") || text.contains("token") || text.contains("Bearer"));
        assertEquals("remote", d.get("source"));
        assertEquals("READY", d.get("playbackState"));
    }
}
