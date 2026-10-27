package app.pandafm.client;

/** Where a playback deck reports: QueueController (one deck), or PandaDjEngine (two decks, 5.2). */
interface PlaybackSink {
    void onEngineState(int gen, String state);
    void onEnded(int gen);
    void onError(int gen, String message);
}
