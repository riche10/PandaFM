package app.pandafm.client;

import android.content.Context;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;

/**
 * Android Auto's view of PandaFM (and any other media browser): the browse
 * tree, search, and play requests. Network work runs on a background
 * executor, never the main thread. Signed out, it shows only "Open PandaFM on
 * your phone to sign in." (plus downloads).
 */
@OptIn(markerClass = UnstableApi.class)
final class LibraryCallback implements MediaLibraryService.MediaLibrarySession.Callback {
    private final Context ctx;
    private final LibraryTree tree;
    private final ExecutorService io;
    private final Map<String, List<LibraryTree.Node>> searches = new ConcurrentHashMap<>();

    LibraryCallback(Context ctx, LibraryTree tree, ExecutorService io) {
        this.ctx = ctx.getApplicationContext();
        this.tree = tree;
        this.io = io;
    }

    private boolean signedIn() {
        return AuthStore.get(ctx).signedIn();
    }

    private boolean online() {
        return NetworkState.of(ctx).connected;
    }

    @Override
    public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(MediaLibraryService.MediaLibrarySession session, MediaSession.ControllerInfo browser, MediaLibraryService.LibraryParams params) {
        return Futures.immediateFuture(LibraryResult.ofItem(item(tree.root(), browser), params));
    }

    @Override
    public ListenableFuture<LibraryResult<MediaItem>> onGetItem(MediaLibraryService.MediaLibrarySession session, MediaSession.ControllerInfo browser, String mediaId) {
        boolean track = mediaId.contains("track:");
        boolean radio = mediaId.startsWith("radio-mode:") || mediaId.startsWith("station:") || mediaId.startsWith("genre-radio:");
        LibraryTree.Node n = new LibraryTree.Node(mediaId, mediaId, null, null, !track && !radio, true, track ? "track" : "folder", null);
        return Futures.immediateFuture(LibraryResult.ofItem(item(n, browser), null));
    }

    @Override
    public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(MediaLibraryService.MediaLibrarySession session, MediaSession.ControllerInfo browser,
            String parentId, int page, int pageSize, MediaLibraryService.LibraryParams params) {
        SettableFuture<LibraryResult<ImmutableList<MediaItem>>> result = SettableFuture.create();
        io.execute(() -> {
            List<MediaItem> items = new ArrayList<>();
            try {
                for (LibraryTree.Node n : tree.children(parentId, page, Math.min(Math.max(1, pageSize), 100), signedIn(), online())) items.add(item(n, browser));
            } catch (LibraryTree.ApiError e) {
                items.add(message(e));
            }
            result.set(LibraryResult.ofItemList(items, params));
        });
        return result;
    }

    @Override
    public ListenableFuture<LibraryResult<Void>> onSearch(MediaLibraryService.MediaLibrarySession session, MediaSession.ControllerInfo browser, String query,
            MediaLibraryService.LibraryParams params) {
        io.execute(() -> {
            List<LibraryTree.Node> found;
            try {
                found = tree.search(query, 0, 60, signedIn(), online());
            } catch (LibraryTree.ApiError e) {
                found = new ArrayList<>();
            }
            searches.put(query, found);
            session.notifySearchResultChanged(browser, query, found.size(), params);
        });
        return Futures.immediateFuture(LibraryResult.ofVoid());
    }

    @Override
    public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(MediaLibraryService.MediaLibrarySession session, MediaSession.ControllerInfo browser,
            String query, int page, int pageSize, MediaLibraryService.LibraryParams params) {
        List<MediaItem> items = new ArrayList<>();
        List<LibraryTree.Node> found = searches.get(query);
        if (found != null) for (LibraryTree.Node n : LibraryTree.slice(found, page, Math.max(1, pageSize))) items.add(item(n, browser));
        return Futures.immediateFuture(LibraryResult.ofItemList(items, params));
    }

    /** Play requests (from browsing or voice) are resolved by QueuePlayer → PlaybackService.resolveAndPlay. */
    @Override
    public ListenableFuture<List<MediaItem>> onAddMediaItems(MediaSession mediaSession, MediaSession.ControllerInfo controller, List<MediaItem> mediaItems) {
        return Futures.immediateFuture(mediaItems);
    }

    @Override
    public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(MediaSession mediaSession, MediaSession.ControllerInfo controller,
            List<MediaItem> mediaItems, int startIndex, long startPositionMs) {
        return Futures.immediateFuture(new MediaSession.MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs));
    }

    private MediaItem message(LibraryTree.ApiError e) {
        String text = e.status == 401 ? LibraryTree.SIGN_IN : e.status == 0 ? "PandaFM can’t be reached. Downloaded music is still here." : "PandaFM couldn’t load this.";
        return item(new LibraryTree.Node("message", text, null, null, false, false, "message", null), null);
    }

    private MediaItem item(LibraryTree.Node n, MediaSession.ControllerInfo browser) {
        MediaMetadata.Builder m = new MediaMetadata.Builder()
            .setTitle(n.title)
            .setSubtitle(n.subtitle)
            .setIsBrowsable(n.browsable)
            .setIsPlayable(n.playable)
            .setMediaType(type(n.type));
        if (n.track != null) m.setArtist(Json.str(n.track, "artist")).setAlbumTitle(Json.str(n.track, "album"));
        if (n.coverArtId != null && browser != null) m.setArtworkUri(ArtworkProvider.grant(ctx, n.coverArtId, browser.getPackageName()));
        return new MediaItem.Builder().setMediaId(n.id).setMediaMetadata(m.build()).build();
    }

    private static int type(String t) {
        switch (t) {
            case "track": return MediaMetadata.MEDIA_TYPE_MUSIC;
            case "album": return MediaMetadata.MEDIA_TYPE_ALBUM;
            case "artist": return MediaMetadata.MEDIA_TYPE_ARTIST;
            case "playlist": return MediaMetadata.MEDIA_TYPE_PLAYLIST;
            case "genre": return MediaMetadata.MEDIA_TYPE_GENRE;
            case "radio": return MediaMetadata.MEDIA_TYPE_RADIO_STATION;
            default: return MediaMetadata.MEDIA_TYPE_FOLDER_MIXED;
        }
    }
}
