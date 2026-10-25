package app.pandafm.client;

import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;
import java.util.Map;

/**
 * The phone UI's window onto the native queue (5.0.1). On Android the native
 * queue is the one authority: React sends it commands and mirrors the
 * snapshots it publishes ("queue" on every change, "state" for position, at
 * most once a second while playing). Complex arguments travel as JSON strings.
 */
@CapacitorPlugin(name = "PandaPlayer")
public class PandaPlayerPlugin extends Plugin {
    private static final String TAG = "PandaFM.Playback";
    private static final long TICK_MS = 1000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable ticker = this::tick;
    private QueueController.Listener listener;

    interface Task {
        void run(QueueController c);
    }

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT >= 26) {
            main.post(() -> {
                try {
                    getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
                } catch (RuntimeException e) {
                    Log.w(TAG, "Couldn't raise the WebView renderer priority");
                }
            });
        }
    }

    @Override
    protected void handleOnDestroy() {
        main.removeCallbacks(ticker);
        QueueController c = PlaybackService.controller();
        if (c != null && listener != null) c.removeListener(listener);
        listener = null;
    }

    private void with(PluginCall call, Task task) {
        main.post(() -> PlaybackService.whenReady(getContext(), () -> {
            QueueController c = PlaybackService.controller();
            if (c == null) {
                call.reject("The player isn't available");
                return;
            }
            attach(c);
            task.run(c);
            call.resolve();
        }));
    }

    private void attach(QueueController c) {
        if (listener != null) return;
        listener = reason -> {
            JSObject o = new JSObject();
            o.put("reason", reason);
            o.put("snapshot", Json.write(c.uiSnapshot()));
            notifyListeners("queue", o);
            tick();
        };
        c.addListener(listener);
    }

    private void tick() {
        main.removeCallbacks(ticker);
        QueueController c = PlaybackService.controller();
        if (c == null) return;
        Map<String, Object> s = c.uiSnapshot();
        JSObject o = new JSObject();
        o.put("status", c.status);
        o.put("positionMs", (Object) s.get("positionMs"));
        o.put("durationMs", (Object) s.get("durationMs"));
        o.put("error", c.error);
        o.put("gen", c.gen);
        notifyListeners("state", o);
        if ("playing".equals(c.status) || "loading".equals(c.status)) main.postDelayed(ticker, TICK_MS);
    }

    private static List<Map<String, Object>> tracks(PluginCall call, String key) {
        return Json.maps(Json.tryParse(call.getString(key, "[]")));
    }

    @PluginMethod
    public void getSnapshot(PluginCall call) {
        main.post(() -> PlaybackService.whenReady(getContext(), () -> {
            QueueController c = PlaybackService.controller();
            attach(c);
            JSObject o = new JSObject();
            o.put("snapshot", Json.write(c.uiSnapshot()));
            call.resolve(o);
            tick();
        }));
    }

    @PluginMethod
    public void replaceQueue(PluginCall call) {
        List<Map<String, Object>> t = tracks(call, "tracks");
        Integer start = call.getInt("startIndex", -1);
        Map<String, Object> source = Json.map(Json.tryParse(call.getString("source", "null")));
        boolean shuffle = Boolean.TRUE.equals(call.getBoolean("shuffle", false));
        boolean play = !Boolean.FALSE.equals(call.getBoolean("play", true));
        with(call, c -> c.replace(t, start == null || start < 0 ? null : start, source, shuffle, play));
    }

    @PluginMethod
    public void applyRadio(PluginCall call) {
        List<Map<String, Object>> picks = tracks(call, "picks");
        Map<String, Object> source = Json.map(Json.tryParse(call.getString("source", "null")));
        Map<String, Object> seed = Json.map(Json.tryParse(call.getString("seedTrack", "null")));
        boolean keep = Boolean.TRUE.equals(call.getBoolean("keepCurrent", false));
        boolean autoplay = Boolean.TRUE.equals(call.getBoolean("autoplay", false));
        with(call, c -> c.applyRadioPicks(picks, source, seed, keep, autoplay));
    }

    @PluginMethod
    public void startRadio(PluginCall call) {
        String preset = call.getString("preset", "panda"), kind = call.getString("seedKind"), id = call.getString("seedId");
        with(call, c -> c.startRadio(preset, kind, id));
    }

    @PluginMethod public void playNext(PluginCall call) { List<Map<String, Object>> t = tracks(call, "tracks"); with(call, c -> c.playNext(t)); }
    @PluginMethod public void addToQueue(PluginCall call) { List<Map<String, Object>> t = tracks(call, "tracks"); with(call, c -> c.addToQueue(t)); }
    @PluginMethod public void remove(PluginCall call) { String uid = call.getString("uid"); with(call, c -> c.remove(uid)); }
    @PluginMethod public void move(PluginCall call) { String uid = call.getString("uid"); int d = call.getInt("direction", 1); with(call, c -> c.move(uid, d < 0 ? -1 : 1)); }
    @PluginMethod public void clear(PluginCall call) { String which = call.getString("which", "all"); with(call, c -> c.clear(which)); }
    @PluginMethod public void jumpTo(PluginCall call) { String uid = call.getString("uid"); with(call, c -> c.jumpTo(uid)); }
    @PluginMethod public void toggleShuffle(PluginCall call) { with(call, QueueController::toggleShuffle); }
    @PluginMethod public void cycleRepeat(PluginCall call) { with(call, QueueController::cycleRepeat); }
    @PluginMethod public void endRadio(PluginCall call) { with(call, QueueController::endRadio); }
    @PluginMethod public void play(PluginCall call) { with(call, QueueController::play); }
    @PluginMethod public void pause(PluginCall call) { with(call, QueueController::pause); }
    @PluginMethod public void next(PluginCall call) { with(call, QueueController::next); }
    @PluginMethod public void previous(PluginCall call) { with(call, QueueController::previous); }

    @PluginMethod
    public void seek(PluginCall call) {
        Double seconds = call.getDouble("position");
        with(call, c -> c.seekTo(Math.round((seconds == null ? 0 : seconds) * 1000)));
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double v = call.getDouble("volume");
        with(call, c -> {
            ExoEngine e = PlaybackService.engine();
            if (e != null) e.setVolume((float) Math.max(0, Math.min(1, v == null ? 1 : v)));
        });
    }

    /** Streaming quality and Autoplay, chosen on this device in Settings. */
    @PluginMethod
    public void setPreferences(PluginCall call) {
        android.content.SharedPreferences.Editor e = NativePlatform.Prefs.of(getContext()).edit();
        String quality = call.getString("streamQuality");
        if (quality != null) e.putString("streamQuality", quality);
        Boolean autoplay = call.getBoolean("autoplayEnabled", null);
        if (autoplay != null) e.putBoolean("autoplayEnabled", autoplay);
        String preset = call.getString("autoplayPreset");
        if (preset != null) e.putString("autoplayPreset", preset);
        e.apply();
        main.post(() -> {
            QueueController c = PlaybackService.controller();
            if (c != null) {
                c.autoplayEnabled = NativePlatform.Prefs.of(getContext()).getBoolean("autoplayEnabled", true);
                c.autoplayPreset = NativePlatform.Prefs.of(getContext()).getString("autoplayPreset", "panda");
            }
        });
        call.resolve();
    }

    /** What's downloaded, for local playback and Android Auto's offline root. */
    @PluginMethod
    public void setOfflineCatalog(PluginCall call) {
        String json = call.getString("catalog", "{}");
        with(call, c -> {
            NativePlatform.Catalog catalog = PlaybackService.catalog();
            if (catalog != null) catalog.replace(json);
        });
    }

    /** 5.0 → 5.0.1: adopt the web app's saved queue once, if the native queue is empty and the snapshot is valid. */
    @PluginMethod
    public void migrate(PluginCall call) {
        Map<String, Object> web = Json.map(Json.tryParse(call.getString("snapshot", "null")));
        main.post(() -> PlaybackService.whenReady(getContext(), () -> {
            QueueController c = PlaybackService.controller();
            attach(c);
            JSObject o = new JSObject();
            o.put("migrated", c.migrateFromWeb(web));
            call.resolve(o);
        }));
    }
}
