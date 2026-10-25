package app.pandafm.client;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** The process-wide sign-in: one AuthCore for the WebView, Media3 and downloads alike. */
final class AuthStore {
    private static AuthCore core;

    private AuthStore() {}

    static synchronized AuthCore get(Context ctx) {
        if (core == null) core = new AuthCore(new UrlHttp(), new KeystoreVault(ctx.getApplicationContext()), System::currentTimeMillis);
        return core;
    }

    /** The refresh token, encrypted with an AES-GCM key that never leaves the Android Keystore. */
    static final class KeystoreVault implements AuthCore.Vault {
        private static final String PREFS = "pandafm.auth"; // excluded from backups (res/xml/*backup*)
        private static final String KEY_ALIAS = "pandafm.auth.v1";
        private static final String SECRET = "refresh";
        private final SharedPreferences prefs;

        KeystoreVault(Context ctx) {
            prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        }

        @Override
        public String get(String key) {
            String stored = prefs.getString(key, null);
            if (stored == null || !SECRET.equals(key)) return stored;
            try {
                byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, blob, 0, 12));
                return new String(cipher.doFinal(blob, 12, blob.length - 12), StandardCharsets.UTF_8);
            } catch (Exception e) { // key gone (restored backup, cleared credentials): signed out
                return null;
            }
        }

        @Override
        public void put(String key, String value) {
            String stored = value;
            if (SECRET.equals(key) && value != null) {
                try {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.ENCRYPT_MODE, key());
                    byte[] iv = cipher.getIV();
                    byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
                    byte[] blob = new byte[iv.length + sealed.length];
                    System.arraycopy(iv, 0, blob, 0, iv.length);
                    System.arraycopy(sealed, 0, blob, iv.length, sealed.length);
                    stored = Base64.encodeToString(blob, Base64.NO_WRAP);
                } catch (Exception e) {
                    throw new IllegalStateException("Android Keystore unavailable", e); // never store it unencrypted
                }
            }
            prefs.edit().putString(key, stored).commit();
        }

        @Override
        public void clear() {
            prefs.edit().clear().commit();
        }

        private static SecretKey key() throws Exception {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            return gen.generateKey();
        }
    }

    /** JSON POSTs to PandaFM's auth API. No redirects followed; nothing logged. */
    static final class UrlHttp implements AuthCore.Http {
        @Override
        public AuthCore.Response post(String url, String jsonBody, String bearer) throws IOException {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            try {
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(15_000);
                c.setReadTimeout(20_000);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("Accept", "application/json");
                if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(jsonBody.getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                return new AuthCore.Response(code, in == null ? "" : read(in));
            } finally {
                c.disconnect();
            }
        }

        private static String read(InputStream in) throws IOException {
            try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = s.read(buf)) > 0 && out.size() < 1 << 20) out.write(buf, 0, n);
                return out.toString("UTF-8");
            }
        }
    }
}
