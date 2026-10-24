package app.pandafm.client;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import java.util.ArrayList;
import java.util.List;

/**
 * PandaFM's playback lives here, not in the Activity: a Media3
 * MediaSessionService owning one ExoPlayer and one MediaSession. Media3 shows
 * the media notification and keeps the service in the foreground while music
 * plays, so it continues with the screen locked or another app open.
 * Everything runs on the main thread.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlaybackService extends MediaSessionService {
    private static PlaybackService instance;
    private static final List<Runnable> waiting = new ArrayList<>();
    private static RemoteAwarePlayer.Remote remote;

    private ExoPlayer player;
    private MediaSession session;

    /** Run once the service and its player exist (starting the service if needed). Main thread only. */
    static void whenReady(Context ctx, Runnable task) {
        if (instance != null) {
            task.run();
            return;
        }
        waiting.add(task);
        if (waiting.size() == 1) ctx.startService(new Intent(ctx, PlaybackService.class));
    }

    static ExoPlayer player() {
        return instance == null ? null : instance.player;
    }

    /** Where system media-control commands go (the PandaPlayer plugin, then the web app's queue). */
    static void setRemote(RemoteAwarePlayer.Remote listener) {
        remote = listener;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setUserAgent("PandaFM-Android")
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
            .setAllowCrossProtocolRedirects(false);
        // http(s) streams from the PandaFM server, content:// downloads in the chosen folder.
        DefaultDataSource.Factory sources = new DefaultDataSource.Factory(this, http);
        AudioAttributes music = new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build();
        player = new ExoPlayer.Builder(this)
            .setAudioAttributes(music, /* handleAudioFocus= */ true) // standard focus: pause for calls, duck for navigation
            .setHandleAudioBecomingNoisy(true) // headphones unplugged: pause
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(sources))
            .build();
        RemoteAwarePlayer sessionPlayer = new RemoteAwarePlayer(player, (action, position) -> {
            RemoteAwarePlayer.Remote r = remote;
            if (r != null) r.command(action, position);
        });
        MediaSession.Builder builder = new MediaSession.Builder(this, sessionPlayer);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            builder.setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        session = builder.build();
        addSession(session); // notification and foreground handling even before any controller connects
        instance = this;
        List<Runnable> ready = new ArrayList<>(waiting);
        waiting.clear();
        for (Runnable task : ready) task.run();
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The queue lives in the app. Swiped away, nothing could choose the next song, so stop cleanly.
        if (player != null) player.stop();
        stopSelf();
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (session != null) session.release();
        if (player != null) player.release();
        session = null;
        player = null;
        super.onDestroy();
    }
}
