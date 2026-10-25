package app.pandafm.client;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * The background download queue. Persisted, so downloads continue after the
 * app (or the phone) restarts; one job per song; waits for an allowed network
 * (Wi-Fi when mobile data isn't allowed); a foreground service keeps it alive
 * while the app is in the background.
 */
final class DownloadQueue {
    interface Listener {
        void onUpdate(DownloadJob job);
    }

    private static DownloadQueue instance;
    private static final String PREFS = "pandafm.downloads";
    static final String TAG = "PandaFM.Download";

    private final Context ctx;
    private final Map<String, DownloadJob> jobs = new LinkedHashMap<>();
    private final Set<String> running = new HashSet<>();
    private final Set<String> cancelled = new HashSet<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final ServiceGate gate = new ServiceGate();
    private Listener listener;
    private int concurrency = 2;
    private boolean allowMetered = false;
    private boolean paused = false;

    static synchronized DownloadQueue get(Context ctx) {
        if (instance == null) instance = new DownloadQueue(ctx.getApplicationContext());
        return instance;
    }

    private DownloadQueue(Context ctx) {
        this.ctx = ctx;
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        concurrency = prefs.getInt("concurrency", 2);
        allowMetered = prefs.getBoolean("allowMetered", false);
        try {
            JSONArray saved = new JSONArray(prefs.getString("jobs", "[]"));
            for (int i = 0; i < saved.length(); i++) {
                DownloadJob job = DownloadJob.fromJson(saved.getJSONObject(i));
                if ("running".equals(job.status)) job.status = "queued"; // interrupted by a restart: resume
                jobs.put(job.id, job);
            }
        } catch (JSONException ignored) {
            // corrupt state: start empty, the app re-plans from its manifest
        }
    }

    synchronized void setListener(Listener listener) {
        this.listener = listener;
    }

    synchronized void enqueue(List<DownloadJob> incoming, int concurrency, boolean allowMetered) {
        this.concurrency = Math.max(1, Math.min(4, concurrency));
        this.allowMetered = allowMetered;
        int added = 0;
        for (DownloadJob job : incoming) {
            DownloadJob existing = jobs.get(job.id);
            if (existing != null && ("queued".equals(existing.status) || "running".equals(existing.status))) continue; // already on its way
            cancelled.remove(job.id);
            jobs.put(job.id, job);
            added++;
        }
        persist();
        Log.i(TAG, "Enqueued " + added + " of " + incoming.size() + " songs (" + counts()[0] + " active, concurrency " + this.concurrency
            + (allowMetered ? ", any network)" : ", Wi-Fi only)"));
        schedule(); // one service request for the whole album/playlist, not one per song
    }

    synchronized List<DownloadJob> all() {
        return new ArrayList<>(jobs.values());
    }

    /** The app has recorded these finished/failed jobs in its manifest. */
    synchronized void acknowledge(List<String> ids) {
        for (String id : ids) {
            DownloadJob job = jobs.get(id);
            if (job != null && !"queued".equals(job.status) && !"running".equals(job.status)) jobs.remove(id);
        }
        persist();
    }

    synchronized void cancel(List<String> ids) {
        for (String id : ids) {
            if (running.contains(id)) cancelled.add(id);
            DownloadJob job = jobs.get(id);
            if (job != null && !running.contains(id)) jobs.remove(id);
        }
        persist();
    }

    synchronized void setPaused(boolean paused) {
        this.paused = paused;
        schedule();
    }

    synchronized boolean isPaused() {
        return paused;
    }

    synchronized int[] counts() { // {active, done-or-failed-awaiting-ack}
        int active = 0;
        for (DownloadJob job : jobs.values()) if ("queued".equals(job.status) || "running".equals(job.status)) active++;
        return new int[] {active, running.size()};
    }

    synchronized boolean hasWork() {
        for (DownloadJob job : jobs.values()) if ("queued".equals(job.status) || "running".equals(job.status)) return true;
        return false;
    }

    synchronized boolean networkAllowed() {
        NetworkState net = NetworkState.of(ctx);
        return net.connected && (allowMetered || !net.metered || net.wifi);
    }

    /**
     * For events from outside the service (enqueue, network change, resume,
     * folder chosen, app start): make sure the foreground service runs, then
     * start workers. Never call this from the service itself.
     */
    synchronized void schedule() {
        ensureService();
        scheduleWorkers();
    }

    /**
     * Start as many queued jobs as allowed right now. Never asks for the
     * service: the service's onStartCommand() and finishing jobs use this.
     */
    synchronized void scheduleWorkers() {
        if (paused || !networkAllowed()) return;
        Uri tree = Storage.tree(ctx);
        if (tree == null || !Storage.hasPermission(ctx, tree)) return;
        for (DownloadJob job : jobs.values()) {
            if (running.size() >= concurrency) break;
            if (!"queued".equals(job.status) || running.contains(job.id)) continue;
            job.status = "running";
            running.add(job.id);
            emit(job);
            pool.execute(() -> work(tree, job));
        }
    }

    private void work(Uri tree, DownloadJob job) {
        try {
            Downloader.run(ctx, tree, job, (bytes, total) -> progress(job, bytes, total), () -> isCancelled(job.id));
            finish(job, "done", null, true);
        } catch (Downloader.Failure failure) {
            finish(job, "failed", failure.getMessage(), failure.retryable);
        }
    }

    private synchronized boolean isCancelled(String id) {
        return cancelled.contains(id) || paused;
    }

    private synchronized void progress(DownloadJob job, long bytes, long total) {
        job.bytes = bytes;
        job.total = total;
        emit(job);
    }

    private synchronized void finish(DownloadJob job, String status, String error, boolean retryable) {
        running.remove(job.id);
        if (cancelled.remove(job.id)) {
            jobs.remove(job.id);
        } else if (paused && "failed".equals(status)) {
            job.status = "queued"; // paused mid-download: resume later from the .part file
        } else {
            job.status = status;
            job.error = error;
            job.retryable = retryable;
            emit(job);
        }
        persist();
        scheduleWorkers(); // the next songs; the running service (if any) stays as it is
    }

    private void emit(DownloadJob job) {
        Listener l = listener;
        if (l != null) l.onUpdate(job);
        DownloadService.refresh(ctx);
    }

    /** Ask Android for the foreground service, once, only when there is work and it isn't running or requested. */
    private void ensureService() {
        boolean work = hasWork();
        if (!gate.shouldRequest(work)) {
            if (work) Log.d(TAG, gate.isRunning() ? "Service already running" : "Service start already requested");
            return;
        }
        int[] c = counts();
        Log.i(TAG, "Requesting the download service (" + c[0] + " active, " + c[1] + " running)");
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, DownloadService.class));
        } catch (RuntimeException e) {
            // Android may refuse from the background; downloads still run while PandaFM is open,
            // and a later event (app opened, network back) may request it again.
            gate.requestFailed();
            Log.w(TAG, "Android didn't start the download service now: " + e.getClass().getSimpleName());
        }
    }

    /** DownloadService is in the foreground. */
    void serviceStarted() {
        gate.started();
    }

    /** DownloadService stopped or was destroyed; new work may request it again. */
    void serviceStopped() {
        gate.stopped();
    }

    private void persist() {
        JSONArray array = new JSONArray();
        try {
            for (DownloadJob job : jobs.values()) array.put(job.toJson());
        } catch (JSONException ignored) {
            return;
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("jobs", array.toString()).putInt("concurrency", concurrency).putBoolean("allowMetered", allowMetered).apply();
    }
}
