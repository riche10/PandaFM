package app.pandafm.client;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Plays ONE queue item through a PlayerPort (ExoPlayer on a device, a fake in
 * tests) and tells QueueController what is really happening (5.1). It never
 * decides what comes next: that stays the queue's job (the seam Panda Mix's
 * decks will use). Everything runs on the player's thread.
 *
 * - State comes from playbackState + playWhenReady + isPlaying + suppression
 *   (PlaybackStateModel): buffering is never mistaken for a pause.
 * - Every load has a generation; events and retries from an older load are ignored.
 * - Clearly recoverable network errors on a stream are retried a few times with
 *   backoff (the sign-in is refreshed first); anything else is a real error.
 * - Artwork never touches the player: it rides on the MediaItem as a
 *   content:// URI the session's own bitmap loader resolves (ArtworkProvider).
 */
final class EngineCore implements QueueController.Engine {
    interface PlayerPort {
        void setVolume(float volume);
        void setMediaItem(String mediaId, String uri, long startMs, String title, String artist, String album, String artworkUri);
        void prepare();
        void setPlayWhenReady(boolean play);
        boolean playWhenReady();
        int playbackState();
        boolean isPlaying();
        int suppressionReason();
        long position();
        long duration();
        boolean seekable();
        void seekTo(long ms);
        void stop();
    }

    interface Scheduler {
        void postDelayed(Runnable task, long delayMs);
    }

    interface Logger {
        void info(String message);
        void warn(String message);
    }

    interface Hooks {
        /** Before retrying a stream that failed with a bad HTTP status: make the next request refresh its token. */
        void expireAccessToken();
        /** "track:<id>" artwork as a content:// URI (no credentials), or null. */
        String artworkUriFor(String coverArtId);
        long nowMs();
    }

    // Media3 PlaybackException codes that a short wait can fix
    static final int IO_UNSPECIFIED = 2000, IO_NETWORK_CONNECTION_FAILED = 2001, IO_NETWORK_CONNECTION_TIMEOUT = 2002, IO_BAD_HTTP_STATUS = 2004, TIMEOUT = 1003;
    static final long[] BACKOFF_MS = {1_000, 3_000, 8_000};
    static final int HISTORY = 50;

    private final PlayerPort port;
    private final Scheduler scheduler;
    private final Logger log;
    private final Hooks hooks;
    private PlaybackSink controller;

    private int gen;
    private String uri = "";
    private QueueItem item;
    private String state = "idle";
    private boolean failed, endedSent;
    private int retries;
    private boolean released;
    private String lastError;
    private final ArrayDeque<String> history = new ArrayDeque<>();

    EngineCore(PlayerPort port, Scheduler scheduler, Logger log, Hooks hooks) {
        this.port = port;
        this.scheduler = scheduler;
        this.log = log;
        this.hooks = hooks;
    }

    void attach(PlaybackSink c) {
        controller = c;
    }

    /** Panda DJ handed this (already playing) deck the logical current track: it now carries that generation. */
    @Override
    public void adopt(int newGen) {
        gen = newGen;
    }

    int generation() {
        return gen;
    }

    QueueItem item() {
        return item;
    }

    String state() {
        return state;
    }

    boolean ready() {
        return item != null && port.playbackState() == PlaybackStateModel.STATE_READY;
    }

    void release() {
        released = true;
    }

    boolean isRemote() {
        return uri.startsWith("http");
    }

    // ── what the queue asks for ──
    @Override
    public void load(int forGen, QueueItem it, String sourceUri, long startMs, boolean play) {
        gen = forGen;
        item = it;
        uri = sourceUri;
        failed = endedSent = false;
        retries = 0;
        String art = it.coverArtId() == null ? null : hooks.artworkUriFor(it.coverArtId());
        port.setMediaItem("track:" + it.trackId(), sourceUri, startMs, it.title(), it.artist(), it.album(), art);
        port.setPlayWhenReady(play);
        port.prepare();
        record("load " + (isRemote() ? "remote" : "downloaded") + " track=" + it.trackId() + (play ? "" : " paused"));
        update();
    }

    @Override
    public void play() {
        if (failed) { // a real error: try the same song again
            failed = false;
            retries = 0;
            port.prepare();
        }
        port.setPlayWhenReady(true);
        record("user_play");
        update();
    }

    @Override
    public void pause() {
        port.setPlayWhenReady(false);
        record("user_pause");
        update();
    }

    @Override
    public void seekTo(long ms) {
        if (item != null && isRemote() && !port.seekable()) {
            // A first-play live AAC stream can't seek: reload the song at that point (the server
            // then serves its cached, seekable copy) rather than leaving the position stuck.
            boolean play = port.playWhenReady();
            port.setMediaItem("track:" + item.trackId(), uri, ms, item.title(), item.artist(), item.album(), item.coverArtId() == null ? null : hooks.artworkUriFor(item.coverArtId()));
            port.setPlayWhenReady(play);
            port.prepare();
            record("seek reload " + ms + "ms");
        } else {
            port.seekTo(ms);
        }
        update();
    }

    @Override public long positionMs() { return Math.max(0, port.position()); }
    @Override public long durationMs() { return Math.max(0, port.duration()); }
    @Override public boolean playWhenReady() { return port.playWhenReady(); }

    @Override
    public void stop() {
        port.stop();
        item = null;
        uri = "";
        state = "idle";
    }

    // ── what the player reports (the adapter calls these for its listener events) ──
    void onPlayerChanged() {
        if (released || controller == null || item == null) return;
        update();
    }

    void onEnded() {
        // Only while the player really is ENDED: a late, queued ENDED from the previous song
        // (arriving after the next one was loaded) must not advance the queue again.
        if (released || controller == null || item == null || endedSent || port.playbackState() != PlaybackStateModel.STATE_ENDED) return;
        endedSent = true; // one completion per load
        record("ended");
        controller.onEnded(gen);
    }

    void onError(int code, String codeName) {
        if (released || controller == null || item == null) return;
        boolean recoverable = isRemote() && (code == IO_UNSPECIFIED || code == IO_NETWORK_CONNECTION_FAILED || code == IO_NETWORK_CONNECTION_TIMEOUT
            || code == IO_BAD_HTTP_STATUS || code == TIMEOUT);
        lastError = codeName + " (" + (isRemote() ? "remote" : "downloaded") + ", gen " + gen + ")";
        log.warn("gen=" + gen + " player_error " + codeName + " remote=" + isRemote() + " state=" + state + " playWhenReady=" + port.playWhenReady()
            + " track=" + item.trackId() + " retry=" + retries);
        record("player_error " + codeName);
        if (recoverable && retries < BACKOFF_MS.length) {
            int forGen = gen;
            long delay = BACKOFF_MS[retries++];
            if (code == IO_BAD_HTTP_STATUS) hooks.expireAccessToken(); // e.g. the access token ran out mid-song
            scheduler.postDelayed(() -> {
                if (released || forGen != gen || item == null) return; // the queue moved on meanwhile
                record("retry " + retries);
                port.prepare(); // keeps the position; ExoPlayer reconnects with a Range request
                update();
            }, delay);
            state = "buffering"; // still meaning to play while we wait to retry
            controller.onEngineState(gen, "buffering");
            return;
        }
        failed = true;
        update();
        String[] kind = PlaybackErrors.classify(code, !isRemote());
        controller.onError(gen, kind.length > 1 ? kind[1] : "PandaFM couldn’t play this song.");
    }

    private void update() {
        if (released || controller == null || item == null) return;
        String next = PlaybackStateModel.derive(port.playbackState(), port.playWhenReady(), port.isPlaying(), port.suppressionReason(), failed);
        if ("ended".equals(next)) return; // completion goes through onEnded (once)
        if (next.equals(state)) return;
        if ("playing".equals(next)) retries = 0; // recovered
        log.info("gen=" + gen + " " + state + " → " + next + " playWhenReady=" + port.playWhenReady());
        record(state + " → " + next);
        state = next;
        controller.onEngineState(gen, next);
    }

    private void record(String what) {
        String stamp = new SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date(hooks.nowMs()));
        history.addLast(stamp + " gen=" + gen + " " + what);
        while (history.size() > HISTORY) history.removeFirst();
    }

    /** Safe facts for Settings › Diagnostics: no URLs, no tokens. */
    Map<String, Object> diagnostics() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("engineState", state);
        m.put("playbackState", stateName(port.playbackState()));
        m.put("playWhenReady", port.playWhenReady());
        m.put("isPlaying", port.isPlaying());
        m.put("generation", (long) gen);
        m.put("source", item == null ? null : isRemote() ? "remote" : "downloaded");
        m.put("quality", !isRemote() ? null : uri.contains("quality=low") ? "low" : uri.contains("quality=high") ? "high" : "original");
        m.put("positionMs", positionMs());
        m.put("durationMs", durationMs());
        m.put("lastError", lastError);
        m.put("events", new ArrayList<Object>(history));
        return m;
    }

    List<String> history() {
        return new ArrayList<>(history);
    }

    static String stateName(int s) {
        switch (s) {
            case PlaybackStateModel.STATE_IDLE: return "IDLE";
            case PlaybackStateModel.STATE_BUFFERING: return "BUFFERING";
            case PlaybackStateModel.STATE_READY: return "READY";
            case PlaybackStateModel.STATE_ENDED: return "ENDED";
            default: return String.valueOf(s);
        }
    }
}
