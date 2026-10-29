package app.pandafm.client;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Self-hosted updates (5.4.1): check this PandaFM server for a newer Android build, download it to
 * private storage, verify it (SHA-256, package, versionCode, signing key), then hand it to
 * Android's own installer, which asks the user. Nothing is ever installed silently.
 */
@CapacitorPlugin(name = "PandaUpdater")
public class UpdatePlugin extends Plugin {
    private static final String TAG = "PandaFM.Update";
    static final String DIR = "updates"; // cache/updates/: the only path the FileProvider exposes
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean cancelled, downloading;
    private volatile UpdateCore.Release offered;

    private File dir() {
        File d = new File(getContext().getCacheDir(), DIR);
        if (!d.isDirectory()) d.mkdirs();
        return d;
    }

    private long installedCode() throws PackageManager.NameNotFoundException {
        PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    @PluginMethod
    public void info(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject o = new JSObject();
            o.put("versionName", info.versionName);
            o.put("versionCode", installedCode());
            o.put("canInstall", canInstall());
            call.resolve(o);
        } catch (PackageManager.NameNotFoundException e) {
            call.reject("PandaFM couldn’t read its own version.");
        }
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
    }

    @PluginMethod
    public void check(PluginCall call) {
        String server = AuthStore.get(getContext()).server();
        if (server == null) {
            call.reject("No PandaFM server is set up.");
            return;
        }
        io.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(server.replaceAll("/+$", "") + UpdateCore.MANIFEST_PATH).openConnection();
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(10_000);
                conn.setInstanceFollowRedirects(false); // same origin only
                conn.setRequestProperty("Accept", "application/json");
                int code = conn.getResponseCode();
                JSObject o = new JSObject();
                long installed = installedCode();
                o.put("installedCode", installed);
                if (code == 404) {
                    offered = null;
                    UpdateCore.cleanup(dir(), null);
                    o.put("status", "none");
                    call.resolve(o);
                    return;
                }
                if (code != 200) throw new IOException("HTTP " + code);
                UpdateCore.Release r = UpdateCore.parse(read(conn.getInputStream(), 65536));
                String status = UpdateCore.status(installed, r.versionCode);
                offered = "available".equals(status) ? r : null;
                UpdateCore.cleanup(dir(), offered); // old or partial downloads go
                File apk = new File(dir(), r.filename);
                o.put("status", status);
                o.put("versionName", r.versionName);
                o.put("versionCode", r.versionCode);
                o.put("size", r.size);
                o.put("notes", r.notes);
                o.put("releasedAt", r.releasedAt);
                o.put("downloaded", offered != null && apk.isFile() && apk.length() == r.size);
                call.resolve(o);
            } catch (UpdateCore.BadManifest e) {
                Log.w(TAG, "The server's release manifest is invalid: " + e.getMessage());
                call.reject("The server’s update information is invalid.");
            } catch (Exception e) {
                call.reject("Couldn’t check for updates.");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        UpdateCore.Release r = offered;
        String server = AuthStore.get(getContext()).server();
        if (r == null || server == null) {
            call.reject("Check for updates first.");
            return;
        }
        if (downloading) {
            call.reject("Already downloading.");
            return;
        }
        if (!UpdateCore.enoughSpace(dir().getUsableSpace(), r.size)) {
            call.reject("Not enough free space for the update (" + (r.size / 1_048_576) + " MB needed).");
            return;
        }
        cancelled = false;
        downloading = true;
        io.execute(() -> {
            File part = new File(dir(), r.filename + ".part");
            File apk = new File(dir(), r.filename);
            try {
                fetch(UpdateCore.downloadUrl(server, r), part, r.size);
                if (part.length() != r.size) throw new IOException("The download is incomplete.");
                if (!UpdateCore.sha256(part).equals(r.sha256)) throw new SecurityException("The download doesn’t match the server’s checksum.");
                String problem = UpdateCore.problem(facts(part), r, installedSigners());
                if (problem != null) throw new SecurityException(problem);
                if (!part.renameTo(apk)) throw new IOException("Couldn’t save the update.");
                Log.i(TAG, "Update " + r.versionName + " (" + r.versionCode + ") downloaded and verified");
                call.resolve(new JSObject().put("ready", true));
            } catch (SecurityException e) {
                part.delete();
                Log.w(TAG, "Rejected the downloaded update: " + e.getMessage());
                call.reject(e.getMessage());
            } catch (Exception e) {
                if (cancelled) part.delete(); // a cancelled download is thrown away; an interrupted one may resume
                call.reject(cancelled ? "Download cancelled." : "The download failed: " + e.getMessage());
            } finally {
                downloading = false;
            }
        });
    }

    private void fetch(String url, File part, long total) throws IOException {
        long have = part.isFile() ? part.length() : 0;
        if (have >= total) {
            part.delete();
            have = 0;
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(30_000);
        conn.setInstanceFollowRedirects(false);
        if (have > 0) conn.setRequestProperty("Range", "bytes=" + have + "-"); // resume
        int code = conn.getResponseCode();
        boolean append = code == 206;
        if (code != 200 && code != 206) throw new IOException("HTTP " + code);
        if (!append) have = 0;
        try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part, append)) {
            byte[] buf = new byte[65536];
            long received = have, lastEvent = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                if (cancelled) throw new IOException("cancelled");
                out.write(buf, 0, n);
                received += n;
                if (received > total) throw new IOException("The download is larger than announced.");
                long now = System.currentTimeMillis();
                if (now - lastEvent > 250) {
                    lastEvent = now;
                    JSObject p = new JSObject();
                    p.put("received", received);
                    p.put("total", total);
                    notifyListeners("updateProgress", p);
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        UpdateCore.Release r = offered;
        File apk = r == null ? null : new File(dir(), r.filename);
        if (apk == null || !apk.isFile()) {
            call.reject("Download the update first.");
            return;
        }
        io.execute(() -> {
            try {
                if (!UpdateCore.sha256(apk).equals(r.sha256)) { // nothing may have changed it since the check
                    apk.delete();
                    call.reject("The downloaded update changed; download it again.");
                    return;
                }
            } catch (IOException e) {
                call.reject("Couldn’t read the downloaded update.");
                return;
            }
            main.post(() -> openInstaller(call, apk));
        });
    }

    private void openInstaller(PluginCall call, File apk) {
        Context ctx = getContext();
        if (!canInstall()) {
            // Android asks once: "Install unknown apps → Allow from PandaFM". Open exactly that page.
            Intent settings = new Intent("android.settings.MANAGE_UNKNOWN_APP_SOURCES", Uri.parse("package:" + ctx.getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (settings.resolveActivity(ctx.getPackageManager()) != null) ctx.startActivity(settings);
            call.resolve(new JSObject().put("needsPermission", true));
            return;
        }
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, UpdateCore.APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        if (intent.resolveActivity(ctx.getPackageManager()) == null) {
            call.reject("This device has no app installer available.");
            return;
        }
        ctx.startActivity(intent); // Android's installer asks the user; PandaFM installs nothing itself
        call.resolve(new JSObject().put("started", true));
    }

    private UpdateCore.ApkFacts facts(File apk) {
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo info = pm.getPackageArchiveInfo(apk.getPath(), flags);
        if (info == null) return null;
        long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        return new UpdateCore.ApkFacts(info.packageName, code, signers(info));
    }

    private Set<String> installedSigners() {
        try {
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            return signers(getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), flags));
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }

    /** SHA-256 of the current signing certificate(s). */
    @SuppressWarnings("deprecation")
    static Set<String> signers(PackageInfo info) {
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            SigningInfo si = info.signingInfo;
            if (si.hasMultipleSigners()) {
                sigs = si.getApkContentsSigners();
            } else {
                Signature[] history = si.getSigningCertificateHistory();
                if (history != null && history.length > 0) sigs = new Signature[] {history[history.length - 1]}; // the current key
            }
        } else {
            sigs = info.signatures;
        }
        Set<String> out = new HashSet<>();
        if (sigs == null) return out;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (Signature s : sigs) out.add(UpdateCore.hex(md.digest(s.toByteArray())));
        } catch (Exception e) {
            out.clear();
        }
        return out;
    }

    private static String read(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) throw new IOException("The manifest is too large.");
        }
        return out.toString("UTF-8");
    }
}
