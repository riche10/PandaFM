package app.pandafm.client;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.ExecutorService;

/**
 * PandaFM's Android playback service (5.0.1): one ExoPlayer, one
 * MediaLibrarySession and the native queue that decides what plays. The
 * phone UI, the lock screen and notification, Bluetooth and headset buttons,
 * and Android Auto all control the same service. It works without the app's
 * screen: songs advance, radio refills and Autoplay continue natively.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlaybackService extends MediaLibraryService {
    private static PlaybackService instance;
    private static final List<Runnable> waiting = new ArrayList<>();
    private static final long SAVE_EVERY_MS = 10_000;

    private ExoPlayer player;
    private MediaLibrarySession session;
    private QueueController controller;
    private ExoEngine engine;
    private LibraryTree tree;
    private NativePlatform.Catalog catalog;
    private ExecutorService io;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable saver = new Runnable() {
        @Override
        public void run() {
            if (controller != null && "playing".equals(controller.status)) controller.save(); // the position, in case the process dies
            main.postDelayed(this, SAVE_EVERY_MS);
        }
    };

    /** Run on the main thread once the service (and its queue) exist; starts the service if needed. */
    static void whenReady(Context ctx, Runnable task) {
        if (instance != null) {
            task.run();
            return;
        }
        waiting.add(task);
        if (waiting.size() == 1) ctx.startService(new Intent(ctx, PlaybackService.class));
    }

    static QueueController controller() {
        return instance == null ? null : instance.controller;
    }

    static ExoEngine engine() {
        return instance == null ? null : instance.engine;
    }

    static NativePlatform.Catalog catalog() {
        return instance == null ? null : instance.catalog;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setUserAgent("PandaFM-Android")
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
            .setAllowCrossProtocolRedirects(false);
        // PandaFM streams carry the device's access token as a header (never in the URL), only to the
        // PandaFM server's own origin; Android's HTTP stack drops it on cross-host redirects.
        Context app = getApplicationContext();
        ResolvingDataSource.Factory signedIn = new ResolvingDataSource.Factory(http, spec -> {
            String authorization = AuthStore.get(app).authorizationFor(spec.uri.toString());
            return authorization == null ? spec : spec.withAdditionalHeaders(Collections.singletonMap("Authorization", authorization));
        });
        DefaultDataSource.Factory sources = new DefaultDataSource.Factory(this, signedIn); // streams, and content:// downloads
        AudioAttributes music = new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build();
        player = new ExoPlayer.Builder(this)
            .setAudioAttributes(music, /* handleAudioFocus= */ true) // pause for calls, duck for navigation
            .setHandleAudioBecomingNoisy(true) // headphones unplugged: pause
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(sources))
            .build();

        io = NativePlatform.newIo();
        catalog = new NativePlatform.Catalog(this);
        NativePlatform.Api api = new NativePlatform.Api(this);
        engine = new ExoEngine(this, player, io);
        controller = new QueueController(new NativeQueue(() -> UUID.randomUUID().toString(), new Random()), engine,
            new NativePlatform.Sources(this, catalog), new NativePlatform.QueueFile(this), new NativePlatform.Events(this, api, io),
            new NativePlatform.Radio(api, io), new NativePlatform.Env(this));
        engine.attach(controller);
        applyPreferences();
        controller.restore(); // paused: nothing plays by itself after a restart
        tree = new LibraryTree(api, catalog);

        QueuePlayer sessionPlayer = new QueuePlayer(player, controller, this::resolveAndPlay);
        MediaLibrarySession.Builder builder = new MediaLibrarySession.Builder(this, sessionPlayer, new LibraryCallback(this, tree, io));
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            builder.setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        session = builder.build();
        instance = this;
        main.postDelayed(saver, SAVE_EVERY_MS);
        List<Runnable> ready = new ArrayList<>(waiting);
        waiting.clear();
        for (Runnable r : ready) r.run();
    }

    void applyPreferences() {
        android.content.SharedPreferences p = NativePlatform.Prefs.of(this);
        controller.autoplayEnabled = p.getBoolean("autoplayEnabled", true);
        controller.autoplayPreset = p.getString("autoplayPreset", "panda");
    }

    /** Something Android Auto (or another media controller) asked to play: an id from the tree, or a voice query. */
    void resolveAndPlay(List<MediaItem> items, int startIndex) {
        if (items.isEmpty()) return;
        MediaItem chosen = items.get(Math.min(startIndex, items.size() - 1));
        String mediaId = chosen.mediaId;
        String query = chosen.requestMetadata == null ? null : chosen.requestMetadata.searchQuery;
        boolean signedIn = AuthStore.get(this).signedIn(), online = NetworkState.of(this).connected;
        io.execute(() -> {
            LibraryTree.Resolution r;
            String failure = null;
            try {
                r = (mediaId == null || mediaId.isEmpty()) ? tree.resolveVoice(query == null ? "" : query, signedIn, online) : tree.resolve(mediaId, signedIn, online);
            } catch (LibraryTree.ApiError e) {
                r = null;
                failure = e.status == 401 ? LibraryTree.SIGN_IN : e.getMessage();
            }
            LibraryTree.Resolution res = r;
            String error = failure;
            main.post(() -> {
                if (res == null) controller.showError(error);
                else if (res.error != null) controller.showError(res.error);
                else if (res.resume) controller.play();
                else if (res.isRadio()) controller.startRadio(res.radioPreset, res.radioSeedKind, res.radioSeedId);
                else controller.replace(res.tracks, res.start, res.source, false, true);
            });
        });
    }

    @Override
    public MediaLibrarySession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    /**
     * The app's screen was swiped away. The queue lives here now, so music that's playing keeps
     * going (and advancing); a paused or empty player lets the service go.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (controller != null) controller.save();
        if (player == null || !player.getPlayWhenReady() || controller == null || controller.queue.current() == null) stopSelf();
    }

    @Override
    public void onDestroy() {
        main.removeCallbacks(saver);
        if (controller != null) controller.save();
        if (session != null) session.release();
        if (player != null) player.release();
        if (io != null) io.shutdown();
        instance = null;
        super.onDestroy();
    }
}
