package app.pandafm.client;

import androidx.annotation.OptIn;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;

/**
 * The player the MediaSession exposes to the system: lock screen, notification,
 * Bluetooth, headsets, Walkman buttons. Play/pause/seek take effect at once and
 * are also reported to the web app, so the shared queue records them like its
 * own buttons. Next/previous are only reported: the shared PandaFM queue
 * decides what plays next (queue, radio, Autoplay), never Android.
 * The app's own commands bypass this wrapper (they go to ExoPlayer directly).
 */
@OptIn(markerClass = UnstableApi.class)
final class RemoteAwarePlayer extends ForwardingPlayer {
    interface Remote {
        void command(String action, double positionSeconds);
    }

    private final Remote remote;

    RemoteAwarePlayer(Player player, Remote remote) {
        super(player);
        this.remote = remote;
    }

    @Override
    public void play() {
        super.play();
        remote.command("play", -1);
    }

    @Override
    public void pause() {
        super.pause();
        remote.command("pause", -1);
    }

    @Override
    public void setPlayWhenReady(boolean playWhenReady) {
        super.setPlayWhenReady(playWhenReady);
        remote.command(playWhenReady ? "play" : "pause", -1);
    }

    @Override
    public void seekTo(long positionMs) {
        super.seekTo(positionMs);
        remote.command("seek", positionMs / 1000.0);
    }

    @Override
    public void seekToNext() {
        remote.command("next", -1);
    }

    @Override
    public void seekToNextMediaItem() {
        remote.command("next", -1);
    }

    @Override
    public void seekToPrevious() {
        remote.command("previous", -1);
    }

    @Override
    public void seekToPreviousMediaItem() {
        remote.command("previous", -1);
    }

    /** Always offer next/previous: the shared queue answers them (previous restarts the song at the start of a queue). */
    @Override
    public Player.Commands getAvailableCommands() {
        return super.getAvailableCommands().buildUpon()
            .addAll(COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, COMMAND_SEEK_TO_PREVIOUS, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .build();
    }

    @Override
    public boolean isCommandAvailable(int command) {
        return command == COMMAND_SEEK_TO_NEXT || command == COMMAND_SEEK_TO_NEXT_MEDIA_ITEM
            || command == COMMAND_SEEK_TO_PREVIOUS || command == COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
            || super.isCommandAvailable(command);
    }
}
