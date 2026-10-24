package app.pandafm.client;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.StatFs;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * The PandaFM folder the user picked (Storage Access Framework). PandaFM only
 * ever touches documents inside that folder, with the permission the user gave.
 */
final class Storage {
    private static final String PREFS = "pandafm.storage";
    private static final String KEY_TREE = "tree";
    private static final Map<String, String> dirCache = new HashMap<>();

    private Storage() {}

    static Uri tree(Context ctx) {
        String saved = prefs(ctx).getString(KEY_TREE, null);
        return saved == null ? null : Uri.parse(saved);
    }

    static void saveTree(Context ctx, Uri tree) {
        Uri old = tree(ctx);
        if (old != null && !old.equals(tree)) {
            try {
                ctx.getContentResolver().releasePersistableUriPermission(old, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // already gone
            }
        }
        synchronized (dirCache) {
            dirCache.clear();
        }
        prefs(ctx).edit().putString(KEY_TREE, tree.toString()).apply();
    }

    /** True while Android still lets us read and write the chosen folder (it survives restarts). */
    static boolean hasPermission(Context ctx, Uri tree) {
        if (tree == null) return false;
        for (UriPermission p : ctx.getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(tree) && p.isReadPermission() && p.isWritePermission()) return true;
        }
        return false;
    }

    static String displayName(Context ctx, Uri tree) {
        if (tree == null) return null;
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        String name = queryString(ctx.getContentResolver(), doc, Document.COLUMN_DISPLAY_NAME);
        String id = DocumentsContract.getTreeDocumentId(tree);
        String volume = id.contains(":") ? id.substring(0, id.indexOf(':')) : "";
        String where = "primary".equals(volume) ? "Internal storage" : volume.isEmpty() ? "Storage" : "SD card";
        return where + " / " + (name != null ? name : id);
    }

    /** "Music/Artist/Album/01 - Song.flac" -> its parts; rejects anything that could leave the folder. */
    static String[] split(String relativePath) {
        if (relativePath == null || relativePath.isEmpty() || relativePath.startsWith("/") || relativePath.contains("\\")) {
            throw new IllegalArgumentException("Bad path");
        }
        String[] parts = relativePath.split("/");
        for (String part : parts) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new IllegalArgumentException("Bad path");
        }
        return parts;
    }

    /** The folder for a path's parent directories, created as needed. Returns its document id. */
    static String ensureDirs(Context ctx, Uri tree, String[] parts, int count) throws IOException {
        ContentResolver resolver = ctx.getContentResolver();
        String docId = DocumentsContract.getTreeDocumentId(tree);
        StringBuilder path = new StringBuilder();
        for (int i = 0; i < count; i++) {
            path.append('/').append(parts[i]);
            String key = tree + path.toString();
            String cached;
            synchronized (dirCache) {
                cached = dirCache.get(key);
            }
            if (cached != null) {
                docId = cached;
                continue;
            }
            String child = findChild(resolver, tree, docId, parts[i]);
            if (child == null) {
                Uri created = DocumentsContract.createDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, docId), Document.MIME_TYPE_DIR, parts[i]);
                if (created == null) throw new IOException("Couldn't create folder " + parts[i]);
                child = DocumentsContract.getDocumentId(created);
            }
            synchronized (dirCache) {
                dirCache.put(key, child);
            }
            docId = child;
        }
        return docId;
    }

    static String findChild(ContentResolver resolver, Uri tree, String parentDocId, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocId);
        try (Cursor c = resolver.query(children, new String[] {Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                if (name.equals(c.getString(1))) return c.getString(0);
            }
        }
        return null;
    }

    static Uri findFile(Context ctx, Uri tree, String dirDocId, String name) {
        String id = findChild(ctx.getContentResolver(), tree, dirDocId, name);
        return id == null ? null : DocumentsContract.buildDocumentUriUsingTree(tree, id);
    }

    static Uri createFile(Context ctx, Uri tree, String dirDocId, String mime, String name) throws IOException {
        Uri created = DocumentsContract.createDocument(ctx.getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, dirDocId), mime, name);
        if (created == null) throw new IOException("Couldn't create " + name);
        return created;
    }

    /** Write a small file (artwork) in one go, replacing any older copy. */
    static Uri writeBytes(Context ctx, Uri tree, String relativePath, byte[] bytes, String mime) throws IOException {
        String[] parts = split(relativePath);
        String dir = ensureDirs(ctx, tree, parts, parts.length - 1);
        String name = parts[parts.length - 1];
        Uri file = findFile(ctx, tree, dir, name);
        if (file == null) file = createFile(ctx, tree, dir, mime, name);
        try (OutputStream out = ctx.getContentResolver().openOutputStream(file, "wt")) {
            if (out == null) throw new IOException("Couldn't open " + name);
            out.write(bytes);
        }
        return file;
    }

    static long size(Context ctx, Uri doc) {
        String value = queryString(ctx.getContentResolver(), doc, Document.COLUMN_SIZE);
        try {
            return value == null ? -1 : Long.parseLong(value);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** Only documents inside the chosen folder may be deleted or read. */
    static boolean inside(Uri tree, Uri doc) {
        if (tree == null || doc == null || !tree.getAuthority().equals(doc.getAuthority())) return false;
        try {
            String root = DocumentsContract.getTreeDocumentId(tree);
            String id = DocumentsContract.getDocumentId(doc);
            return id.equals(root) || id.startsWith(root.endsWith("/") ? root : root + "/");
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    static boolean delete(Context ctx, Uri doc) {
        try {
            return DocumentsContract.deleteDocument(ctx.getContentResolver(), doc);
        } catch (Exception e) { // newer SDKs declare FileNotFoundException, older ones don't
            return e instanceof FileNotFoundException; // already gone counts as deleted
        }
    }

    /** Free space on the volume holding the folder, where the storage provider reports it. */
    static long freeBytes(Context ctx, Uri tree) {
        if (tree == null) return -1;
        String id = DocumentsContract.getTreeDocumentId(tree);
        String rootId = id.contains(":") ? id.substring(0, id.indexOf(':')) : id;
        Uri root = DocumentsContract.buildRootUri(tree.getAuthority(), rootId);
        String value = queryString(ctx.getContentResolver(), root, DocumentsContract.Root.COLUMN_AVAILABLE_BYTES);
        if (value != null) {
            try {
                return Long.parseLong(value);
            } catch (NumberFormatException ignored) {
                // fall through
            }
        }
        if ("primary".equals(rootId)) {
            return new StatFs(Environment.getExternalStorageDirectory().getPath()).getAvailableBytes();
        }
        return -1;
    }

    private static String queryString(ContentResolver resolver, Uri uri, String column) {
        try (Cursor c = resolver.query(uri, new String[] {column}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException ignored) {
            // provider doesn't support it
        }
        return null;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
