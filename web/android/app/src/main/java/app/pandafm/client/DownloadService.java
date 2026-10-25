package app.pandafm.client;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;

/** Keeps downloads going while PandaFM is in the background, with a progress notification. */
public class DownloadService extends Service {
    private static final String CHANNEL = "pandafm.downloads";
    private static final int NOTIFICATION_ID = 4111;
    private static final int TYPE_DATA_SYNC = 1; // ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
    private static DownloadService current;

    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    private static final String TAG = DownloadQueue.TAG;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "Download service created");
        NotificationManagerCompat.from(this).createNotificationChannel(
            new NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_LOW).setName("Downloads").build());
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PandaFM:downloads");
            wifiLock.acquire();
        }
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power != null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PandaFM:downloads");
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        DownloadQueue queue = DownloadQueue.get(this);
        // Promote first: every startForegroundService() must be followed by startForeground() promptly.
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, build(), TYPE_DATA_SYNC);
        } catch (RuntimeException e) {
            // e.g. Android 12+ refusing a start that arrived while PandaFM was in the background
            Log.w(TAG, "Couldn't enter the foreground (" + e.getClass().getSimpleName() + "); stopping the download service");
            queue.serviceStopped();
            stopSelf();
            return START_NOT_STICKY;
        }
        synchronized (DownloadService.class) {
            current = this;
        }
        queue.serviceStarted();
        int[] c = queue.counts();
        Log.i(TAG, "onStartCommand #" + startId + ": " + c[0] + " active, " + c[1] + " running");
        queue.scheduleWorkers(); // never requests another service start (that was the loop)
        if (!queue.hasWork()) stopNow();
        // Not sticky: after process death the persisted queue resumes when PandaFM opens or the network changes.
        return START_NOT_STICKY;
    }

    /** Android 15+: a dataSync service has a daily time limit; stop cleanly when it's reached. */
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "Download service time limit reached; stopping (the queue resumes later)");
        stopNow();
    }

    /** Android 14 form of the same callback. */
    public void onTimeout(int startId) {
        onTimeout(startId, TYPE_DATA_SYNC);
    }

    /** Update the notification, or stop when nothing is left to download. */
    static void refresh(Context ctx) {
        DownloadService service;
        synchronized (DownloadService.class) {
            service = current;
        }
        if (service == null) return;
        if (!DownloadQueue.get(ctx).hasWork()) {
            service.stopNow();
            return;
        }
        try {
            NotificationManagerCompat.from(service).notify(NOTIFICATION_ID, service.build());
        } catch (SecurityException ignored) {
            // notifications not allowed; the service still runs
        }
    }

    private Notification build() {
        int active = DownloadQueue.get(this).counts()[0];
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        String text = DownloadQueue.get(this).isPaused() ? "Paused" : !DownloadQueue.get(this).networkAllowed() ? "Waiting for Wi-Fi" : active + " songs to go";
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("PandaFM downloads")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(tap)
            .setProgress(0, 0, active > 0)
            .build();
    }

    private void stopNow() {
        synchronized (DownloadService.class) {
            if (current == this) current = null;
        }
        DownloadQueue.get(this).serviceStopped();
        Log.i(TAG, "Download service stopping");
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        synchronized (DownloadService.class) {
            if (current == this) current = null;
        }
        DownloadQueue.get(this).serviceStopped();
        Log.i(TAG, "Download service destroyed");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
