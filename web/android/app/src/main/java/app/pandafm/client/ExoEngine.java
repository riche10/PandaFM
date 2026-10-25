package app.pandafm.client;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.Collections;
import java.util.concurrent.ExecutorService;

/**
 * Plays ONE queue item in ExoPlayer and reports what happens, tagged with
 * the load's generation. It never decides what comes next (QueueController
 * does): the seam where Panda Mix (5.1) can put two decks.
 */
@OptIn(markerClass = UnstableApi.class)
final class ExoEngine implements QueueController.Engine {
    private final Context ctx;
    private final ExoPlayer player;
    private final ExecutorService io;
    private final Handler main = new Handler(Looper.getMainLooper());
    private QueueController controller;
    private int gen;
    private boolean endedSent;
    private boolean local;

    ExoEngine(Context ctx, ExoPlayer player, ExecutorService io) {
        this.ctx = ctx.getApplicationContext();
        this.player = player;
        this.io = io;
    }

    void attach(QueueController c) {
        controller = c;
        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                controller.onPlayingChanged(gen, isPlaying);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) controller.onReady(gen, player.getPlayWhenReady());
                if (state == Player.STATE_ENDED && !endedSent) {
                    endedSent = true; // one completion per load
                    controller.onEnded(gen);
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                String[] kind = PlaybackErrors.classify(error.errorCode, local);
                controller.onError(gen, kind[1]);
            }
        });
    }

    @Override
    public void load(int forGen, QueueItem item, String uri, long startMs, boolean play) {
        gen = forGen;
        endedSent = false;
        local = uri.startsWith("content://");
        MediaMetadata.Builder meta = new MediaMetadata.Builder().setTitle(item.title()).setArtist(item.artist()).setAlbumTitle(item.album());
        MediaItem media = new MediaItem.Builder().setMediaId("track:" + item.trackId()).setUri(Uri.parse(uri)).setMediaMetadata(meta.build()).build();
        player.setMediaItem(media, startMs);
        player.setPlayWhenReady(play);
        player.prepare();
        if (item.coverArtId() != null) artwork(forGen, item, uri, meta);
    }

    /** Lock screen / car artwork: fetched with the sign-in (or from the saved copy), never a URL with a token. */
    private void artwork(int forGen, QueueItem item, String uri, MediaMetadata.Builder meta) {
        String server = AuthStore.get(ctx).server();
        if (server == null) return;
        String coverUrl = AuthCore.base(server) + "/api/covers/" + LibraryTree.enc(item.coverArtId()) + "?size=600";
        io.execute(() -> {
            byte[] bytes = null;
            HttpURLConnection c = null;
            try {
                c = AuthHttp.open(ctx, coverUrl, Collections.<String, String>emptyMap(), 10_000, 15_000);
                if (c.getResponseCode() == 200) {
                    try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                        byte[] buf = new byte[16384];
                        int n;
                        while ((n = in.read(buf)) > 0 && out.size() < 4 << 20) out.write(buf, 0, n);
                        bytes = out.toByteArray();
                    }
                }
            } catch (java.io.IOException ignored) {
                // offline: no artwork
            } finally {
                if (c != null) c.disconnect();
            }
            if (bytes == null || bytes.length == 0) return;
            byte[] art = bytes;
            main.post(() -> {
                if (gen != forGen || player.getCurrentMediaItem() == null) return;
                MediaItem withArt = new MediaItem.Builder().setMediaId("track:" + item.trackId()).setUri(Uri.parse(uri))
                    .setMediaMetadata(meta.setArtworkData(art, MediaMetadata.PICTURE_TYPE_FRONT_COVER).build()).build();
                player.replaceMediaItem(player.getCurrentMediaItemIndex(), withArt);
            });
        });
    }

    @Override public void play() { player.play(); }
    @Override public void pause() { player.pause(); }
    @Override public void seekTo(long ms) { player.seekTo(ms); }
    @Override public long positionMs() { return Math.max(0, player.getCurrentPosition()); }

    @Override
    public long durationMs() {
        long d = player.getDuration();
        return d < 0 ? 0 : d;
    }

    @Override
    public void stop() {
        player.stop();
        player.clearMediaItems();
    }

    void setVolume(float v) {
        player.setVolume(v);
    }
}
