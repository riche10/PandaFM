package app.pandafm.client;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * PandaFM's bridge to Android storage and downloads (see web/src/platform/native.ts).
 * Least privilege: one folder the user picks, kept with a persisted permission;
 * no "all files" access.
 */
@CapacitorPlugin(name = "PandaStorage")
public class PandaStoragePlugin extends Plugin {
    @Override
    public void load() {
        DownloadQueue.get(getContext()).setListener(job -> {
            try {
                notifyListeners("jobUpdate", JSObject.fromJSONObject(job.toState()));
            } catch (JSONException ignored) {
                // never thrown for our own fields
            }
        });
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            NetworkRequest request = new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build();
            cm.registerNetworkCallback(request, new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) { networkChanged(); }

                @Override
                public void onLost(Network network) { networkChanged(); }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) { networkChanged(); }
            });
        }
    }

    private void networkChanged() {
        notifyListeners("network", network());
        DownloadQueue.get(getContext()).schedule();
    }

    private JSObject network() {
        NetworkState net = NetworkState.of(getContext());
        JSObject o = new JSObject();
        o.put("connected", net.connected);
        o.put("metered", net.metered);
        o.put("wifi", net.wifi);
        return o;
    }

    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "directoryPicked");
    }

    @ActivityCallback
    private void directoryPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("No folder chosen");
            return;
        }
        Uri tree = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Android didn't allow PandaFM to keep access to that folder");
            return;
        }
        Storage.saveTree(getContext(), tree);
        JSObject o = new JSObject();
        o.put("uri", tree.toString());
        o.put("name", Storage.displayName(getContext(), tree));
        call.resolve(o);
        DownloadQueue.get(getContext()).schedule();
    }

    @PluginMethod
    public void getDirectory(PluginCall call) {
        Uri tree = Storage.tree(getContext());
        JSObject o = new JSObject();
        o.put("uri", tree == null ? null : tree.toString());
        o.put("name", tree == null ? null : Storage.displayName(getContext(), tree));
        o.put("writable", Storage.hasPermission(getContext(), tree));
        call.resolve(o);
    }

    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        long free = Storage.freeBytes(getContext(), Storage.tree(getContext()));
        JSObject o = new JSObject();
        o.put("freeBytes", free >= 0 ? free : null);
        o.put("totalBytes", JSONObject.NULL);
        call.resolve(o);
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        JSArray array = call.getArray("jobs");
        List<DownloadJob> jobs = new ArrayList<>();
        try {
            for (int i = 0; array != null && i < array.length(); i++) {
                DownloadJob job = DownloadJob.fromJson(array.getJSONObject(i));
                Storage.split(job.relativePath); // reject unsafe paths up front
                if (!job.url.startsWith("https://") && !job.url.startsWith("http://")) throw new IllegalArgumentException("Bad URL");
                jobs.add(job);
            }
        } catch (JSONException | IllegalArgumentException e) {
            call.reject("Invalid download request");
            return;
        }
        Integer concurrency = call.getInt("concurrency", 2);
        Boolean allowMetered = call.getBoolean("allowMetered", false);
        DownloadQueue.get(getContext()).enqueue(jobs, concurrency == null ? 2 : concurrency, allowMetered != null && allowMetered);
        call.resolve();
    }

    @PluginMethod
    public void getJobs(PluginCall call) {
        JSONArray out = new JSONArray();
        try {
            for (DownloadJob job : DownloadQueue.get(getContext()).all()) out.put(job.toState());
        } catch (JSONException ignored) {
            // never thrown for our own fields
        }
        JSObject o = new JSObject();
        o.put("jobs", out);
        call.resolve(o);
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        DownloadQueue.get(getContext()).acknowledge(ids(call));
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        DownloadQueue.get(getContext()).cancel(ids(call));
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        DownloadQueue.get(getContext()).setPaused(true);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        DownloadQueue.get(getContext()).setPaused(false);
        call.resolve();
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        Uri doc = parse(call.getString("uri"));
        if (!Storage.inside(Storage.tree(getContext()), doc)) {
            call.reject("Not a PandaFM download");
            return;
        }
        JSObject o = new JSObject();
        o.put("deleted", Storage.delete(getContext(), doc));
        call.resolve(o);
    }

    @PluginMethod
    public void stat(PluginCall call) {
        Uri doc = parse(call.getString("uri"));
        JSObject o = new JSObject();
        long size = Storage.inside(Storage.tree(getContext()), doc) ? Storage.size(getContext(), doc) : -1;
        o.put("exists", size >= 0);
        o.put("size", Math.max(0, size));
        call.resolve(o);
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        Uri tree = Storage.tree(getContext());
        String path = call.getString("relativePath");
        String base64 = call.getString("base64");
        if (tree == null || path == null || base64 == null || !path.startsWith(".pandafm/")) {
            call.reject("Invalid write request");
            return;
        }
        try {
            Uri uri = Storage.writeBytes(getContext(), tree, path, Base64.decode(base64, Base64.DEFAULT), "image/jpeg");
            JSObject o = new JSObject();
            o.put("uri", uri.toString());
            call.resolve(o);
        } catch (Exception e) {
            call.reject("Couldn't save the file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getNetwork(PluginCall call) {
        call.resolve(network());
    }

    private static List<String> ids(PluginCall call) {
        List<String> out = new ArrayList<>();
        JSArray array = call.getArray("ids");
        for (int i = 0; array != null && i < array.length(); i++) {
            String id = array.optString(i, null);
            if (id != null) out.add(id);
        }
        return out;
    }

    private static Uri parse(String value) {
        if (value == null || !value.startsWith("content://")) return null;
        Uri uri = Uri.parse(value);
        try {
            DocumentsContract.getDocumentId(uri);
            return uri;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
