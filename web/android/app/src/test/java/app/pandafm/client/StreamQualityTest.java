package app.pandafm.client;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Native streaming quality is decided per song, for the network at that moment. */
public class StreamQualityTest {
    @Test
    public void autoFollowsTheNetworkAndChoicesWin() {
        assertEquals("original", StreamQuality.resolve("auto", false, true));
        assertEquals("high", StreamQuality.resolve("auto", true, false)); // mobile data
        assertEquals("original", StreamQuality.resolve("auto", true, true)); // metered Wi-Fi hotspot counts as Wi-Fi
        assertEquals("low", StreamQuality.resolve("low", false, true));
        assertEquals("original", StreamQuality.resolve("original", true, false));
        assertEquals("original", StreamQuality.resolve(null, false, true));
    }

    @Test
    public void onlyTheQualityGoesIntoTheUrl() {
        assertEquals("https://m.example.com/api/tracks/a%20b/stream", StreamQuality.streamUrl("https://m.example.com/", "a b", "original"));
        assertEquals("https://m.example.com/api/tracks/x/stream?quality=high", StreamQuality.streamUrl("https://m.example.com", "x", "high"));
    }
}
