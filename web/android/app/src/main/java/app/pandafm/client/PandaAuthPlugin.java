package app.pandafm.client;

import android.os.Build;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sign-in for the PandaFM app (5.0). The WebView asks for short-lived access
 * tokens; the refresh token never leaves native code. Passwords and tokens
 * are never logged.
 */
@CapacitorPlugin(name = "PandaAuth")
public class PandaAuthPlugin extends Plugin {
    private static final String TAG = "PandaFM.Auth";
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private AuthCore auth() {
        return AuthStore.get(getContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        o.put("signedIn", auth().signedIn());
        o.put("username", auth().username());
        call.resolve(o);
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        String server = call.getString("server"), username = call.getString("username"), password = call.getString("password");
        if (server == null || username == null || password == null) {
            call.reject("Server, username and password are needed.");
            return;
        }
        io.execute(() -> {
            try {
                String name = auth().signIn(server, username, password, deviceName());
                Log.i(TAG, "Signed in");
                JSObject o = new JSObject();
                o.put("username", name == null ? username : name);
                call.resolve(o);
            } catch (AuthCore.AuthException e) {
                Log.w(TAG, "Sign-in refused (" + e.status + ")");
                call.reject(e.getMessage());
            } catch (IOException e) {
                call.reject("Couldn’t reach PandaFM (" + e.getClass().getSimpleName() + ").");
            }
        });
    }

    @PluginMethod
    public void setup(PluginCall call) {
        String server = call.getString("server"), token = call.getString("setupToken"), username = call.getString("username"), password = call.getString("password");
        if (server == null || token == null || username == null || password == null) {
            call.reject("Server, setup token, username and password are needed.");
            return;
        }
        io.execute(() -> {
            try {
                String name = auth().setup(server, token, username, password, deviceName());
                Log.i(TAG, "Owner created and signed in");
                JSObject o = new JSObject();
                o.put("username", name == null ? username : name);
                call.resolve(o);
            } catch (AuthCore.AuthException e) {
                Log.w(TAG, "Setup refused (" + e.status + ")");
                call.reject(e.getMessage());
            } catch (IOException e) {
                call.reject("Couldn’t reach PandaFM (" + e.getClass().getSimpleName() + ").");
            }
        });
    }

    @PluginMethod
    public void accessToken(PluginCall call) {
        boolean force = Boolean.TRUE.equals(call.getBoolean("forceRefresh", false));
        io.execute(() -> {
            JSObject o = new JSObject();
            try {
                o.put("token", auth().accessToken(force));
            } catch (IOException e) { // offline: still signed in, just no fresh token right now
                o.put("token", (Object) null);
            }
            call.resolve(o);
        });
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        io.execute(() -> {
            auth().signOut();
            Log.i(TAG, "Signed out (downloads kept)");
            call.resolve();
        });
    }

    /** "Sony NW-A306", "Google Pixel 9": the model, nothing more identifying. */
    static String deviceName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        if (model.toLowerCase(Locale.ROOT).startsWith(maker.toLowerCase(Locale.ROOT))) return model.isEmpty() ? "Android device" : model;
        String name = (maker.isEmpty() ? "" : Character.toUpperCase(maker.charAt(0)) + maker.substring(1) + " ") + model;
        return name.trim().isEmpty() ? "Android device" : name.trim();
    }
}
