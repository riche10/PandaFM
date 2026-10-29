package app.pandafm.client;

/** Where a playback deck reports: QueueController (one deck), or PandaDjEngine (two decks, 5.2). */
interface PlaybackSink {
    void onEngineState(int gen, String state);
    void onEnded(int gen);
    void onError(int gen, String message);

    /** 5.4.2: the server says this song no longer exists (HTTP 404/410). */
    default void onUnavailable(int gen, String message) {
        onError(gen, message);
    }
}
