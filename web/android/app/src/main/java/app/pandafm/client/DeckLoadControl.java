package app.pandafm.client;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultLoadControl;

/**
 * Media3's default buffering, except while this deck is the standby (5.4): a warmed next song
 * (or a Panda Mix incoming song) only buffers a few seconds ahead, enough for an instant start
 * without downloading the whole next track early. The logical deck buffers as usual.
 */
@OptIn(markerClass = UnstableApi.class)
final class DeckLoadControl extends DefaultLoadControl {
    static final long STANDBY_AHEAD_US = 8_000_000L;
    volatile boolean standby;

    @Override
    public boolean shouldContinueLoading(Parameters parameters) {
        if (standby && parameters.bufferedDurationUs >= STANDBY_AHEAD_US) return false;
        return super.shouldContinueLoading(parameters);
    }
}
