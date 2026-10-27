package app.pandafm.client;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
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
    private ExoEngine engine, engine2;
    private ExoPlayer player2;
    private PandaDjEngine dj;
    private QueuePlayer[] sessionPlayers;
    private NativePlatform.MixPlans mixPlans;
    private AudioAttributes music;
    private int logicalDeck = 0;
    private NativePlatform.QueueFile queueFile;
    private static final String TAG = "PandaFM.Playback";
    private static int created = 0;
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

    static PandaDjEngine dj() {
        return instance == null ? null : instance.dj;
    }

    static NativePlatform.MixPlans mixPlans() {
        return instance == null ? null : instance.mixPlans;
    }

    private ExoPlayer newDeck(DefaultDataSource.Factory sources, boolean focus) {
        return new ExoPlayer.Builder(this)
            .setAudioAttributes(music, focus) // only the logical deck handles audio focus (pause for calls, duck for navigation)
            .setHandleAudioBecomingNoisy(true) // headphones unplugged: pause
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(sources))
            .build();
    }

    /**
     * Panda DJ's logical handoff: the session (lock screen, notification, car) and audio focus move
     * to the deck now playing the current song. The old deck lets go of focus first, so it isn't
     * paused by the new deck's request while it fades out.
     */
    private void followDeck(int deck) {
        if (deck == logicalDeck || session == null) return;
        ExoPlayer[] players = {player, player2};
        players[logicalDeck].setAudioAttributes(music, false);
        players[deck].setAudioAttributes(music, true);
        session.setPlayer(sessionPlayers[deck]);
        logicalDeck = deck;
    }

    static boolean running() {
        return instance != null;
    }

    /** Swiped away from Recents: keep going while PandaFM still means to play (buffering included). */
    static boolean stopOnTaskRemoved(boolean intendsToPlay, boolean hasCurrent) {
        return !intendsToPlay || !hasCurrent;
    }

    static NativePlatform.Catalog catalog() {
        return instance == null ? null : instance.catalog;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        created++;
        Log.i(TAG, "PlaybackService.onCreate" + (created > 1 ? " (recreated, #" + created + " in this process)" : ""));
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
        music = new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build();
        player = newDeck(sources, true); // deck A: the logical deck to begin with (holds audio focus)
        player2 = newDeck(sources, false); // deck B: Panda DJ's standby; idle unless a Panda Mix blends into it

        io = NativePlatform.newIo();
        catalog = new NativePlatform.Catalog(this);
        NativePlatform.Api api = new NativePlatform.Api(this);
        engine = new ExoEngine(this, player);
        engine2 = new ExoEngine(this, player2);
        NativePlatform.Sources sourcesForQueue = new NativePlatform.Sources(this, catalog);
        dj = new PandaDjEngine(engine.core, engine, engine2.core, engine2, main::postDelayed, new PandaDjEngine.Host() {
            public String uriFor(QueueItem item) { return sourcesForQueue.uriFor(item); } // resolved at preload time
            public void onLogicalDeck(int deck) { followDeck(deck); }
            public void log(String message) { Log.i(TAG, message); }
            public long nowMs() { return System.currentTimeMillis(); }
        });
        queueFile = new NativePlatform.QueueFile(this);
        controller = new QueueController(new NativeQueue(() -> UUID.randomUUID().toString(), new Random()), dj,
            sourcesForQueue, queueFile, new NativePlatform.Events(this, api, io),
            new NativePlatform.Radio(api, io), new NativePlatform.Env(this));
        dj.attach(controller);
        mixPlans = new NativePlatform.MixPlans(this, api, io, () -> {
            if (controller != null) controller.onPlansUpdated();
        });
        controller.setMixPlans(mixPlans);
        applyPreferences();
        controller.restore(); // paused: nothing plays by itself after a restart
        Log.i(TAG, "Queue restored: " + controller.queue.items.size() + " songs, index " + controller.queue.index + " (paused)");
        tree = new LibraryTree(api, catalog);

        sessionPlayers = new QueuePlayer[] {new QueuePlayer(player, controller, this::resolveAndPlay), new QueuePlayer(player2, controller, this::resolveAndPlay)};
        MediaLibrarySession.Builder builder = new MediaLibrarySession.Builder(this, sessionPlayers[0], new LibraryCallback(this, tree, io));
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            builder.setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        session = builder.build();
        // Without this, Media3 only manages the media notification and the foreground state once
        // some MediaController connects. PandaFM's own screens don't use one, so in 5.0.1 the
        // service could stay an ordinary background service that Android stops a minute or so
        // after the app leaves the screen: the "music stops after a few minutes" bug.
        addSession(session);
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
        QueueController target = controller;
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
                if (instance != this || controller != target) return; // the service was recreated meanwhile
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
        boolean intends = controller != null && controller.intendsToPlay();
        boolean stop = stopOnTaskRemoved(intends, controller != null && controller.queue.current() != null);
        Log.i(TAG, "onTaskRemoved: status=" + (controller == null ? "none" : controller.status) + (stop ? " → stopping the service" : " → playback continues"));
        if (stop) stopSelf();
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "PlaybackService.onDestroy (status=" + (controller == null ? "none" : controller.status) + ")");
        main.removeCallbacks(saver);
        if (controller != null) {
            controller.save();
            controller.release(); // late radio/library/engine callbacks must not touch a released player
        }
        if (dj != null) dj.release(); // both decks: no transition or callback may touch a released player
        if (queueFile != null) queueFile.close();
        if (session != null) session.release();
        if (player != null) player.release();
        if (player2 != null) player2.release();
        if (io != null) io.shutdown();
        instance = null;
        super.onDestroy();
    }
}
