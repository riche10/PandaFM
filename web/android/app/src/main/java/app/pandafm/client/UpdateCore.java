package app.pandafm.client;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Self-hosted Android updates (5.4.1), the parts that need no Android: what the server's manifest
 * may say, whether it is newer, and whether a downloaded APK is exactly the PandaFM update it
 * claims to be. PandaFM never installs anything itself: Android's installer asks the user.
 */
final class UpdateCore {
    static final String PACKAGE = "app.pandafm.client";
    static final String APK_MIME = "application/vnd.android.package-archive";
    static final String MANIFEST_PATH = "/api/releases/android/latest";
    static final long SPACE_MARGIN = 32L * 1024 * 1024;
    static final long MAX_APK_BYTES = 512L * 1024 * 1024;
    private static final Pattern FILENAME = Pattern.compile("^PandaFM-[0-9A-Za-z][0-9A-Za-z.+-]{0,39}\\.apk$");
    private static final Pattern VERSION_NAME = Pattern.compile("^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");

    private UpdateCore() {}

    static final class BadManifest extends Exception {
        BadManifest(String why) {
            super(why);
        }
    }

    /** The release the server offers (validated: nothing here can point elsewhere or traverse paths). */
    static final class Release {
        final String versionName, filename, downloadUrl, sha256, notes, releasedAt;
        final long versionCode, size;

        Release(String versionName, long versionCode, String filename, String sha256, long size, String notes, String releasedAt) {
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.filename = filename;
            this.downloadUrl = "/downloads/android/" + filename; // relative: always this PandaFM server
            this.sha256 = sha256;
            this.size = size;
            this.notes = notes;
            this.releasedAt = releasedAt;
        }
    }

    static Release parse(String json) throws BadManifest {
        Map<String, Object> m = Json.map(Json.tryParse(json));
        if (m == null) throw new BadManifest("not JSON");
        if (!"android".equals(m.get("platform"))) throw new BadManifest("not an Android release");
        String name = Json.str(m, "versionName"), filename = Json.str(m, "filename"), sha = Json.str(m, "sha256"), url = Json.str(m, "downloadUrl");
        Object code = m.get("versionCode"), size = m.get("size");
        if (name == null || !VERSION_NAME.matcher(name).matches()) throw new BadManifest("versionName");
        if (!(code instanceof Long) || (Long) code <= 0 || (Long) code > 2_100_000_000L) throw new BadManifest("versionCode");
        if (filename == null || !FILENAME.matcher(filename).matches()) throw new BadManifest("filename");
        if (url != null && !url.equals("/downloads/android/" + filename)) throw new BadManifest("downloadUrl must be this server's /downloads/android/" + filename);
        if (sha == null || !SHA256.matcher(sha).matches()) throw new BadManifest("sha256");
        if (!(size instanceof Long) || (Long) size <= 0 || (Long) size > MAX_APK_BYTES) throw new BadManifest("size");
        String notes = Json.str(m, "notes"), released = Json.str(m, "releasedAt");
        return new Release(name, (Long) code, filename, sha, (Long) size, notes == null ? null : notes.substring(0, Math.min(notes.length(), 2000)), released);
    }

    /** Only versionCode decides: never a downgrade, never because a name sorts differently. */
    static String status(long installedCode, long serverCode) {
        if (serverCode > installedCode) return "available";
        if (serverCode == installedCode) return "current";
        return "newer-installed";
    }

    static boolean enoughSpace(long usableBytes, long apkBytes) {
        return usableBytes >= apkBytes + SPACE_MARGIN;
    }

    /** Where to download from: this PandaFM server's origin and the manifest's relative path. */
    static String downloadUrl(String server, Release r) {
        String base = server.endsWith("/") ? server.substring(0, server.length() - 1) : server;
        return base + r.downloadUrl;
    }

    static String sha256(File file) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        return hex(md.digest());
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    /** What Android says about a downloaded APK (null when it can't read it). */
    static final class ApkFacts {
        final String packageName;
        final long versionCode;
        final Set<String> signers; // SHA-256 of the current signing certificate(s)

        ApkFacts(String packageName, long versionCode, Set<String> signers) {
            this.packageName = packageName;
            this.versionCode = versionCode;
            this.signers = signers;
        }
    }

    /**
     * Null when the download is exactly the announced PandaFM update, signed with the key of the
     * installed app (so Android will accept it as an update); otherwise why it isn't.
     */
    static String problem(ApkFacts apk, Release r, Set<String> installedSigners) {
        if (apk == null) return "Android couldn’t read the downloaded update.";
        if (!PACKAGE.equals(apk.packageName)) return "The download isn’t PandaFM (it’s " + apk.packageName + ").";
        if (apk.versionCode != r.versionCode) return "The download is build " + apk.versionCode + ", not the " + r.versionCode + " this server announced.";
        if (apk.signers == null || apk.signers.isEmpty()) return "The download isn’t signed.";
        if (installedSigners == null || installedSigners.isEmpty()) return "PandaFM couldn’t read its own signature, so it can’t check the update.";
        if (!apk.signers.equals(installedSigners)) {
            return "This update is signed with a different key than the PandaFM installed on this device, so Android would refuse it. "
                + "Nothing was installed; publish an APK signed with the usual PandaFM key.";
        }
        return null;
    }

    /** Remove partial downloads and anything that isn't the offered release's APK. */
    static void cleanup(File dir, Release keep) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (keep == null || !f.getName().equals(keep.filename)) f.delete();
        }
    }
}
