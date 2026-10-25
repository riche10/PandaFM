package app.pandafm.client;

import androidx.annotation.OptIn;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import java.util.List;

/**
 * The player the media session shows the system (lock screen, notification,
 * Bluetooth, headsets, the Walkman's buttons, Android Auto). Every command
 * goes straight to the native queue: next/previous work with or without the
 * app's screen, and media items Android Auto sets become a PandaFM queue.
 */
@OptIn(markerClass = UnstableApi.class)
final class QueuePlayer extends ForwardingPlayer {
    interface Library {
        /** Media items prepared by the library callback (a resolved queue or radio). */
        void apply(List<MediaItem> items, int startIndex);
    }

    private final QueueController controller;
    private final Library library;

    QueuePlayer(Player player, QueueController controller, Library library) {
        super(player);
        this.controller = controller;
        this.library = library;
    }

    @Override public void play() { controller.play(); }
    @Override public void pause() { controller.pause(); }

    @Override
    public void setPlayWhenReady(boolean playWhenReady) {
        if (playWhenReady) controller.play();
        else controller.pause();
    }

    @Override public void prepare() { /* the queue loads what it plays */ }
    @Override public void seekTo(long positionMs) { controller.seekTo(positionMs); }
    @Override public void seekToNext() { controller.next(); }
    @Override public void seekToNextMediaItem() { controller.next(); }
    @Override public void seekToPrevious() { controller.previous(); }
    @Override public void seekToPreviousMediaItem() { controller.previous(); }
    @Override public void stop() { controller.pause(); }

    @Override public void setMediaItems(List<MediaItem> items) { library.apply(items, 0); }
    @Override public void setMediaItems(List<MediaItem> items, boolean resetPosition) { library.apply(items, 0); }
    @Override public void setMediaItems(List<MediaItem> items, int startIndex, long startPositionMs) { library.apply(items, Math.max(0, startIndex)); }
    @Override public void setMediaItem(MediaItem item) { library.apply(java.util.Collections.singletonList(item), 0); }
    @Override public void setMediaItem(MediaItem item, long startPositionMs) { library.apply(java.util.Collections.singletonList(item), 0); }
    @Override public void setMediaItem(MediaItem item, boolean resetPosition) { library.apply(java.util.Collections.singletonList(item), 0); }

    @Override
    public void setShuffleModeEnabled(boolean enabled) {
        if (enabled != controller.queue.shuffle) controller.toggleShuffle();
    }

    @Override public boolean getShuffleModeEnabled() { return controller.queue.shuffle; }

    @Override
    public void setRepeatMode(int repeatMode) {
        String want = repeatMode == Player.REPEAT_MODE_ONE ? "one" : repeatMode == Player.REPEAT_MODE_ALL ? "all" : "off";
        for (int k = 0; k < 3 && !want.equals(controller.queue.repeat); k++) controller.cycleRepeat();
    }

    @Override
    public int getRepeatMode() {
        return "one".equals(controller.queue.repeat) ? Player.REPEAT_MODE_ONE : "all".equals(controller.queue.repeat) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF;
    }

    @Override
    public Player.Commands getAvailableCommands() {
        Player.Commands.Builder b = super.getAvailableCommands().buildUpon();
        if (controller.queue.current() != null) {
            b.addAll(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SET_SHUFFLE_MODE, Player.COMMAND_SET_REPEAT_MODE);
        }
        b.addAll(Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS);
        return b.build();
    }

    @Override
    public boolean isCommandAvailable(int command) {
        return getAvailableCommands().contains(command);
    }
}
