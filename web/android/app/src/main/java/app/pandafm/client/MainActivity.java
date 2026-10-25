package app.pandafm.client;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PandaStoragePlugin.class); // before the bridge starts
        registerPlugin(PandaPlayerPlugin.class); // native Media3 playback
        registerPlugin(PandaAuthPlugin.class); // 5.0 sign-in (Keystore-protected refresh token)
        super.onCreate(savedInstanceState);
    }
}
