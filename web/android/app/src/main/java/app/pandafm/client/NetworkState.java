package app.pandafm.client;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

/** Is there a network, is it metered (mobile data), is it Wi-Fi / Ethernet? */
final class NetworkState {
    final boolean connected;
    final boolean metered;
    final boolean wifi;

    private NetworkState(boolean connected, boolean metered, boolean wifi) {
        this.connected = connected;
        this.metered = metered;
        this.wifi = wifi;
    }

    static NetworkState of(Context ctx) {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return new NetworkState(true, false, true);
        Network network = cm.getActiveNetwork();
        NetworkCapabilities caps = network == null ? null : cm.getNetworkCapabilities(network);
        if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return new NetworkState(false, false, false);
        boolean wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
        return new NetworkState(true, cm.isActiveNetworkMetered(), wifi);
    }
}
