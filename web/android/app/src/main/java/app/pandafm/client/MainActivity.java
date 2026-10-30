package app.pandafm.client;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PandaStoragePlugin.class); // before the bridge starts
        registerPlugin(PandaPlayerPlugin.class); // native Media3 playback
        registerPlugin(PandaAuthPlugin.class); // 5.0 sign-in (Keystore-protected refresh token)
        registerPlugin(UpdatePlugin.class); // 5.4.1 self-hosted updates (Android's installer asks the user)
        super.onCreate(savedInstanceState);
        // 5.5.2: if the WebView's renderer dies, rebuild the UI (a new Activity and WebView) instead of the
        // default, which lets Android kill the whole process and with it the music. The playback service
        // lives on in this process; the new UI reconnects to its queue (and isn't treated as a first launch).
        if (getBridge() != null) {
            getBridge().addWebViewListener(new com.getcapacitor.WebViewListener() {
                @Override
                public boolean onRenderProcessGone(android.webkit.WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    android.util.Log.w("PandaFM.Playback", "WebView renderer gone: rebuilding the UI; playback continues");
                    runOnUiThread(MainActivity.this::recreate);
                    return true;
                }
            });
        }
    }
}
