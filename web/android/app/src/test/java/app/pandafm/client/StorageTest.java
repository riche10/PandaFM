package app.pandafm.client;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

/** Plain-JVM checks of the native path safety and checksum helpers. */
public class StorageTest {
    @Test
    public void splitsCleanRelativePaths() {
        assertArrayEquals(new String[] {"Music", "AC_DC", "Back", "01 - Hells Bells.flac"}, Storage.split("Music/AC_DC/Back/01 - Hells Bells.flac"));
    }

    @Test
    public void rejectsPathsThatCouldLeaveTheFolder() {
        for (String bad : new String[] {"", "/abs/x.mp3", "Music/../../x.mp3", "Music/./x.mp3", "Music//x.mp3", "Music\\x.mp3", null}) {
            try {
                Storage.split(bad);
                fail("accepted " + bad);
            } catch (IllegalArgumentException expected) {
                // good
            }
        }
    }

    @Test
    public void hexMatchesKnownSha256() throws Exception {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest("abc".getBytes("UTF-8"));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Downloader.hex(digest));
    }
}
