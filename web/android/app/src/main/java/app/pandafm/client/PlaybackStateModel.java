package app.pandafm.client;

/**
 * PandaFM's playback state from Media3's facts together (5.1), not from
 * isPlaying alone: isPlaying=false also happens while buffering, while audio
 * focus is briefly lost, or between states. Only playWhenReady=false is a pause.
 * Pure, so the whole table is unit-tested.
 */
final class PlaybackStateModel {
    // Media3 Player.STATE_* values
    static final int STATE_IDLE = 1, STATE_BUFFERING = 2, STATE_READY = 3, STATE_ENDED = 4;

    private PlaybackStateModel() {}

    /** idle | loading | buffering | playing | paused | ended | error */
    static String derive(int playbackState, boolean playWhenReady, boolean isPlaying, int suppressionReason, boolean failed) {
        if (failed) return "error";
        switch (playbackState) {
            case STATE_ENDED:
                return "ended";
            case STATE_IDLE:
                return playWhenReady ? "loading" : "paused";
            case STATE_BUFFERING:
                return playWhenReady ? "buffering" : "paused"; // waiting for data, still meaning to play
            case STATE_READY:
                if (!playWhenReady) return "paused"; // the one real pause
                return isPlaying ? "playing" : "buffering"; // suppressed (e.g. a moment of lost audio focus) still means to play
            default:
                return playWhenReady ? "loading" : "paused";
        }
    }

    /** Statuses in which PandaFM still means to make sound (the timeline keeps updating). */
    static boolean intendsToPlay(String status) {
        return "playing".equals(status) || "loading".equals(status) || "buffering".equals(status);
    }
}
