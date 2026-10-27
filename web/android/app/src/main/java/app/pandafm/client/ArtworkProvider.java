package app.pandafm.client;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.security.MessageDigest;
import java.util.Collections;

/**
 * Cover art for Android Auto's browse lists as content:// URIs. Not exported:
 * each URI is granted only to the car host that asked for it. Covers are
 * fetched with the device's sign-in and cached at a car-friendly size; no
 * token ever appears in a URI.
 */
public class ArtworkProvider extends ContentProvider {
    static final String AUTHORITY = "app.pandafm.client.artwork";
    private static final int SIZE = 300;

    static Uri uriFor(String coverArtId) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath("cover").appendPath(coverArtId).build();
    }

    private static final java.util.Set<String> hosts = java.util.Collections.synchronizedSet(new java.util.HashSet<String>());

    /** Car apps (and other media browsers) that asked for our tree: they may read the artwork of what plays. */
    static void rememberHost(String pkg) {
        if (pkg != null && !pkg.isEmpty()) hosts.add(pkg);
    }

    static void grantToKnownHosts(Context ctx, String coverArtId) {
        synchronized (hosts) {
            for (String pkg : hosts) ctx.grantUriPermission(pkg, uriFor(coverArtId), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
    }

    static Uri grant(Context ctx, String coverArtId, String toPackage) {
        rememberHost(toPackage);
        Uri uri = uriFor(coverArtId);
        if (toPackage != null) ctx.grantUriPermission(toPackage, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return uri;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode) || uri.getPathSegments().size() != 2 || !"cover".equals(uri.getPathSegments().get(0))) throw new FileNotFoundException();
        String id = uri.getPathSegments().get(1);
        Context ctx = getContext();
        File dir = new File(ctx.getCacheDir(), "car-artwork");
        if (!dir.exists() && !dir.mkdirs()) throw new FileNotFoundException();
        File file = new File(dir, digest(id) + ".img");
        if (!file.exists()) fetch(ctx, id, file);
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    private static void fetch(Context ctx, String id, File file) throws FileNotFoundException {
        NativePlatform.Catalog catalog = PlaybackService.catalog();
        String saved = catalog == null ? null : catalog.savedArtwork(id);
        if (saved != null && copySaved(ctx, Uri.parse(saved), file)) return; // downloaded music: its own artwork, offline
        String server = AuthStore.get(ctx).server();
        if (server == null) throw new FileNotFoundException();
        HttpURLConnection c = null;
        File part = new File(file.getPath() + ".part");
        try {
            c = AuthHttp.open(ctx, AuthCore.base(server) + "/api/covers/" + LibraryTree.enc(id) + "?size=" + SIZE, Collections.<String, String>emptyMap(), 8_000, 12_000);
            if (c.getResponseCode() != 200) throw new FileNotFoundException();
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[16384];
                int n;
                long total = 0;
                while ((n = in.read(buf)) > 0 && (total += n) < 2 << 20) out.write(buf, 0, n);
            }
            if (!part.renameTo(file)) throw new FileNotFoundException();
        } catch (java.io.IOException e) {
            part.delete();
            throw new FileNotFoundException();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static boolean copySaved(Context ctx, Uri saved, File file) {
        File part = new File(file.getPath() + ".part");
        try (InputStream in = ctx.getContentResolver().openInputStream(saved); FileOutputStream out = new FileOutputStream(part)) {
            if (in == null) return false;
            byte[] buf = new byte[16384];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0 && (total += n) < 4 << 20) out.write(buf, 0, n);
        } catch (java.io.IOException | SecurityException e) {
            part.delete();
            return false;
        }
        return part.renameTo(file);
    }

    private static String digest(String s) {
        try {
            StringBuilder b = new StringBuilder();
            for (byte x : MessageDigest.getInstance("SHA-256").digest(s.getBytes("UTF-8"))) b.append(String.format("%02x", x));
            return b.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "image/*"; }
    @Override public Cursor query(Uri uri, String[] p, String s, String[] a, String o) { return null; }
    @Override public Uri insert(Uri uri, ContentValues v) { return null; }
    @Override public int delete(Uri uri, String s, String[] a) { return 0; }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}
