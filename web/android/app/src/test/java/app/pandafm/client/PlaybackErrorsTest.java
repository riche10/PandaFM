package app.pandafm.client;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Plain-JVM checks of native playback's source rules and error mapping. */
public class PlaybackErrorsTest {
    @Test
    public void onlyServerStreamsAndDownloadsCanBePlayed() {
        assertTrue(PlaybackErrors.allowedSource("http://192.168.10.65:8086/api/tracks/1uOagxAvF38VNRASsFn2l7/stream"));
        assertTrue(PlaybackErrors.allowedSource("https://music.example.com/api/tracks/x/stream"));
        assertTrue(PlaybackErrors.allowedSource("content://com.android.externalstorage.documents/tree/1234-ABCD%3APandaFM/document/x.flac"));
        for (String bad : new String[] {"file:///sdcard/x.flac", "javascript:alert(1)", "rtsp://x", "/api/tracks/x/stream", "", null}) {
            assertFalse(String.valueOf(bad), PlaybackErrors.allowedSource(bad));
        }
        assertEquals("content", PlaybackErrors.scheme("CONTENT://x"));
    }

    @Test
    public void media3ErrorsBecomeListenerFacingKinds() {
        assertArrayEquals(new String[] {"network", "connect"}, PlaybackErrors.classify(2001, false));
        assertArrayEquals(new String[] {"network", "cleartext"}, PlaybackErrors.classify(2007, false));
        assertArrayEquals(new String[] {"missing", "not_found"}, PlaybackErrors.classify(2005, true));
        assertArrayEquals(new String[] {"network", "not_found"}, PlaybackErrors.classify(2005, false));
        assertArrayEquals(new String[] {"missing", "no_permission"}, PlaybackErrors.classify(2006, true));
        assertArrayEquals(new String[] {"unsupported", "format"}, PlaybackErrors.classify(4005, false));
        assertArrayEquals(new String[] {"decode", "decode"}, PlaybackErrors.classify(4003, false));
        assertArrayEquals(new String[] {"decode", "decode"}, PlaybackErrors.classify(3001, true));
        assertArrayEquals(new String[] {"unknown", "other"}, PlaybackErrors.classify(1000, false));
    }
}
