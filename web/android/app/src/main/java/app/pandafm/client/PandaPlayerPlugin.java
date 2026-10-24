package app.pandafm.client;

import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaLibraryInfo;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web app's PlaybackEngine on Android (web/src/player/nativeEngine.ts).
 * It plays one song at a time on PlaybackService's ExoPlayer and reports
 * what happens, tagged with the load generation the web app gave it, so the
 * shared queue can ignore anything from a previous song. It never decides
 * what plays next.
 */
@CapacitorPlugin(name = "PandaPlayer")
@OptIn(markerClass = UnstableApi.class)
public class PandaPlayerPlugin extends Plugin {
    private static final String TAG = "PandaFM.Player";
    private static final long TICK_MS = 500;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable ticker = this::tick;
    private Player.Listener listener;
    private int gen = 0;
    private boolean endedSent = false;
    private boolean local = false;
    private String scheme = null;

    interface PlayerTask {
        void run(ExoPlayer player);
    }

    @Override
    public void load() {
        PlaybackService.setRemote((action, position) -> {
            JSObject o = new JSObject();
            o.put("action", action);
            if (position >= 0) o.put("position", position);
            notifyListeners("remote", o);
        });
        // Keep the page's JavaScript alive while backgrounded: it advances the shared queue.
        if (Build.VERSION.SDK_INT >= 26) {
            main.post(() -> {
                try {
                    getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
                } catch (RuntimeException e) {
                    Log.w(TAG, "Couldn't raise the WebView renderer priority", e);
                }
            });
        }
    }

    private void withPlayer(PluginCall call, PlayerTask task) {
        main.post(() -> PlaybackService.whenReady(getContext(), () -> {
            ExoPlayer player = PlaybackService.player();
            if (player == null) {
                call.reject("The player isn't available");
                return;
            }
            attach(player);
            task.run(player);
        }));
    }

    private void attach(ExoPlayer player) {
        if (listener != null) return;
        listener = new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING) {
                    send("loading");
                } else if (state == Player.STATE_READY) {
                    send(player.isPlaying() ? "playing" : player.getPlayWhenReady() ? "loading" : "paused");
                    tick();
                } else if (state == Player.STATE_ENDED && !endedSent) {
                    endedSent = true; // one completion per song
                    tick();
                    send("ended");
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (isPlaying) {
                    send("playing");
                    startTicker();
                } else if (player.getPlaybackState() == Player.STATE_READY && !player.getPlayWhenReady()) {
                    send("paused");
                    tick();
                }
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                // Headphones out or another app took the audio for good: a real pause, recorded as one.
                if (!playWhenReady && (reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY
                        || reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS)) {
                    JSObject o = new JSObject();
                    o.put("action", "pause");
                    notifyListeners("remote", o);
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                String[] kind = PlaybackErrors.classify(error.errorCode, local);
                Log.w(TAG, "Playback error " + error.getErrorCodeName() + " (source " + scheme + ")"); // never the URL
                JSObject o = event("error");
                o.put("kind", kind[0]);
                o.put("reason", kind[1]);
                o.put("code", error.getErrorCodeName());
                notifyListeners("state", o);
            }
        };
        player.addListener(listener);
    }

    private JSObject event(String type) {
        JSObject o = new JSObject();
        o.put("gen", gen);
        o.put("type", type);
        return o;
    }

    private void send(String type) {
        notifyListeners("state", event(type));
    }

    private void startTicker() {
        main.removeCallbacks(ticker);
        main.post(ticker);
    }

    private void tick() {
        ExoPlayer player = PlaybackService.player();
        if (player == null) return;
        JSObject o = event("time");
        o.put("position", player.getCurrentPosition() / 1000.0);
        long duration = player.getDuration();
        o.put("duration", duration == C.TIME_UNSET ? null : (Object) (duration / 1000.0));
        notifyListeners("state", o);
        main.removeCallbacks(ticker);
        if (player.isPlaying()) main.postDelayed(ticker, TICK_MS);
    }

    @PluginMethod
    public void load(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !PlaybackErrors.allowedSource(url)) {
            call.reject("Only PandaFM streams and downloaded files can be played");
            return;
        }
        Integer requested = call.getInt("gen", 0);
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
            .setTitle(call.getString("title", ""))
            .setArtist(call.getString("artist", ""))
            .setAlbumTitle(call.getString("album", null));
        String artwork = call.getString("artworkUrl");
        if (artwork != null && PlaybackErrors.allowedSource(artwork)) meta.setArtworkUri(Uri.parse(artwork)); // lock screen loads it natively
        MediaItem item = new MediaItem.Builder()
            .setMediaId(call.getString("trackId", ""))
            .setUri(Uri.parse(url))
            .setMediaMetadata(meta.build())
            .build();
        withPlayer(call, player -> {
            gen = requested == null ? 0 : requested;
            endedSent = false;
            local = url.startsWith("content://");
            scheme = PlaybackErrors.scheme(url);
            player.setMediaItem(item);
            player.prepare();
            call.resolve();
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        withPlayer(call, player -> {
            player.play();
            startTicker();
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withPlayer(call, player -> {
            player.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double seconds = call.getDouble("position");
        withPlayer(call, player -> {
            player.seekTo((long) ((seconds == null ? 0 : seconds) * 1000));
            tick();
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        withPlayer(call, player -> {
            player.stop();
            player.clearMediaItems();
            main.removeCallbacks(ticker);
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        withPlayer(call, player -> {
            player.setVolume((float) Math.max(0, Math.min(1, volume == null ? 1 : volume)));
            call.resolve();
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        withPlayer(call, player -> {
            JSObject o = new JSObject();
            o.put("engine", "Media3 ExoPlayer " + MediaLibraryInfo.VERSION);
            o.put("isPlaying", player.isPlaying());
            o.put("position", player.getCurrentPosition() / 1000.0);
            long duration = player.getDuration();
            o.put("duration", duration == C.TIME_UNSET ? null : (Object) (duration / 1000.0));
            o.put("uriScheme", scheme);
            MediaItem current = player.getCurrentMediaItem();
            o.put("mediaId", current == null ? null : current.mediaId);
            call.resolve(o);
        });
    }
}
