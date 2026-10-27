package app.pandafm.client;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Android implementations of the queue's and the library's ports (5.0.1). */
final class NativePlatform {
    private static final String TAG = "PandaFM.Playback";

    private NativePlatform() {}

    /** Small private files written atomically (tmp + rename): never half-written after process death. */
    static final class Files {
        static void write(Context ctx, String name, String text) {
            File dir = ctx.getFilesDir();
            File tmp = new File(dir, name + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            } catch (IOException e) {
                Log.w(TAG, "Couldn't save " + name + ": " + e.getClass().getSimpleName());
                return;
            }
            if (!tmp.renameTo(new File(dir, name))) Log.w(TAG, "Couldn't replace " + name);
        }

        static String read(Context ctx, String name) {
            File f = new File(ctx.getFilesDir(), name);
            if (!f.exists()) return null;
            try (InputStream in = new java.io.FileInputStream(f); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toString("UTF-8");
            } catch (IOException e) {
                return null;
            }
        }
    }

    /** The queue, in files/queue.json (identities and metadata only; no URLs, no tokens). */
    static final class QueueFile implements QueueController.Store {
        private final Context ctx;
        private final ExecutorService disk = Executors.newSingleThreadExecutor();
        private final java.util.concurrent.atomic.AtomicReference<String> latest = new java.util.concurrent.atomic.AtomicReference<>();

        QueueFile(Context ctx) {
            this.ctx = ctx.getApplicationContext();
        }

        /** Serialised on the player thread, written on a background thread; only the newest is written. */
        public void save(String json) {
            if (latest.getAndSet(json) != null) return; // a write is already queued: it will take this one
            disk.execute(() -> {
                String newest = latest.getAndSet(null);
                if (newest != null) Files.write(ctx, "queue.json", newest);
            });
        }

        void close() {
            disk.shutdown();
        }

        public String load() {
            return Files.read(ctx, "queue.json");
        }
    }

    /** Playback preferences the phone UI sets (streaming quality, Autoplay). Per device. */
    static final class Prefs {
        static SharedPreferences of(Context ctx) {
            return ctx.getApplicationContext().getSharedPreferences("pandafm.playback", Context.MODE_PRIVATE);
        }

        static String streamQuality(Context ctx) {
            return of(ctx).getString("streamQuality", "auto");
        }
    }

    /** What's downloaded (synced from the app's offline manager): local files and Android Auto's offline root. */
    static final class Catalog implements LibraryTree.Catalog {
        private final Context ctx;
        private List<Map<String, Object>> tracks = new ArrayList<>();
        private List<Map<String, Object>> collections = new ArrayList<>();
        private final Map<String, String> uris = new LinkedHashMap<>();
        private Map<String, Object> artwork = new LinkedHashMap<>();

        Catalog(Context ctx) {
            this.ctx = ctx.getApplicationContext();
            load(Files.read(this.ctx, "offline-catalog.json"));
        }

        synchronized void replace(String json) {
            if (load(json)) Files.write(ctx, "offline-catalog.json", json);
        }

        private synchronized boolean load(String json) {
            Map<String, Object> m = Json.map(Json.tryParse(json));
            if (m == null) return false;
            tracks = Json.maps(m.get("tracks"));
            collections = Json.maps(m.get("collections"));
            Map<String, Object> art = Json.map(m.get("artwork"));
            artwork = art == null ? new LinkedHashMap<String, Object>() : art;
            uris.clear();
            for (Map<String, Object> t : tracks) {
                String id = Json.str(Json.map(t.get("track")), "id"), uri = Json.str(t, "uri");
                if (id != null && uri != null && uri.startsWith("content://")) uris.put(id, uri);
            }
            return true;
        }

        public synchronized List<Map<String, Object>> tracks() {
            return new ArrayList<>(tracks);
        }

        public synchronized List<Map<String, Object>> collections() {
            return new ArrayList<>(collections);
        }

        synchronized String localUri(String trackId) {
            return uris.get(trackId);
        }

        /** The saved (downloaded) artwork for a cover, as content://, or null. */
        synchronized String savedArtwork(String coverArtId) {
            Object uri = artwork.get(coverArtId);
            return uri instanceof String && ((String) uri).startsWith("content://") ? (String) uri : null;
        }
    }

    /** A downloaded file when there is one; else a stream, at the quality this network calls for. */
    static final class Sources implements QueueController.Sources {
        private final Context ctx;
        private final Catalog catalog;

        Sources(Context ctx, Catalog catalog) {
            this.ctx = ctx.getApplicationContext();
            this.catalog = catalog;
        }

        public String uriFor(QueueItem item) {
            String local = catalog.localUri(item.trackId());
            if (local != null) return local; // never stream what's on the phone
            String server = AuthStore.get(ctx).server();
            NetworkState net = NetworkState.of(ctx);
            if (server == null || !net.connected) return null;
            return StreamQuality.streamUrl(server, item.trackId(), StreamQuality.resolve(Prefs.streamQuality(ctx), net.metered, net.wifi));
        }
    }

    /** PandaFM's API, signed in through AuthCore/AuthHttp (same origin only, no tokens in URLs). */
    static final class Api implements LibraryTree.PandaApi {
        private final Context ctx;

        Api(Context ctx) {
            this.ctx = ctx.getApplicationContext();
        }

        private String url(String path) throws LibraryTree.ApiError {
            String server = AuthStore.get(ctx).server();
            if (server == null || !AuthStore.get(ctx).signedIn()) throw new LibraryTree.ApiError(401, LibraryTree.SIGN_IN);
            return AuthCore.base(server) + "/api" + path;
        }

        public Object get(String path) throws LibraryTree.ApiError {
            HttpURLConnection c = null;
            try {
                c = AuthHttp.open(ctx, url(path), Collections.singletonMap("Accept", "application/json"), 10_000, 20_000);
                return read(c);
            } catch (IOException e) {
                throw new LibraryTree.ApiError(0, "PandaFM can’t be reached.");
            } finally {
                if (c != null) c.disconnect();
            }
        }

        public Object post(String path, String json) throws LibraryTree.ApiError {
            HttpURLConnection c = null;
            try {
                c = AuthHttp.post(ctx, url(path), json, 10_000, 30_000);
                return read(c);
            } catch (IOException e) {
                throw new LibraryTree.ApiError(0, "PandaFM can’t be reached.");
            } finally {
                if (c != null) c.disconnect();
            }
        }

        private static Object read(HttpURLConnection c) throws IOException, LibraryTree.ApiError {
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String body = "";
            if (in != null) {
                try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = s.read(buf)) > 0 && out.size() < 8 << 20) out.write(buf, 0, n);
                    body = out.toString("UTF-8");
                }
            }
            if (code == 204) return new LinkedHashMap<String, Object>();
            if (code < 200 || code >= 300) {
                String message = MiniJson.string(body, "message");
                throw new LibraryTree.ApiError(code, message != null ? message : "PandaFM answered " + code + ".");
            }
            Object parsed = Json.tryParse(body);
            if (parsed == null) throw new LibraryTree.ApiError(502, "PandaFM sent something unexpected.");
            return parsed;
        }
    }

    /** Panda Radio over the API, off the main thread; answers come back on the player's thread. */
    static final class Radio implements QueueController.Radio {
        private final Api api;
        private final ExecutorService io;
        private final Handler main = new Handler(Looper.getMainLooper());

        Radio(Api api, ExecutorService io) {
            this.api = api;
            this.io = io;
        }

        private void run(String path, String json, boolean post, QueueController.Callback done) {
            io.execute(() -> {
                Map<String, Object> body = null;
                int status = 200;
                try {
                    body = Json.map(post ? api.post(path, json) : api.get(path));
                } catch (LibraryTree.ApiError e) {
                    status = e.status;
                }
                Map<String, Object> out = body;
                int code = status;
                main.post(() -> done.done(out, code));
            });
        }

        public void start(String preset, String seedKind, String seedId, QueueController.Callback done) {
            if ("station".equals(seedKind)) {
                run("/radio/stations/" + LibraryTree.enc(seedId) + "/start", "{}", true, done);
                return;
            }
            String seed = seedKind == null ? "" : ",\"seed\":{\"kind\":" + MiniJson.quote(seedKind) + ",\"id\":" + MiniJson.quote(seedId) + "}";
            run("/radio/sessions", "{\"preset\":" + MiniJson.quote(preset == null ? "panda" : preset) + seed + ",\"count\":10}", true, done);
        }

        public void extend(String sessionId, List<Long> upcoming, int target, QueueController.Callback done) {
            run("/radio/sessions/" + LibraryTree.enc(sessionId) + "/extend", "{\"upcoming\":" + Json.write(new ArrayList<Object>(upcoming)) + ",\"target\":" + target + "}", true, done);
        }

        public void check(String sessionId, QueueController.Callback done) {
            run("/radio/sessions/" + LibraryTree.enc(sessionId), null, false, (body, status) -> {
                if (body != null && "ended".equals(Json.str(body, "status"))) done.done(null, 410);
                else done.done(body, status);
            });
        }
    }

    /** Listening history and radio feedback, reported natively in batches; kept across restarts while offline. */
    static final class Events implements QueueController.Events {
        private static final int MAX_PENDING = 500;
        private final Context ctx;
        private final Api api;
        private final ExecutorService io;
        private final List<Map<String, Object>> pending = new ArrayList<>();
        private boolean flushing;

        Events(Context ctx, Api api, ExecutorService io) {
            this.ctx = ctx.getApplicationContext();
            this.api = api;
            this.io = io;
            pending.addAll(Json.maps(Json.tryParse(Files.read(this.ctx, "pending-events.json"))));
        }

        public synchronized void report(Map<String, Object> event) {
            pending.add(event);
            while (pending.size() > MAX_PENDING) pending.remove(0);
            String snapshot = Json.write(new ArrayList<Object>(pending));
            io.execute(() -> Files.write(ctx, "pending-events.json", snapshot)); // never on the player thread
            flush();
        }

        synchronized void flush() {
            if (flushing || pending.isEmpty()) return;
            flushing = true;
            List<Object> batch = new ArrayList<>(pending.subList(0, Math.min(100, pending.size())));
            io.execute(() -> {
                boolean sent = false;
                try {
                    api.post("/events", "{\"events\":" + Json.write(batch) + "}");
                    sent = true;
                } catch (LibraryTree.ApiError e) {
                    sent = e.status >= 400 && e.status < 500 && e.status != 401 && e.status != 408 && e.status != 429; // rejected for good: don't resend forever
                }
                synchronized (this) {
                    flushing = false;
                    if (sent) {
                        pending.removeAll(batch);
                        Files.write(ctx, "pending-events.json", Json.write(new ArrayList<Object>(pending)));
                        if (!pending.isEmpty()) flush();
                    }
                }
            });
        }
    }

    static final class Env implements QueueController.Env {
        private final Context ctx;

        Env(Context ctx) {
            this.ctx = ctx.getApplicationContext();
        }

        public long nowMs() {
            return System.currentTimeMillis();
        }

        public String newId() {
            return UUID.randomUUID().toString();
        }

        public boolean online() {
            return NetworkState.of(ctx).connected && AuthStore.get(ctx).signedIn();
        }
    }

    /**
     * Panda Mix plans (5.2): from /api/mix/prepare for the next few songs, cached in memory and in
     * files/mix-plans.json (offline). Never blocks: with nothing known, the Java fallback is used and
     * the better plan replaces it when it arrives (re-fetched at most every 20 s while analysis runs).
     */
    static final class MixPlans implements QueueController.MixPlans {
        private static final int MAX = 2000;
        private final Context ctx;
        private final Api api;
        private final ExecutorService io;
        private final Runnable updated;
        private final Handler main = new Handler(Looper.getMainLooper());
        private final ExecutorService disk = Executors.newSingleThreadExecutor();
        private final Map<String, Map<String, Object>> cache = new java.util.LinkedHashMap<String, Map<String, Object>>(256, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Map<String, Object>> e) {
                return size() > MAX;
            }
        };
        private final Map<String, Long> fetched = new java.util.HashMap<>();

        MixPlans(Context ctx, Api api, ExecutorService io, Runnable updated) {
            this.ctx = ctx.getApplicationContext();
            this.api = api;
            this.io = io;
            this.updated = updated;
            Map<String, Object> saved = Json.map(Json.tryParse(Files.read(this.ctx, "mix-plans.json")));
            if (saved != null) for (Map.Entry<String, Object> e : saved.entrySet()) if (Json.map(e.getValue()) != null) cache.put(e.getKey(), Json.map(e.getValue()));
        }

        static String key(String from, String to, String mode, String playlist) {
            return from + "|" + to + "|" + mode + "|" + (playlist == null ? "" : playlist);
        }

        @Override
        public synchronized Map<String, Object> plan(QueueItem a, QueueItem b, String mode, String playlistId, List<QueueItem> window) {
            Map<String, Object> p = cache.get(key(a.trackId(), b.trackId(), mode, playlistId));
            if (p == null || !Boolean.TRUE.equals(p.get("ready"))) fetch(window, mode, playlistId, false);
            return p != null ? new LinkedHashMap<>(p) : MixFallback.plan(a, b, mode);
        }

        private void fetch(List<QueueItem> window, String mode, String playlistId, boolean offline) {
            StringBuilder ids = new StringBuilder();
            List<Object> tracks = new ArrayList<>();
            for (QueueItem i : window) {
                ids.append(i.trackId()).append(',');
                Map<String, Object> t = new LinkedHashMap<>();
                for (String k : new String[] {"id", "duration_seconds", "album_id", "track_number", "disc_number", "genres"}) if (i.track.get(k) != null) t.put(k, i.track.get(k));
                tracks.add(t);
            }
            String wkey = ids + mode + (playlistId == null ? "" : playlistId) + offline;
            long now = System.currentTimeMillis();
            Long last = fetched.get(wkey);
            if (tracks.size() < 2 || (last != null && now - last < 20_000)) return;
            fetched.put(wkey, now);
            if (!NetworkState.of(ctx).connected || !AuthStore.get(ctx).signedIn()) return;
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("tracks", tracks);
            body.put("current_index", 0L);
            body.put("playlist_id", playlistId);
            body.put("mode", mode);
            body.put("offline", offline);
            io.execute(() -> {
                try {
                    Map<String, Object> resp = Json.map(api.post("/mix/prepare", Json.write(body)));
                    if (resp != null && store(resp, mode, playlistId)) main.post(updated);
                } catch (LibraryTree.ApiError ignored) {
                    // plans are a nicety: the fallback keeps playing
                }
            });
        }

        private synchronized boolean store(Map<String, Object> resp, String mode, String playlistId) {
            boolean any = false;
            for (Map<String, Object> t : Json.maps(resp.get("transitions"))) {
                String from = Json.str(t, "from"), to = Json.str(t, "to");
                if (from == null || to == null) continue;
                cache.put(key(from, to, mode, playlistId), t);
                any = true;
            }
            if (any) {
                String snapshot = Json.write(new LinkedHashMap<String, Object>(cache));
                disk.execute(() -> Files.write(ctx, "mix-plans.json", snapshot));
            }
            return any;
        }

        /** "Prepare Panda Mix" for a downloaded playlist: analyse it all on the server and keep every plan. */
        void prepareOffline(List<QueueItem> playlist, String mode, String playlistId) {
            fetch(playlist, mode, playlistId, true);
        }
    }

    static ExecutorService newIo() {
        return Executors.newFixedThreadPool(3);
    }
}
