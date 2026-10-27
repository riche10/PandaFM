package app.pandafm.client;

import static app.pandafm.client.PlaybackStateModel.STATE_BUFFERING;
import static app.pandafm.client.PlaybackStateModel.STATE_ENDED;
import static app.pandafm.client.PlaybackStateModel.STATE_IDLE;
import static app.pandafm.client.PlaybackStateModel.STATE_READY;
import static app.pandafm.client.PlaybackStateModel.derive;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Media3 facts → PandaFM state: isPlaying=false alone is never a pause. */
public class PlaybackStateModelTest {
    @Test
    public void theStateTable() {
        assertEquals("buffering", derive(STATE_BUFFERING, true, false, 0, false)); // waiting for data: NOT paused
        assertEquals("playing", derive(STATE_READY, true, true, 0, false));
        assertEquals("buffering", derive(STATE_READY, true, false, 1, false)); // brief audio-focus loss: still meant to play
        assertEquals("paused", derive(STATE_READY, false, false, 0, false)); // the one real pause
        assertEquals("paused", derive(STATE_BUFFERING, false, false, 0, false));
        assertEquals("loading", derive(STATE_IDLE, true, false, 0, false));
        assertEquals("ended", derive(STATE_ENDED, true, false, 0, false));
        assertEquals("error", derive(STATE_READY, true, true, 0, true));
    }

    @Test
    public void intentToPlayCoversBuffering() {
        for (String s : new String[] {"playing", "loading", "buffering"}) assertTrue(s, PlaybackStateModel.intendsToPlay(s));
        for (String s : new String[] {"paused", "idle", "ended", "error"}) assertFalse(s, PlaybackStateModel.intendsToPlay(s));
    }

    @Test
    public void theTimelineTicksWhilePlaybackIsIntended() {
        assertTrue(PandaPlayerPlugin.shouldTick("buffering")); // 5.0.1 stopped here and never restarted
        assertTrue(PandaPlayerPlugin.shouldTick("playing"));
        assertFalse(PandaPlayerPlugin.shouldTick("paused"));
    }

    @Test
    public void swipingAwayKeepsPlaybackThatIsMeantToContinue() {
        assertFalse(PlaybackService.stopOnTaskRemoved(true, true)); // playing or buffering: keep going
        assertTrue(PlaybackService.stopOnTaskRemoved(false, true)); // genuinely paused
        assertTrue(PlaybackService.stopOnTaskRemoved(true, false)); // nothing queued
    }
}
