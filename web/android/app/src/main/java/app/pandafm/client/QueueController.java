package app.pandafm.client;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * The single authoritative path for Android playback (5.0.1). Everything that
 * changes what plays goes through here: the phone UI, Android Auto, Bluetooth
 * and lock-screen buttons, a song ending, radio refills, restoring after a
 * restart. Call it only on the player's thread (PlaybackService posts there).
 *
 * It chooses WHAT plays (NativeQueue); the Engine only plays one item. That
 * split is what Panda Mix (two decks) builds on later.
 *
 * Every load gets a generation number; engine events from an older load are
 * ignored, so "track ended" and "Next pressed" can't both advance the queue.
 */
final class QueueController implements PlaybackSink {
    interface Engine {
        void load(int gen, QueueItem item, String uri, long startMs, boolean play);
        void play();
        void pause();
        void seekTo(long ms);
        long positionMs();
        long durationMs();
        boolean playWhenReady();
        void stop();

        /** Panda Mix (5.2): the next song and the plan to reach it (null clears). Single-deck engines ignore it. */
        default void prepareNext(int forGen, QueueItem next, Map<String, Object> plan) {}

        /** The incoming deck became the logical current track with this generation. */
        default void adopt(int newGen) {}

        /** A transition has started but its midpoint (the logical handoff) hasn't come yet. */
        default boolean inTransitionBeforeHandoff() {
            return false;
        }

        /** Finish a running transition now (Next during an overlap goes to the song already fading in). */
        default void completeTransitionNow() {}
    }

    /** Panda Mix plans (5.2): cached or a safe fallback, never blocking; better plans arrive via onPlansUpdated(). */
    interface MixPlans {
        Map<String, Object> plan(QueueItem from, QueueItem to, String mode, String playlistId, List<QueueItem> window);
    }

    interface Sources {
        /** A downloaded file (content://), else a stream URL for the current network; null if neither works now. */
        String uriFor(QueueItem item);
    }

    interface Store {
        void save(String json);
        String load();
    }

    interface Events {
        void report(Map<String, Object> event);
    }

    interface Callback {
        void done(Map<String, Object> body, int status);
    }

    /** PandaFM's radio API, asynchronous; results come back on the player's thread. */
    interface Radio {
        void start(String preset, String seedKind, String seedId, Callback done);
        void extend(String sessionId, List<Long> upcoming, int target, Callback done);
        void check(String sessionId, Callback done);
    }

    interface Env {
        long nowMs();
        String newId();
        boolean online();
    }

    interface Listener {
        void onChange(String reason);
    }

    static final int LOW_WATER = 3; // refill radio when fewer picks than this are queued
    static final int TARGET_AHEAD = 8;
    static final long RESTART_WINDOW_MS = 3000; // Previous within 3 s goes back; later it restarts the song
    static final String OFFLINE_UNAVAILABLE = "This song isn’t downloaded, and PandaFM can’t be reached right now.";

    final NativeQueue queue;
    private final Engine engine;
    private final Sources sources;
    private final Store store;
    private final Events events;
    private final Radio radio;
    private final Env env;
    private final List<Listener> listeners = new ArrayList<>();

    int gen = 0;
    String status = "idle"; // idle (nothing loaded) | loading | playing | paused | ended | error
    String error;
    private String playId;
    private String playUid;
    private boolean started, completed;
    private boolean released;
    private long resumeAtMs;
    private String resumeUid;
    private boolean refilling;
    boolean autoplayEnabled = true;
    String autoplayPreset = "panda";
    private String suppressedQueue; // first item of the queue in which radio was ended

    QueueController(NativeQueue queue, Engine engine, Sources sources, Store store, Events events, Radio radio, Env env) {
        this.queue = queue;
        this.engine = engine;
        this.sources = sources;
        this.store = store;
        this.events = events;
        this.radio = radio;
        this.env = env;
    }

    void addListener(Listener l) {
        listeners.add(l);
    }

    private MixPlans mixPlans;

    void setMixPlans(MixPlans plans) {
        mixPlans = plans;
    }

    /** "auto" | "gentle" | "flow" | "energetic" when this queue plays as a Panda Mix, else null. */
    String mixMode() {
        return queue.source == null ? null : Json.str(Json.map(queue.source.get("mix")), "mode");
    }

    private String mixPlaylist() {
        return queue.source == null ? null : Json.str(Json.map(queue.source.get("mix")), "playlistId");
    }

    /** Tell the engine how the current song should become the next one (only during a Panda Mix). */
    void planNext() {
        if (released) return;
        String mode = mixMode();
        QueueItem now = queue.current();
        Integer ni = queue.nextIndex();
        if (mode == null || mixPlans == null || now == null || ni == null || ni == queue.index || "one".equals(queue.repeat) || "idle".equals(status)) {
            engine.prepareNext(gen, null, null);
            return;
        }
        List<QueueItem> window = new ArrayList<>();
        for (int k = queue.index; k < Math.min(queue.items.size(), queue.index + 4); k++) window.add(queue.items.get(k));
        QueueItem next = queue.items.get(ni);
        engine.prepareNext(gen, next, mixPlans.plan(now, next, mode, mixPlaylist(), window));
    }

    /** A better plan arrived (analysis finished): re-plan the upcoming transition. */
    void onPlansUpdated() {
        planNext();
    }

    /**
     * Panda DJ's logical handoff (the transition midpoint): the song fading in becomes the current
     * one without being reloaded. Refused (false) if the queue changed and it's no longer next.
     */
    boolean onHandoff(int forGen, String incomingUid) {
        if (released || forGen != gen) return false;
        Integer ni = queue.nextIndex();
        if (ni == null || !queue.items.get(ni).uid.equals(incomingUid)) return false;
        if (started && !completed) {
            completed = true;
            report("play_completed", engine.positionMs());
        }
        queue.index = ni;
        gen++;
        playId = env.newId();
        playUid = incomingUid;
        started = true;
        completed = false;
        error = null;
        status = "playing";
        engine.adopt(gen);
        report("play_started", 0);
        changed("current");
        return true;
    }

    /** The service is going away: nothing may touch the player or the queue afterwards. */
    void release() {
        released = true;
        listeners.clear();
    }

    /** Still meaning to make sound (playing, loading, buffering): the timeline keeps updating. */
    boolean intendsToPlay() {
        return !released && queue.current() != null && PlaybackStateModel.intendsToPlay(status);
    }

    long positionMs() {
        return "idle".equals(status) ? resumeAtMs : engine.positionMs();
    }

    long durationMs() {
        return engine.durationMs();
    }

    void removeListener(Listener l) {
        listeners.remove(l);
    }

    /** Something the user asked for couldn't happen (e.g. a car request while offline). */
    void showError(String message) {
        if (released) return;
        fail(message);
    }

    /**
     * 5.0 → 5.0.1: adopt the web app's saved queue once, if the native queue is empty
     * and the snapshot is valid. Anything doubtful is ignored (the native queue starts empty).
     */
    boolean migrateFromWeb(Map<String, Object> web) {
        if (released) return false;
        if (queue.current() != null || web == null) return false;
        Map<String, Object> m = new LinkedHashMap<>(web);
        Object pos = web.get("position");
        m.put("positionMs", pos instanceof Number ? Math.round(((Number) pos).doubleValue() * 1000) : 0L);
        if (!queue.restore(m)) return false;
        resumeAtMs = Json.num(m, "positionMs") == null ? 0 : Json.num(m, "positionMs");
        resumeUid = queue.current() == null ? null : queue.current().uid;
        status = "idle";
        changed("restore");
        return true;
    }

    // ── restoring after a restart: always paused ──
    void restore() {
        if (released) return;
        String saved = store.load();
        Map<String, Object> m = Json.map(Json.tryParse(saved));
        if (m == null || !queue.restore(m)) return; // corrupt or absent: start empty
        Long pos = Json.num(m, "positionMs");
        QueueItem now = queue.current();
        resumeAtMs = pos == null ? 0 : Math.max(0, pos);
        resumeUid = now == null ? null : now.uid;
        status = "idle"; // nothing plays until play()
        String sid = queue.radioSessionId();
        if (sid != null) {
            radio.check(sid, (body, code) -> {
                if (released) return;
                if (code == 404 || code == 410) { // the session ended on the server: keep the songs
                    queue.endRadio();
                    changed("radio-ended");
                }
            });
        }
        notifyAll("restore");
    }

    // ── what the phone UI and Android Auto ask for ──
    void replace(List<Map<String, Object>> tracks, Integer startIndex, Map<String, Object> source, boolean shuffle, boolean play) {
        if (released) return;
        if (tracks.isEmpty()) return;
        leaveCurrent();
        queue.load(tracks, startIndex, source, shuffle);
        start(queue.index, play);
    }

    /** A radio session the server started (from the phone or from us): picks, seed song, session. */
    void applyRadioStart(Map<String, Object> out, boolean keepCurrent, boolean autoplay) {
        if (released) return;
        Map<String, Object> session = Json.map(out.get("session"));
        String sid = Json.str(session, "id");
        if (sid == null) return;
        Map<String, Object> radioInfo = new LinkedHashMap<>();
        radioInfo.put("sessionId", sid);
        radioInfo.put("mode", Json.str(session, "mode"));
        radioInfo.put("modeLabel", Json.str(session, "mode_label"));
        radioInfo.put("seedName", Json.str(session, "seed_name"));
        if (Json.str(session, "preset_id") != null) radioInfo.put("presetId", Json.str(session, "preset_id"));
        if (Json.str(session, "station_id") != null) radioInfo.put("stationId", Json.str(session, "station_id"));
        if (autoplay) radioInfo.put("autoplay", Boolean.TRUE);
        Map<String, Object> source = new LinkedHashMap<>();
        source.put("kind", "radio");
        source.put("name", Json.str(session, "mode_label"));
        source.put("radio", radioInfo);
        applyRadioPicks(Json.maps(out.get("picks")), source, Json.map(out.get("seed_track")), keepCurrent, autoplay);
    }

    /** Radio picks ({selection_id, track}) with their radio source: the one path for every radio start. */
    void applyRadioPicks(List<Map<String, Object>> rawPicks, Map<String, Object> source, Map<String, Object> seedTrack, boolean keepCurrent, boolean autoplay) {
        if (released) return;
        String sid = Json.str(Json.map(source == null ? null : source.get("radio")), "sessionId");
        if (sid == null) return;
        List<QueueItem> picks = queue.wrapRadio(rawPicks, sid);
        if (autoplay) {
            queue.appendRadio(picks, source);
            Integer next = queue.nextIndex();
            if (next != null) start(next, true);
            else changed("radio");
            return;
        }
        boolean continuing = keepCurrent && queue.current() != null && !"idle".equals(status);
        if (!continuing) leaveCurrent();
        queue.startRadio(picks, source, seedTrack, keepCurrent);
        if (continuing) changed("radio");
        else start(queue.index, true);
    }

    /** Android Auto / a station / a radio mode: ask the server to start radio, then play. */
    void startRadio(String preset, String seedKind, String seedId) {
        if (released) return;
        radio.start(preset, seedKind, seedId, (body, code) -> {
            if (released) return;
            if (body != null) applyRadioStart(body, false, false);
            else fail("PandaFM couldn’t start radio right now.");
        });
    }

    void playNext(List<Map<String, Object>> tracks) {
        if (released) return;
        boolean empty = queue.current() == null;
        queue.playNext(tracks);
        if (empty) status = "idle";
        changed("queue");
    }

    void addToQueue(List<Map<String, Object>> tracks) {
        if (released) return;
        boolean empty = queue.current() == null;
        queue.addToQueue(tracks);
        if (empty) status = "idle";
        changed("queue");
    }

    void remove(String uid) {
        if (released) return;
        if (queue.remove(uid)) changed("queue");
    }

    void move(String uid, int direction) {
        if (released) return;
        if (queue.move(uid, direction)) changed("queue");
    }

    void clear(String which) {
        if (released) return;
        queue.clearUpcoming(which);
        changed("queue");
    }

    void jumpTo(String uid) {
        if (released) return;
        QueueItem before = queue.current();
        int previous = queue.index;
        if (!queue.jumpTo(uid)) return;
        int target = queue.index;
        queue.index = previous;
        if (before != null) leaveCurrent();
        start(target, true);
    }

    void toggleShuffle() {
        if (released) return;
        queue.setShuffle(!queue.shuffle);
        changed("shuffle");
    }

    void cycleRepeat() {
        if (released) return;
        queue.cycleRepeat();
        changed("repeat");
    }

    void endRadio() {
        if (released) return;
        queue.endRadio();
        suppressedQueue = queue.items.isEmpty() ? null : queue.items.get(0).uid;
        changed("radio-ended");
    }

    // ── transport: the same for the phone, Android Auto, Bluetooth and the lock screen ──
    void play() {
        if (released || queue.current() == null) return;
        if ("idle".equals(status) || "ended".equals(status)) {
            start(queue.index, true);
            return;
        }
        if ("error".equals(status)) { // try the same song again (a fresh source: the network may have changed)
            start(queue.index, true);
            return;
        }
        if ("paused".equals(status) && started && !completed) report("resume", engine.positionMs());
        engine.play();
    }

    /** A real, intentional pause (the user, a headset, the car): not to be confused with buffering. */
    void pause() {
        if (released) return;
        if (started && !completed && PlaybackStateModel.intendsToPlay(status)) report("pause", engine.positionMs());
        engine.pause();
        save();
    }

    void seekTo(long ms) {
        if (released) return;
        if (queue.current() == null) return;
        if ("idle".equals(status)) { // a restored song: remember where to start
            resumeAtMs = Math.max(0, ms);
            resumeUid = queue.current().uid;
            notifyAll("position");
            return;
        }
        engine.seekTo(Math.max(0, ms));
    }

    void next() {
        if (released) return;
        if (engine.inTransitionBeforeHandoff()) { // A is fading out, B fading in: B, without restarting it
            engine.completeTransitionNow();
            return;
        }
        Integer target = queue.nextIndex();
        if (target == null) {
            if (tryAutoplay()) return;
            return;
        }
        leaveCurrent();
        start(target, true);
    }

    void previous() {
        if (released) return;
        if (queue.current() == null) return;
        if (!"idle".equals(status) && engine.positionMs() > RESTART_WINDOW_MS) {
            engine.seekTo(0);
            return;
        }
        Integer target = queue.previousIndex();
        if (target == null) {
            if (!"idle".equals(status)) engine.seekTo(0);
            return;
        }
        leaveCurrent();
        start(target, true);
    }

    // ── engine events (each tagged with the load it belongs to) ──
    /**
     * The engine's derived state (PlaybackStateModel): loading, buffering, playing, paused, error.
     * Buffering keeps meaning to play; only an intentional pause is "paused". No listening
     * events here except the first start: pause/resume are reported where they're asked for.
     */
    @Override
    public void onEngineState(int forGen, String state) {
        if (released || forGen != gen || queue.current() == null) return;
        if ("playing".equals(state) && !started) {
            started = true;
            report("play_started", 0);
        }
        if ("error".equals(state)) return; // onError explains it
        status = state;
        if ("playing".equals(state)) error = null;
        notifyAll("state");
    }

    /** The song finished: advance natively, no JavaScript involved. */
    @Override
    public void onEnded(int forGen) {
        if (released || forGen != gen) return; // a newer load (e.g. Next) already moved on
        if (started && !completed) {
            completed = true;
            report("play_completed", engine.durationMs());
        }
        if ("one".equals(queue.repeat)) {
            start(queue.index, true);
            return;
        }
        Integer target = queue.nextIndex();
        if (target != null) {
            start(target, true);
            return;
        }
        status = "ended";
        save();
        notifyAll("ended");
        tryAutoplay();
    }

    @Override
    public void onError(int forGen, String message) {
        if (released || forGen != gen) return;
        fail(message); // the queue stays: Play retries, Next and Previous still work
    }

    // ── internals ──
    private void start(int index, boolean play) {
        if (index < 0 || index >= queue.items.size()) return;
        queue.index = index;
        QueueItem item = queue.items.get(index);
        String uri = sources.uriFor(item);
        gen++;
        playId = env.newId();
        playUid = item.uid;
        started = completed = false;
        long startMs = item.uid.equals(resumeUid) ? resumeAtMs : 0;
        resumeUid = null;
        resumeAtMs = 0;
        if (uri == null) {
            engine.stop();
            status = "error";
            error = OFFLINE_UNAVAILABLE;
            changed("error");
            return;
        }
        error = null;
        status = play ? "loading" : "paused";
        engine.load(gen, item, uri, startMs, play);
        changed("current");
    }

    /** After every change: refill radio and (during a Panda Mix) plan the next transition. */
    private void afterChange() {
        refill();
        planNext();
    }

    /** Leaving a song that started but didn't finish is a skip (the server decides early or late). */
    private void leaveCurrent() {
        QueueItem now = queue.current();
        if (now != null && started && !completed && now.uid.equals(playUid)) report("skip", engine.positionMs());
        started = false;
    }

    private boolean tryAutoplay() {
        QueueItem last = queue.current();
        if (!autoplayEnabled || last == null || queue.radioSessionId() != null || !"off".equals(queue.repeat) || !env.online()) return false;
        if (!queue.items.isEmpty() && queue.items.get(0).uid.equals(suppressedQueue)) return false; // radio was ended here
        String lastUid = last.uid;
        radio.start(autoplayPreset, "track", last.trackId(), (body, code) -> {
            if (released) return;
            QueueItem still = queue.current();
            if (body == null || still == null || !still.uid.equals(lastUid) || !"ended".equals(status)) return; // the user moved on
            applyRadioStart(body, false, true);
        });
        return true;
    }

    private void refill() {
        String sid = queue.radioSessionId();
        if (sid == null || refilling || queue.current() == null) return;
        List<Long> ahead = queue.radioUpcomingSelections(sid);
        if (ahead.size() >= LOW_WATER) return;
        refilling = true;
        radio.extend(sid, ahead, TARGET_AHEAD, (body, code) -> {
            refilling = false;
            if (released) return;
            if (!sid.equals(queue.radioSessionId())) return; // radio ended or changed meanwhile
            if (body == null) {
                if (code == 404 || code == 409 || code == 410) { // the session is over: keep what's queued
                    queue.endRadio();
                    changed("radio-ended");
                }
                return;
            }
            List<Long> replaced = new ArrayList<>();
            for (Object o : Json.list(body.get("replaced")) == null ? new ArrayList<>() : Json.list(body.get("replaced"))) {
                if (o instanceof Number) replaced.add(((Number) o).longValue());
            }
            queue.addRadio(replaced, queue.wrapRadio(Json.maps(body.get("picks")), sid));
            changed("radio");
        });
    }

    private void fail(String message) {
        status = "error";
        error = message;
        changed("error");
    }

    private void changed(String reason) {
        if (released) return;
        save();
        notifyAll(reason);
        afterChange();
    }

    void save() {
        if (released) return;
        Map<String, Object> m = queue.snapshot(NativeQueue.MAX_SAVED);
        QueueItem now = queue.current();
        long pos = "idle".equals(status) ? resumeAtMs : now == null ? 0 : engine.positionMs();
        m.put("positionMs", pos);
        store.save(Json.write(m));
    }

    private void notifyAll(String reason) {
        for (Listener l : listeners) l.onChange(reason);
    }

    /** What the phone UI mirrors. */
    Map<String, Object> uiSnapshot() {
        Map<String, Object> m = queue.snapshot(2000);
        m.put("status", status);
        m.put("error", error);
        m.put("positionMs", positionMs());
        m.put("durationMs", engine.durationMs());
        m.put("gen", (long) gen);
        m.put("autoplaySuppressed", suppressedQueue != null && !queue.items.isEmpty() && queue.items.get(0).uid.equals(suppressedQueue));
        return m;
    }

    private void report(String type, long positionMs) {
        QueueItem item = queue.current();
        if (item == null || playId == null) return;
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("event_id", env.newId());
        e.put("type", type);
        Map<String, Object> t = new LinkedHashMap<>();
        for (String k : new String[] {"id", "title", "artist", "artist_id", "album", "album_id", "genres", "year", "duration_seconds", "cover_art_id"}) {
            if (item.track.get(k) != null) t.put(k, item.track.get(k));
        }
        e.put("track", t);
        e.put("play_id", playId);
        e.put("occurred_at", iso(env.nowMs()));
        e.put("position_s", Math.round(positionMs / 100.0) / 10.0);
        long dur = engine.durationMs();
        e.put("duration_s", dur > 0 ? dur / 1000.0 : null);
        String kind = Json.str(queue.source, "kind");
        e.put("source", item.isRadio() ? "radio" : "manual".equals(item.origin) ? "queue" : kind == null ? "library" : kind);
        e.put("mode", item.isRadio() ? Json.str(Json.map(queue.source == null ? null : queue.source.get("radio")), "mode") : null);
        e.put("radio_session_id", item.radioSession);
        e.put("radio_selection_id", item.radioSelection);
        e.put("details", new LinkedHashMap<String, Object>());
        events.report(e);
    }

    static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }
}
