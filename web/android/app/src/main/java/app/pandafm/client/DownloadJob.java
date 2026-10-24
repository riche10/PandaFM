package app.pandafm.client;

import org.json.JSONException;
import org.json.JSONObject;

/** One song's download, as the queue tracks (and persists) it. */
final class DownloadJob {
    String id;
    String url;
    String relativePath;
    long expectedBytes = -1;
    String sha256;
    String mimeType;
    String status = "queued"; // queued | running | done | failed
    long bytes;
    long total = -1;
    String uri;
    String actualSha256;
    String error;
    boolean retryable = true;

    static DownloadJob fromJson(JSONObject o) throws JSONException {
        DownloadJob j = new DownloadJob();
        j.id = o.getString("id");
        j.url = o.getString("url");
        j.relativePath = o.getString("relativePath");
        j.expectedBytes = o.isNull("expectedBytes") ? -1 : o.optLong("expectedBytes", -1);
        j.sha256 = o.isNull("sha256") ? null : o.optString("sha256", null);
        j.mimeType = o.optString("mimeType", "application/octet-stream");
        j.status = o.optString("status", "queued");
        j.bytes = o.optLong("bytes", 0);
        j.total = o.optLong("total", -1);
        j.uri = o.isNull("uri") ? null : o.optString("uri", null);
        j.actualSha256 = o.isNull("actualSha256") ? null : o.optString("actualSha256", null);
        j.error = o.isNull("error") ? null : o.optString("error", null);
        j.retryable = o.optBoolean("retryable", true);
        return j;
    }

    JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("id", id).put("url", url).put("relativePath", relativePath).put("mimeType", mimeType).put("status", status)
            .put("bytes", bytes).put("total", total).put("retryable", retryable);
        o.put("expectedBytes", expectedBytes >= 0 ? expectedBytes : JSONObject.NULL);
        o.put("sha256", sha256 != null ? sha256 : JSONObject.NULL);
        o.put("uri", uri != null ? uri : JSONObject.NULL);
        o.put("actualSha256", actualSha256 != null ? actualSha256 : JSONObject.NULL);
        o.put("error", error != null ? error : JSONObject.NULL);
        return o;
    }

    /** The shape the web app's NativeJobState expects. */
    JSONObject toState() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("id", id).put("status", status).put("bytes", bytes).put("retryable", retryable);
        o.put("total", total >= 0 ? total : JSONObject.NULL);
        if (uri != null) o.put("uri", uri);
        if (actualSha256 != null) o.put("sha256", actualSha256);
        if (error != null) o.put("error", error);
        return o;
    }
}
