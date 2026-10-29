package app.pandafm.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** 5.4.1 self-hosted updates: manifest, versions and verification, without Android. */
public class UpdateCoreTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String SHA = "a".repeat(64);

    static String manifest(String overrides) {
        String base = "\"platform\":\"android\",\"versionName\":\"5.4.1\",\"versionCode\":50401,\"filename\":\"PandaFM-5.4.1.apk\","
            + "\"downloadUrl\":\"/downloads/android/PandaFM-5.4.1.apk\",\"sha256\":\"" + SHA + "\",\"size\":12345678,\"notes\":\"Playback\"";
        return "{" + base + (overrides.isEmpty() ? "" : "," + overrides) + "}"; // later keys win
    }

    static void rejected(String json) {
        try {
            UpdateCore.parse(json);
            fail("accepted: " + json);
        } catch (UpdateCore.BadManifest expected) {
            // good
        }
    }

    @Test
    public void aValidManifestIsAccepted() throws Exception {
        UpdateCore.Release r = UpdateCore.parse(manifest(""));
        assertEquals("5.4.1", r.versionName);
        assertEquals(50401, r.versionCode);
        assertEquals("/downloads/android/PandaFM-5.4.1.apk", r.downloadUrl);
        assertEquals(12345678, r.size);
        assertEquals("Playback", r.notes);
    }

    @Test
    public void malformedIncompleteOrUnsafeManifestsAreRejected() {
        rejected("{not json");
        rejected("[]");
        rejected("{\"platform\":\"android\"}");
        rejected(manifest("\"platform\":\"ios\""));
        rejected(manifest("\"versionCode\":\"50401\""));
        rejected(manifest("\"versionCode\":0"));
        rejected(manifest("\"versionName\":\"5.4.1; rm -rf /\""));
        rejected(manifest("\"filename\":\"../../evil.apk\""));
        rejected(manifest("\"filename\":\"PandaFM-5.4.1.apk/../../x.apk\""));
        rejected(manifest("\"filename\":\"other.apk\""));
        rejected(manifest("\"downloadUrl\":\"https://evil.example.com/PandaFM-5.4.1.apk\"")); // never another host
        rejected(manifest("\"downloadUrl\":\"/downloads/android/../../PandaFM-5.4.1.apk\""));
        rejected(manifest("\"sha256\":\"abc\""));
        rejected(manifest("\"size\":-5"));
        rejected(manifest("\"size\":999999999999"));
    }

    @Test
    public void onlyTheVersionCodeDecides() {
        assertEquals("available", UpdateCore.status(50400, 50401));
        assertEquals("current", UpdateCore.status(50401, 50401));
        assertEquals("newer-installed", UpdateCore.status(50500, 50401)); // never offer a downgrade
        assertEquals("available", UpdateCore.status(50900, 51000)); // "5.10.0" > "5.9.0" though the names sort the other way
    }

    @Test
    public void sha256OfAKnownInput() throws Exception {
        File f = tmp.newFile("x");
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", UpdateCore.sha256(f));
        Files.write(f.toPath(), "abc".getBytes(StandardCharsets.UTF_8));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", UpdateCore.sha256(f));
    }

    @Test
    public void aDownloadMustBeExactlyTheAnnouncedPandaFMSignedWithTheSameKey() throws Exception {
        UpdateCore.Release r = UpdateCore.parse(manifest(""));
        Set<String> ours = new HashSet<>(Collections.singletonList("cert-ours"));
        assertTrue(UpdateCore.problem(null, r, ours).contains("couldn’t read"));
        assertTrue(UpdateCore.problem(new UpdateCore.ApkFacts("com.evil.app", 50401, ours), r, ours).contains("isn’t PandaFM"));
        assertTrue(UpdateCore.problem(new UpdateCore.ApkFacts(UpdateCore.PACKAGE, 50400, ours), r, ours).contains("not the 50401"));
        assertTrue(UpdateCore.problem(new UpdateCore.ApkFacts(UpdateCore.PACKAGE, 50401, new HashSet<>()), r, ours).contains("isn’t signed"));
        String other = UpdateCore.problem(new UpdateCore.ApkFacts(UpdateCore.PACKAGE, 50401, new HashSet<>(Arrays.asList("cert-other"))), r, ours);
        assertTrue(other.contains("different key") && other.contains("Nothing was installed"));
        assertNull(UpdateCore.problem(new UpdateCore.ApkFacts(UpdateCore.PACKAGE, 50401, new HashSet<>(ours)), r, ours));
    }

    @Test
    public void spaceUrlsAndCleanup() throws Exception {
        assertFalse(UpdateCore.enoughSpace(20L << 20, 15L << 20)); // needs a margin
        assertTrue(UpdateCore.enoughSpace(100L << 20, 15L << 20));
        UpdateCore.Release r = UpdateCore.parse(manifest(""));
        assertEquals("https://music.example.com/downloads/android/PandaFM-5.4.1.apk", UpdateCore.downloadUrl("https://music.example.com/", r));
        assertEquals("http://192.168.1.20:8086/downloads/android/PandaFM-5.4.1.apk", UpdateCore.downloadUrl("http://192.168.1.20:8086", r));
        File dir = tmp.newFolder("updates");
        for (String n : new String[] {"PandaFM-5.4.1.apk", "PandaFM-5.4.1.apk.part", "PandaFM-5.4.0.apk"}) new File(dir, n).createNewFile();
        UpdateCore.cleanup(dir, r);
        assertEquals(Collections.singletonList("PandaFM-5.4.1.apk"), Arrays.asList(dir.list()));
        UpdateCore.cleanup(dir, null);
        assertEquals(0, dir.list().length);
    }

    @Test
    public void theFileProviderSharesOnlyThePrivateUpdatesFolder() throws Exception {
        String xml = new String(Files.readAllBytes(Paths.get("src/main/res/xml/file_paths.xml")), StandardCharsets.UTF_8);
        assertFalse("no external storage", xml.contains("external-path") || xml.contains("external-files-path") || xml.contains("root-path"));
        assertTrue(xml.contains("<cache-path name=\"updates\" path=\"" + UpdatePlugin.DIR + "/\" />"));
        assertEquals(1, xml.split("-path ").length - 1);
    }

    @Test
    public void theManifestAsksOnlyForWhatUpdatesNeed() throws Exception {
        String m = new String(Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")), StandardCharsets.UTF_8);
        assertTrue(m.contains("android.permission.REQUEST_INSTALL_PACKAGES"));
        for (String broad : new String[] {"READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "MANAGE_EXTERNAL_STORAGE", "INSTALL_PACKAGES\" />\n    <uses-permission android:name=\"android.permission.DELETE"}) {
            assertFalse(broad, m.contains("android.permission." + broad));
        }
        assertTrue(m.contains("android:authorities=\"${applicationId}.fileprovider\""));
    }
}
