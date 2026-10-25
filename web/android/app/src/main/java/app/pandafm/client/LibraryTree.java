package app.pandafm.client;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * PandaFM for Android Auto (5.0.1): the browse tree, playing from it, search
 * and voice requests. Pure Java over PandaFM's own API (signed in by
 * AuthCore, never Navidrome) and the downloaded-music catalogue, so it is
 * tested without Android. Media ids are stable and namespaced
 * ("album:<id>", "station:<id>", "playlist:<id>|track:<id>"); never names,
 * never URLs, never credentials.
 */
final class LibraryTree {
    interface PandaApi {
        Object get(String path) throws ApiError;
        Object post(String path, String json) throws ApiError;
    }

    /** status 0: PandaFM can't be reached; 401: this device isn't signed in (any more). */
    static final class ApiError extends Exception {
        final int status;

        ApiError(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    /** What's downloaded on this phone (synced from the app's offline manager). */
    interface Catalog {
        List<Map<String, Object>> tracks(); // [{track: {...}, uri: "content://..."}]
        List<Map<String, Object>> collections(); // [{key, kind, id, name, trackIds: [...], coverArtId}]
    }

    static final class Node {
        final String id, title, subtitle, coverArtId;
        final boolean browsable, playable;
        final String type; // folder | album | artist | playlist | genre | radio | track | message
        final Map<String, Object> track;

        Node(String id, String title, String subtitle, String coverArtId, boolean browsable, boolean playable, String type, Map<String, Object> track) {
            this.id = id;
            this.title = title;
            this.subtitle = subtitle;
            this.coverArtId = coverArtId;
            this.browsable = browsable;
            this.playable = playable;
            this.type = type;
            this.track = track;
        }
    }

    /** What to play: a list of tracks (with a source for the UI), a radio to start, or the saved queue. */
    static final class Resolution {
        List<Map<String, Object>> tracks = new ArrayList<>();
        int start;
        Map<String, Object> source;
        String radioPreset, radioSeedKind, radioSeedId;
        boolean resume;
        String error;

        boolean isRadio() {
            return radioSeedKind != null || radioPreset != null;
        }
    }

    static final String SIGN_IN = "Open PandaFM on your phone to sign in.";
    static final int MAX_CONTEXT = 300;

    private final PandaApi api;
    private final Catalog catalog;

    LibraryTree(PandaApi api, Catalog catalog) {
        this.api = api;
        this.catalog = catalog;
    }

    static Node folder(String id, String title) {
        return new Node(id, title, null, null, true, false, "folder", null);
    }

    Node root() {
        return folder("root", "PandaFM");
    }

    // ── browsing ──
    List<Node> children(String id, int page, int size, boolean signedIn, boolean online) throws ApiError {
        if ("root".equals(id)) return rootChildren(signedIn, online);
        if (id.startsWith("downloaded") || id.startsWith("dl:")) return downloaded(id, page, size);
        if (!signedIn) throw new ApiError(401, SIGN_IN); // nothing remote without a sign-in
        if (!online) throw new ApiError(0, "PandaFM can’t be reached. Downloaded music is still here.");
        int offset = Math.max(0, page) * Math.max(1, size);
        switch (id) {
            case "recent": return tracks("recent", list(map(api.get("/me/home")), "recently_played"), page, size);
            case "favorites": return tracks("favorites", list(map(api.get("/favorites")), "tracks"), page, size);
            case "radio": {
                List<Node> out = new ArrayList<>();
                for (Map<String, Object> p : Json.maps(api.get("/radio/presets")))
                    out.add(new Node("radio-mode:" + Json.str(p, "id"), Json.str(p, "name"), Json.str(p, "description"), null, false, true, "radio", null));
                return slice(out, page, size);
            }
            case "stations": {
                List<Node> out = new ArrayList<>();
                for (Map<String, Object> s : Json.maps(api.get("/radio/stations")))
                    out.add(new Node("station:" + Json.str(s, "id"), Json.str(s, "name"), Json.str(s, "label"), null, false, true, "radio", null));
                return slice(out, page, size);
            }
            case "playlists": {
                List<Node> out = new ArrayList<>();
                for (Map<String, Object> p : list(map(api.get("/playlists")), "playlists"))
                    out.add(new Node("playlist:" + Json.str(p, "id"), Json.str(p, "name"), count(Json.num(p, "track_count")), Json.str(p, "cover_art_id"), true, true, "playlist", null));
                return slice(out, page, size);
            }
            case "albums": // the server pages these
                return albums(list(map(api.get("/albums?list=alphabetical&size=" + size + "&offset=" + offset)), "albums"));
            case "artists": {
                List<Node> out = new ArrayList<>();
                for (Map<String, Object> a : list(map(api.get("/artists")), "artists"))
                    out.add(new Node("artist:" + Json.str(a, "id"), Json.str(a, "name"), null, Json.str(a, "cover_art_id"), true, true, "artist", null));
                return slice(out, page, size);
            }
            case "genres": {
                List<Node> out = new ArrayList<>();
                for (Map<String, Object> g : Json.maps(api.get("/genres"))) {
                    List<Object> covers = Json.list(g.get("cover_art_ids"));
                    out.add(new Node("genre:" + Json.str(g, "key"), Json.str(g, "name"), count(Json.num(g, "songs")), covers == null || covers.isEmpty() ? null : (String) covers.get(0), true, true, "genre", null));
                }
                return slice(out, page, size);
            }
            case "collections": {
                List<Node> out = new ArrayList<>();
                for (Map<String, Object> c : Json.maps(api.get("/collections"))) {
                    String cid = Json.str(c, "id");
                    if ("favorites".equals(cid)) out.add(folder("favorites", Json.str(c, "name")));
                    else out.add(new Node("collection:" + cid, Json.str(c, "name"), Json.str(c, "description"), null, true, !"recent".equals(cid), "folder", null));
                }
                return slice(out, page, size);
            }
            default:
                break;
        }
        String[] kv = split(id);
        switch (kv[0]) {
            case "playlist": return tracks(id, list(map(api.get("/playlists/" + enc(kv[1]))), "tracks"), page, size);
            case "album": return tracks(id, list(map(api.get("/albums/" + enc(kv[1]))), "tracks"), page, size);
            case "artist": return albums(slice(list(map(api.get("/artists/" + enc(kv[1]))), "albums"), page, size));
            case "genre": {
                String name = Json.str(Json.map(map(api.get("/genres/" + enc(kv[1]))).get("genre")), "name");
                List<Node> out = new ArrayList<>();
                out.add(new Node("genre-radio:" + kv[1], "Start " + name + " Radio", null, null, false, true, "radio", null));
                out.add(folder("genre-songs:" + kv[1], "Songs"));
                out.add(folder("genre-albums:" + kv[1], "Albums"));
                return slice(out, page, size);
            }
            case "genre-songs":
                return tracks(id, list(map(api.get("/browse/tracks?genre=" + enc(kv[1]) + "&order=artist&offset=" + offset + "&limit=" + size)), "tracks"), 0, size);
            case "genre-albums":
                return albums(list(map(api.get("/browse/albums?genre=" + enc(kv[1]) + "&offset=" + offset + "&limit=" + size)), "albums"));
            case "collection":
                if ("recent".equals(kv[1])) return albums(list(map(api.get("/albums?list=newest&size=" + size + "&offset=" + offset)), "albums"));
                return tracks(id, list(map(api.get("/collections/" + enc(kv[1]) + "/tracks?offset=" + offset + "&limit=" + size)), "tracks"), 0, size);
            default:
                return new ArrayList<>();
        }
    }

    private List<Node> rootChildren(boolean signedIn, boolean online) {
        List<Node> out = new ArrayList<>();
        boolean haveDownloads = !catalog.tracks().isEmpty();
        if (!signedIn) {
            out.add(new Node("signin", SIGN_IN, null, null, false, false, "message", null));
            if (haveDownloads) out.add(folder("downloaded", "Downloaded"));
            return out;
        }
        if (!online) { // PandaFM — offline: only what can actually play
            out.add(folder("downloaded", "Downloaded"));
            out.add(new Node("resume", "Resume queue", null, null, false, true, "folder", null));
            return out;
        }
        String[][] entries = {{"recent", "Recently played"}, {"favorites", "Favorites"}, {"radio", "Panda Radio"}, {"stations", "My Stations"},
            {"playlists", "Playlists"}, {"genres", "Genres"}, {"albums", "Albums"}, {"artists", "Artists"}, {"collections", "Smart Collections"}, {"downloaded", "Downloaded"}};
        for (String[] e : entries) out.add(folder(e[0], e[1]));
        return out;
    }

    private List<Node> downloaded(String id, int page, int size) {
        List<Node> out = new ArrayList<>();
        if ("downloaded".equals(id)) {
            out.add(folder("downloaded:albums", "Albums"));
            out.add(folder("downloaded:playlists", "Playlists"));
            out.add(folder("downloaded:songs", "Songs"));
            return out;
        }
        if ("downloaded:albums".equals(id) || "downloaded:playlists".equals(id)) {
            String kind = id.endsWith("albums") ? "album" : "playlist";
            for (Map<String, Object> c : catalog.collections())
                if (kind.equals(Json.str(c, "kind")))
                    out.add(new Node("dl:" + Json.str(c, "key"), Json.str(c, "name"), count((long) listSize(c.get("trackIds"))), Json.str(c, "coverArtId"), true, true, kind, null));
            return slice(out, page, size);
        }
        return tracks(id, downloadedTracks(id), page, size);
    }

    private List<Map<String, Object>> downloadedTracks(String id) {
        List<Map<String, Object>> out = new ArrayList<>();
        if ("downloaded:songs".equals(id)) {
            for (Map<String, Object> t : catalog.tracks()) if (Json.map(t.get("track")) != null) out.add(Json.map(t.get("track")));
            return out;
        }
        String key = id.substring(3);
        for (Map<String, Object> c : catalog.collections()) {
            if (!key.equals(Json.str(c, "key"))) continue;
            for (Object tid : Json.list(c.get("trackIds")) == null ? new ArrayList<>() : Json.list(c.get("trackIds")))
                for (Map<String, Object> t : catalog.tracks()) {
                    Map<String, Object> track = Json.map(t.get("track"));
                    if (track != null && tid.equals(Json.str(track, "id"))) out.add(track);
                }
        }
        return out;
    }

    // ── playing what was chosen ──
    Resolution resolve(String mediaId, boolean signedIn, boolean online) throws ApiError {
        Resolution r = new Resolution();
        if ("resume".equals(mediaId)) { r.resume = true; return r; }
        String context = mediaId, trackId = null;
        int bar = mediaId.indexOf("|track:");
        if (bar >= 0) {
            context = mediaId.substring(0, bar);
            trackId = mediaId.substring(bar + 7);
        }
        if (context.startsWith("downloaded") || context.startsWith("dl:")) {
            r.tracks = downloadedTracks(context);
            r.source = source("tracks", "Downloaded", null);
        } else {
            if (!signedIn) throw new ApiError(401, SIGN_IN);
            if (!online) throw new ApiError(0, "PandaFM can’t be reached.");
            String[] kv = split(context);
            switch (kv[0]) {
                case "radio-mode": r.radioPreset = kv[1]; return r;
                case "station": r.radioSeedKind = "station"; r.radioSeedId = kv[1]; return r;
                case "genre":
                case "genre-radio": r.radioPreset = "panda"; r.radioSeedKind = "genre"; r.radioSeedId = kv[1]; return r;
                case "track": {
                    r.tracks.add(map(api.get("/tracks/" + enc(kv[1]))));
                    r.source = source("search", "Search", null);
                    return r;
                }
                default:
                    r.tracks = contextTracks(context);
                    r.source = sourceFor(context);
            }
        }
        if (trackId != null) for (int k = 0; k < r.tracks.size(); k++) if (trackId.equals(Json.str(r.tracks.get(k), "id"))) r.start = k;
        if (r.tracks.isEmpty()) r.error = "There’s nothing to play here.";
        return r;
    }

    /** All the songs of a container, in order (bounded), for a queue that keeps the context. */
    private List<Map<String, Object>> contextTracks(String context) throws ApiError {
        String[] kv = split(context);
        switch (kv[0]) {
            case "recent": return list(map(api.get("/me/home")), "recently_played");
            case "favorites": return list(map(api.get("/favorites")), "tracks");
            case "playlist": return list(map(api.get("/playlists/" + enc(kv[1]))), "tracks");
            case "album": return list(map(api.get("/albums/" + enc(kv[1]))), "tracks");
            case "artist": return list(map(api.get("/artists/" + enc(kv[1]) + "/tracks")), "tracks");
            case "genre-songs": return list(map(api.get("/browse/tracks?genre=" + enc(kv[1]) + "&order=artist&offset=0&limit=" + MAX_CONTEXT)), "tracks");
            case "collection": return list(map(api.get("/collections/" + enc(kv[1]) + "/tracks?offset=0&limit=" + MAX_CONTEXT)), "tracks");
            default: return new ArrayList<>();
        }
    }

    private static Map<String, Object> sourceFor(String context) {
        String[] kv = split(context);
        switch (kv[0]) {
            case "recent": return source("tracks", "Recently played", null);
            case "favorites": return source("favorites", "Favorites", null);
            case "playlist": return source("playlist", "Playlist", kv[1]);
            case "album": return source("album", "Album", kv[1]);
            case "artist": return source("artist", "Artist", kv[1]);
            case "genre-songs": return source("tracks", "Genre", kv[1]);
            default: return source("tracks", "PandaFM", null);
        }
    }

    static Map<String, Object> source(String kind, String name, String id) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("kind", kind);
        s.put("name", name);
        if (id != null) s.put("id", id);
        return s;
    }

    // ── search and voice ──
    List<Node> search(String query, int page, int size, boolean signedIn, boolean online) throws ApiError {
        List<Node> out = new ArrayList<>();
        String q = query == null ? "" : query.trim();
        if (q.isEmpty()) return out;
        if (!signedIn || !online) {
            for (Map<String, Object> t : offlineMatches(q)) out.add(trackNode("downloaded:songs", t));
            return slice(out, page, size);
        }
        Map<String, Object> res = map(api.get("/search?q=" + enc(q) + "&limit=20"));
        for (Map<String, Object> g : list(res, "genres")) out.add(new Node("genre:" + Json.str(g, "key"), Json.str(g, "name"), "Genre", null, true, true, "genre", null));
        for (Map<String, Object> a : list(res, "artists")) out.add(new Node("artist:" + Json.str(a, "id"), Json.str(a, "name"), "Artist", Json.str(a, "cover_art_id"), true, true, "artist", null));
        out.addAll(albums(list(res, "albums")));
        String lower = q.toLowerCase(Locale.ROOT);
        for (Map<String, Object> p : list(map(api.get("/playlists")), "playlists"))
            if (lc(Json.str(p, "name")).contains(lower)) out.add(new Node("playlist:" + Json.str(p, "id"), Json.str(p, "name"), "Playlist", Json.str(p, "cover_art_id"), true, true, "playlist", null));
        for (Map<String, Object> s : Json.maps(api.get("/radio/stations")))
            if (lc(Json.str(s, "name")).contains(lower)) out.add(new Node("station:" + Json.str(s, "id"), Json.str(s, "name"), "Station", null, false, true, "radio", null));
        for (Map<String, Object> t : list(res, "tracks")) out.add(trackNode("track", t));
        return slice(out, page, size);
    }

    /**
     * "Play Daft Punk", "Play my workout playlist", "Play my Pop Punk station": deterministic.
     * A spoken "playlist"/"station" goes first; otherwise exact song, artist, album, playlist,
     * genre (its radio), station, then the broader search.
     */
    Resolution resolveVoice(String spoken, boolean signedIn, boolean online) throws ApiError {
        String q = lc(spoken).replaceAll("^play(\\s+|$)", "").replaceAll("^(my|the)\\s+", "").trim();
        boolean wantsPlaylist = q.endsWith(" playlist"), wantsStation = q.endsWith(" station") || q.endsWith(" radio");
        q = q.replaceAll("\\s+(playlist|station|radio)$", "").trim();
        Resolution r = new Resolution();
        if (q.isEmpty()) { r.resume = true; return r; } // "Play PandaFM": carry on
        if (!signedIn || !online) {
            r.tracks = offlineMatches(q);
            r.source = source("tracks", "Downloaded", null);
            if (r.tracks.isEmpty()) r.error = "Nothing downloaded matches “" + spoken.trim() + "”.";
            return r;
        }
        if (wantsStation && station(q, r)) return r;
        if (wantsPlaylist && playlist(q, r, true)) return r;
        Map<String, Object> res = map(api.get("/search?q=" + enc(q) + "&limit=20"));
        List<Map<String, Object>> tracks = list(res, "tracks");
        for (int k = 0; k < tracks.size(); k++) if (q.equals(lc(Json.str(tracks.get(k), "title")))) return play(r, tracks, k, source("search", "Search", null));
        for (Map<String, Object> a : list(res, "artists"))
            if (q.equals(lc(Json.str(a, "name")))) return play(r, contextTracks("artist:" + Json.str(a, "id")), 0, source("artist", Json.str(a, "name"), Json.str(a, "id")));
        for (Map<String, Object> a : list(res, "albums"))
            if (q.equals(lc(Json.str(a, "name")))) return play(r, contextTracks("album:" + Json.str(a, "id")), 0, source("album", Json.str(a, "name"), Json.str(a, "id")));
        if (playlist(q, r, false)) return r;
        for (Map<String, Object> g : list(res, "genres")) {
            if (q.equals(lc(Json.str(g, "key"))) || q.equals(lc(Json.str(g, "name")))) {
                r.radioPreset = "panda";
                r.radioSeedKind = "genre";
                r.radioSeedId = Json.str(g, "key");
                return r;
            }
        }
        if (station(q, r)) return r;
        if (!tracks.isEmpty()) return play(r, tracks, 0, source("search", "Search", null));
        List<Map<String, Object>> albums = list(res, "albums"), artists = list(res, "artists");
        if (!albums.isEmpty()) return play(r, contextTracks("album:" + Json.str(albums.get(0), "id")), 0, source("album", Json.str(albums.get(0), "name"), Json.str(albums.get(0), "id")));
        if (!artists.isEmpty()) return play(r, contextTracks("artist:" + Json.str(artists.get(0), "id")), 0, source("artist", Json.str(artists.get(0), "name"), Json.str(artists.get(0), "id")));
        r.error = "Nothing in your library matches “" + spoken.trim() + "”.";
        return r;
    }

    private boolean playlist(String q, Resolution r, boolean loose) throws ApiError {
        for (Map<String, Object> p : list(map(api.get("/playlists")), "playlists")) {
            String name = lc(Json.str(p, "name"));
            if (name.equals(q) || (loose && name.contains(q))) {
                play(r, contextTracks("playlist:" + Json.str(p, "id")), 0, source("playlist", Json.str(p, "name"), Json.str(p, "id")));
                return true;
            }
        }
        return false;
    }

    private boolean station(String q, Resolution r) throws ApiError {
        for (Map<String, Object> s : Json.maps(api.get("/radio/stations"))) {
            if (lc(Json.str(s, "name")).equals(q)) {
                r.radioSeedKind = "station";
                r.radioSeedId = Json.str(s, "id");
                return true;
            }
        }
        return false;
    }

    private static Resolution play(Resolution r, List<Map<String, Object>> tracks, int start, Map<String, Object> source) {
        r.tracks = tracks;
        r.start = start;
        r.source = source;
        if (tracks.isEmpty()) r.error = "There’s nothing to play here.";
        return r;
    }

    private List<Map<String, Object>> offlineMatches(String q) {
        String lower = q.toLowerCase(Locale.ROOT);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> t : catalog.tracks()) {
            Map<String, Object> track = Json.map(t.get("track"));
            if (track == null) continue;
            if (lc(Json.str(track, "title")).contains(lower) || lc(Json.str(track, "artist")).contains(lower) || lc(Json.str(track, "album")).contains(lower)) out.add(track);
        }
        return out;
    }

    // ── helpers ──
    private List<Node> tracks(String context, List<Map<String, Object>> tracks, int page, int size) {
        List<Node> out = new ArrayList<>();
        for (Map<String, Object> t : tracks) out.add(trackNode(context, t));
        return slice(out, page, size);
    }

    static Node trackNode(String context, Map<String, Object> t) {
        String id = "track".equals(context) ? "track:" + Json.str(t, "id") : context + "|track:" + Json.str(t, "id");
        return new Node(id, Json.str(t, "title"), Json.str(t, "artist"), Json.str(t, "cover_art_id"), false, true, "track", t);
    }

    private static List<Node> albums(List<Map<String, Object>> albums) {
        List<Node> out = new ArrayList<>();
        for (Map<String, Object> a : albums) out.add(new Node("album:" + Json.str(a, "id"), Json.str(a, "name"), Json.str(a, "artist"), Json.str(a, "cover_art_id"), true, true, "album", null));
        return out;
    }

    static <T> List<T> slice(List<T> all, int page, int size) {
        int from = Math.max(0, page) * Math.max(1, size);
        if (from >= all.size()) return new ArrayList<>();
        return new ArrayList<>(all.subList(from, Math.min(all.size(), from + Math.max(1, size))));
    }

    private static Map<String, Object> map(Object o) throws ApiError {
        Map<String, Object> m = Json.map(o);
        if (m == null) throw new ApiError(502, "PandaFM sent something unexpected.");
        return m;
    }

    private static List<Map<String, Object>> list(Map<String, Object> m, String key) {
        return Json.maps(m == null ? null : m.get(key));
    }

    private static int listSize(Object o) {
        List<Object> l = Json.list(o);
        return l == null ? 0 : l.size();
    }

    private static String[] split(String id) {
        int c = id.indexOf(':');
        return c < 0 ? new String[] {id, ""} : new String[] {id.substring(0, c), id.substring(c + 1)};
    }

    private static String lc(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT).trim();
    }

    private static String count(Long n) {
        return n == null ? null : n + (n == 1 ? " song" : " songs");
    }

    static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }
}
