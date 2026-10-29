package app.pandafm.client;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;

/**
 * The ExoPlayer side of EngineCore (5.1): a thin PlayerPort plus the listener
 * that forwards every relevant Media3 change. No playback decisions here.
 */
@OptIn(markerClass = UnstableApi.class)
final class ExoEngine implements EngineCore.PlayerPort {
    static final String TAG = "PandaFM.Playback";
    private final ExoPlayer player;
    final EngineCore core;

    ExoEngine(Context ctx, ExoPlayer player) {
        this.player = player;
        Context app = ctx.getApplicationContext();
        Handler main = new Handler(Looper.getMainLooper());
        core = new EngineCore(this, main::postDelayed, new EngineCore.Logger() {
            public void info(String m) { Log.i(TAG, m); }
            public void warn(String m) { Log.w(TAG, m); }
        }, new EngineCore.Hooks() {
            public void expireAccessToken() { AuthStore.get(app).expireAccess(); }
            public boolean signedIn() { return AuthStore.get(app).signedIn(); }
            public String artworkUriFor(String coverArtId) {
                ArtworkProvider.grantToKnownHosts(app, coverArtId); // the car may show what plays
                return ArtworkProvider.uriFor(coverArtId).toString();
            }
            public long nowMs() { return System.currentTimeMillis(); }
        });
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) core.onEnded();
                else core.onPlayerChanged();
            }
            @Override public void onIsPlayingChanged(boolean isPlaying) { core.onPlayerChanged(); }
            @Override public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) { core.onPlayerChanged(); }
            @Override public void onPlaybackSuppressionReasonChanged(int reason) { core.onPlayerChanged(); }
            @Override public void onPlayerError(PlaybackException error) { core.onError(error.errorCode, error.getErrorCodeName(), httpFailureOf(error)); }
        });
    }

    /**
     * Artwork is a content:// URI (ArtworkProvider) that Media3's own bitmap loader resolves
     * for the notification, lock screen and car: the playing MediaItem is never replaced.
     */
    @Override
    public void setMediaItem(String mediaId, String uri, long startMs, String title, String artist, String album, String artworkUri) {
        MediaMetadata.Builder meta = new MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album);
        if (artworkUri != null) meta.setArtworkUri(Uri.parse(artworkUri));
        player.setMediaItem(new MediaItem.Builder().setMediaId(mediaId).setUri(Uri.parse(uri)).setMediaMetadata(meta.build()).build(), startMs);
    }

    @Override public void prepare() { player.prepare(); }
    @Override public void setPlayWhenReady(boolean play) { player.setPlayWhenReady(play); }
    @Override public boolean playWhenReady() { return player.getPlayWhenReady(); }
    @Override public int playbackState() { return player.getPlaybackState(); }
    @Override public boolean isPlaying() { return player.isPlaying(); }
    @Override public int suppressionReason() { return player.getPlaybackSuppressionReason(); }
    @Override public long position() { return player.getCurrentPosition(); }

    @Override
    public long duration() {
        long d = player.getDuration();
        return d < 0 ? 0 : d;
    }

    @Override public boolean seekable() { return player.isCurrentMediaItemSeekable(); }
    @Override public void seekTo(long ms) { player.seekTo(ms); }

    @Override
    public void stop() {
        player.stop();
        player.clearMediaItems();
    }

    @Override
    public void setVolume(float v) {
        player.setVolume(v);
    }

    private DeckLoadControl loadControl;

    void useLoadControl(DeckLoadControl control) {
        loadControl = control;
    }

    @Override
    public void setStandbyBuffering(boolean standby) {
        if (loadControl != null) loadControl.standby = standby;
    }

    @Override
    public long bufferedMs() {
        return player.getTotalBufferedDuration();
    }

    /** 5.4.2: the real HTTP answer behind ERROR_CODE_IO_BAD_HTTP_STATUS (status, Retry-After, PandaFM's code). */
    static HttpFailure httpFailureOf(Throwable error) {
        for (Throwable t = error; t != null; t = t.getCause()) {
            if (t instanceof HttpDataSource.InvalidResponseCodeException) {
                HttpDataSource.InvalidResponseCodeException e = (HttpDataSource.InvalidResponseCodeException) t;
                String code = header(e.headerFields, "X-PandaFM-Error");
                if (code == null || !code.matches("[a-z_]{1,40}")) code = HttpFailure.codeFromBody(e.responseBody);
                return new HttpFailure(e.responseCode, HttpFailure.seconds(header(e.headerFields, "Retry-After")), code);
            }
            if (t.getCause() == t) break;
        }
        return null;
    }

    static String header(java.util.Map<String, java.util.List<String>> headers, String name) {
        if (headers == null) return null;
        for (java.util.Map.Entry<String, java.util.List<String>> h : headers.entrySet()) {
            if (h.getKey() != null && h.getKey().equalsIgnoreCase(name) && h.getValue() != null && !h.getValue().isEmpty()) return h.getValue().get(0);
        }
        return null;
    }

}
