package app.pandafm.client;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Downloads one song into the chosen folder:
 * writes "<name>.part", resumes it with an HTTP Range request after a
 * dropped connection, waits while the server is still converting (202),
 * checks size and SHA-256, and only then renames it to its real name. A
 * half-finished file never carries the song's name.
 */
final class Downloader {
    interface Progress {
        void update(long bytes, long total);
    }

    interface Cancelled {
        boolean get();
    }

    static final class Failure extends Exception {
        final boolean retryable;

        Failure(String message, boolean retryable) {
            super(message);
            this.retryable = retryable;
        }
    }

    private static final int BUFFER = 64 * 1024;
    private static final int MAX_CONVERT_WAITS = 120; // ~10 minutes of "still converting"

    private Downloader() {}

    static void run(Context ctx, Uri tree, DownloadJob job, Progress progress, Cancelled cancelled) throws Failure {
        try {
            String[] parts = Storage.split(job.relativePath);
            String name = parts[parts.length - 1];
            String dir = Storage.ensureDirs(ctx, tree, parts, parts.length - 1);
            Uri part = Storage.findFile(ctx, tree, dir, name + ".part");
            if (part == null) part = Storage.createFile(ctx, tree, dir, "application/octet-stream", name + ".part");

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long have = Math.max(0, Storage.size(ctx, part));
            if (have > 0) hashExisting(ctx, part, digest, have);

            String serverSha = null;
            for (int waits = 0; ; waits++) {
                if (cancelled.get()) throw new Failure("Cancelled", false);
                HttpURLConnection conn = (HttpURLConnection) new URL(job.url).openConnection();
                conn.setConnectTimeout(20_000);
                conn.setReadTimeout(60_000);
                conn.setInstanceFollowRedirects(true);
                if (have > 0) conn.setRequestProperty("Range", "bytes=" + have + "-");
                try {
                    int code = conn.getResponseCode();
                    if (code == 202) { // the server is still converting this song
                        if (waits >= MAX_CONVERT_WAITS) throw new Failure("The server is still converting this song", true);
                        Thread.sleep(retryAfterMs(conn));
                        continue;
                    }
                    if (code == 416 && job.expectedBytes >= 0 && have == job.expectedBytes) break; // already complete
                    if (code == 200 || code == 416) { // no resume: start over
                        have = 0;
                        digest.reset();
                        if (code == 416) continue;
                    } else if (code != 206) {
                        boolean retry = code >= 500 || code == 408 || code == 429;
                        throw new Failure("Server answered " + code, retry);
                    }
                    String header = conn.getHeaderField("X-PandaFM-SHA256");
                    if (header != null && !header.isEmpty()) serverSha = header;
                    long length = parseLength(conn.getHeaderField("Content-Length"));
                    long total = length >= 0 ? have + length : job.expectedBytes;
                    try (InputStream in = conn.getInputStream(); OutputStream out = ctx.getContentResolver().openOutputStream(part, have > 0 ? "wa" : "wt")) {
                        if (out == null) throw new IOException("Couldn't write to the folder");
                        byte[] buffer = new byte[BUFFER];
                        long sinceReport = 0;
                        int n;
                        while ((n = in.read(buffer)) != -1) {
                            if (cancelled.get()) throw new Failure("Cancelled", false);
                            out.write(buffer, 0, n);
                            digest.update(buffer, 0, n);
                            have += n;
                            sinceReport += n;
                            if (sinceReport >= 256 * 1024) {
                                progress.update(have, total);
                                sinceReport = 0;
                            }
                        }
                    }
                    progress.update(have, total);
                    break;
                } finally {
                    conn.disconnect();
                }
            }

            String sha = hex(digest.digest());
            String expectedSha = serverSha != null ? serverSha : job.sha256;
            if (job.expectedBytes >= 0 && have != job.expectedBytes) {
                Storage.delete(ctx, part);
                throw new Failure("Incomplete file (" + have + " of " + job.expectedBytes + " bytes)", true);
            }
            if (expectedSha != null && !expectedSha.equalsIgnoreCase(sha)) {
                Storage.delete(ctx, part);
                throw new Failure("Checksum mismatch", true);
            }

            // Replace an older copy (an outdated download) only now that the new one is complete.
            Uri old = Storage.findFile(ctx, tree, dir, name);
            if (old != null) Storage.delete(ctx, old);
            Uri done = DocumentsContract.renameDocument(ctx.getContentResolver(), part, name);
            job.uri = (done != null ? done : part).toString();
            job.bytes = have;
            job.total = have;
            job.actualSha256 = sha;
        } catch (Failure f) {
            throw f;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Failure("Interrupted", true);
        } catch (IllegalArgumentException e) {
            throw new Failure("Invalid download path", false);
        } catch (SecurityException e) {
            throw new Failure("PandaFM no longer has access to the download folder", false);
        } catch (IOException e) {
            throw new Failure("Connection lost: " + e.getMessage(), true); // the .part file stays for resuming
        } catch (NoSuchAlgorithmException e) {
            throw new Failure("SHA-256 unavailable", false);
        }
    }

    private static void hashExisting(Context ctx, Uri part, MessageDigest digest, long have) throws IOException {
        try (InputStream in = ctx.getContentResolver().openInputStream(part)) {
            if (in == null) throw new IOException("Couldn't read partial file");
            byte[] buffer = new byte[BUFFER];
            long left = have;
            int n;
            while (left > 0 && (n = in.read(buffer, 0, (int) Math.min(buffer.length, left))) != -1) {
                digest.update(buffer, 0, n);
                left -= n;
            }
        }
    }

    private static long parseLength(String header) {
        try {
            return header == null ? -1 : Long.parseLong(header.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static long retryAfterMs(HttpURLConnection conn) {
        try {
            return Math.min(60, Math.max(1, Long.parseLong(conn.getHeaderField("Retry-After")))) * 1000L;
        } catch (RuntimeException e) {
            return 5000L;
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
