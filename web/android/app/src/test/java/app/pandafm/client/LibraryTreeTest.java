package app.pandafm.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** Android Auto browsing, playing and search over deterministic fake PandaFM responses. */
public class LibraryTreeTest {
    static final class FakeApi implements LibraryTree.PandaApi {
        final Map<String, String> responses = new HashMap<>();
        final List<String> asked = new ArrayList<>();
        public Object get(String path) throws LibraryTree.ApiError {
            asked.add(path);
            String body = responses.get(path);
            if (body == null) throw new LibraryTree.ApiError(404, "no fake for " + path);
            return Json.parse(body);
        }
        public Object post(String path, String json) throws LibraryTree.ApiError { return get(path); }
    }

    static String t(String id, String title, String artist, String album) {
        return "{\"id\":\"" + id + "\",\"title\":\"" + title + "\",\"artist\":\"" + artist + "\",\"album\":\"" + album + "\",\"cover_art_id\":\"c" + id + "\"}";
    }

    final FakeApi api = new FakeApi();
    final List<Map<String, Object>> dlTracks = new ArrayList<>();
    final List<Map<String, Object>> dlCollections = new ArrayList<>();
    final LibraryTree tree = new LibraryTree(api, new LibraryTree.Catalog() {
        public List<Map<String, Object>> tracks() { return dlTracks; }
        public List<Map<String, Object>> collections() { return dlCollections; }
    });

    {
        api.responses.put("/me/home", "{\"recently_played\":[" + t("s1", "One More Time", "Daft Punk", "Discovery") + "]}");
        api.responses.put("/favorites", "{\"tracks\":[" + t("s2", "Get Lucky", "Daft Punk", "Random Access Memories") + "," + t("s3", "Lose Yourself to Dance", "Daft Punk", "Random Access Memories") + "]}");
        api.responses.put("/radio/presets", "[{\"id\":\"panda\",\"name\":\"Panda Radio\",\"description\":\"Balanced\"},{\"id\":\"familiar\",\"name\":\"Familiar\",\"description\":\"Old friends\"},{\"id\":\"u-1\",\"name\":\"Night Drive\",\"description\":\"Custom\"}]");
        api.responses.put("/radio/stations", "[{\"id\":\"st1\",\"name\":\"Pop Punk Drive\",\"label\":\"Pop Punk Drive · Deep Cuts\"}]");
        api.responses.put("/playlists", "{\"playlists\":[{\"id\":\"p1\",\"name\":\"Workout\",\"track_count\":2,\"cover_art_id\":\"pc\"}]}");
        api.responses.put("/playlists/p1", "{\"tracks\":[" + t("s4", "Harder Better", "Daft Punk", "Discovery") + "," + t("s5", "Around the World", "Daft Punk", "Homework") + "]}");
        api.responses.put("/albums?list=alphabetical&size=2&offset=0", "{\"albums\":[{\"id\":\"a1\",\"name\":\"Discovery\",\"artist\":\"Daft Punk\"},{\"id\":\"a2\",\"name\":\"Homework\",\"artist\":\"Daft Punk\"}]}");
        api.responses.put("/albums?list=alphabetical&size=2&offset=2", "{\"albums\":[{\"id\":\"a3\",\"name\":\"Random Access Memories\",\"artist\":\"Daft Punk\"}]}");
        api.responses.put("/albums/a3", "{\"tracks\":[" + t("s2", "Get Lucky", "Daft Punk", "RAM") + "," + t("s3", "Lose Yourself to Dance", "Daft Punk", "RAM") + "]}");
        api.responses.put("/artists", "{\"artists\":[{\"id\":\"ar1\",\"name\":\"Daft Punk\"},{\"id\":\"ar2\",\"name\":\"Justice\"}]}");
        api.responses.put("/artists/ar1", "{\"albums\":[{\"id\":\"a1\",\"name\":\"Discovery\",\"artist\":\"Daft Punk\"}]}");
        api.responses.put("/artists/ar1/tracks", "{\"tracks\":[" + t("s1", "One More Time", "Daft Punk", "Discovery") + "]}");
        api.responses.put("/genres", "[{\"key\":\"pop punk\",\"name\":\"Pop Punk\",\"songs\":10,\"cover_art_ids\":[\"g1\"]}]");
        api.responses.put("/genres/pop%20punk", "{\"genre\":{\"key\":\"pop punk\",\"name\":\"Pop Punk\"}}");
        api.responses.put("/browse/tracks?genre=pop%20punk&order=artist&offset=0&limit=20", "{\"tracks\":[" + t("s9", "Misery Business", "Paramore", "Riot!") + "]}");
        api.responses.put("/collections", "[{\"id\":\"recent\",\"name\":\"Recently Added\"},{\"id\":\"unplayed\",\"name\":\"Unplayed\",\"count\":4},{\"id\":\"favorites\",\"name\":\"Favorites\"},{\"id\":\"hires\",\"name\":\"Hi-Res\"}]");
        api.responses.put("/collections/hires/tracks?offset=0&limit=20", "{\"tracks\":[" + t("s7", "Clear Water", "Lossless Band", "Lossless Sessions") + "]}");
        api.responses.put("/search?q=daft%20punk&limit=100", "{\"tracks\":[" + t("s1", "One More Time", "Daft Punk", "Discovery") + "],\"albums\":[],\"artists\":[{\"id\":\"ar1\",\"name\":\"Daft Punk\"}],\"genres\":[]}");
        api.responses.put("/search?q=random%20access%20memories&limit=100", "{\"tracks\":[],\"albums\":[{\"id\":\"a3\",\"name\":\"Random Access Memories\",\"artist\":\"Daft Punk\"}],\"artists\":[],\"genres\":[]}");
        api.responses.put("/search?q=get%20lucky&limit=100", "{\"tracks\":[" + t("s3", "Lose Yourself to Dance", "Daft Punk", "RAM") + "," + t("s2", "Get Lucky", "Daft Punk", "RAM") + "],\"albums\":[],\"artists\":[],\"genres\":[]}");
        api.responses.put("/search?q=pop%20punk&limit=100", "{\"tracks\":[],\"albums\":[],\"artists\":[],\"genres\":[{\"key\":\"pop punk\",\"name\":\"Pop Punk\"}]}");
        api.responses.put("/search?q=zzz&limit=100", "{\"tracks\":[],\"albums\":[],\"artists\":[],\"genres\":[]}");
        api.responses.put("/search?q=workout&limit=100", "{\"tracks\":[],\"albums\":[],\"artists\":[],\"genres\":[]}");
    }

    List<String> ids(List<LibraryTree.Node> nodes) {
        List<String> out = new ArrayList<>();
        for (LibraryTree.Node n : nodes) out.add(n.id);
        return out;
    }

    @Test
    public void theRootIsShortAndUseful() throws Exception {
        assertEquals(Arrays.asList("recent", "favorites", "radio", "stations", "playlists", "genres", "albums", "artists", "collections", "downloaded"),
            ids(tree.children("root", 0, 50, true, true)));
        assertTrue(api.asked.isEmpty()); // no library request just to show the root
        assertTrue(tree.root().browsable && !tree.root().playable);
    }

    @Test
    public void signedOutShowsTheMessageAndNoRemoteMetadata() throws Exception {
        List<LibraryTree.Node> root = tree.children("root", 0, 50, false, true);
        assertEquals(Arrays.asList("signin"), ids(root));
        assertEquals(LibraryTree.SIGN_IN, root.get(0).title);
        assertFalse(root.get(0).browsable || root.get(0).playable);
        for (String id : new String[] {"albums", "playlists", "playlist:p1", "favorites"}) {
            try {
                tree.children(id, 0, 20, false, true);
                fail(id);
            } catch (LibraryTree.ApiError e) {
                assertEquals(401, e.status);
            }
        }
        try {
            tree.resolve("album:a3", false, true);
            fail();
        } catch (LibraryTree.ApiError e) {
            assertEquals(401, e.status);
        }
        assertTrue(api.asked.isEmpty());
    }

    @Test
    public void offlineRootOffersOnlyDownloadsAndResume() throws Exception {
        assertEquals(Arrays.asList("downloaded", "resume"), ids(tree.children("root", 0, 50, true, false)));
        try {
            tree.children("albums", 0, 20, true, false);
            fail();
        } catch (LibraryTree.ApiError e) {
            assertEquals(0, e.status);
        }
    }

    @Test
    public void browseEachSection() throws Exception {
        assertEquals(Arrays.asList("recent|track:s1"), ids(tree.children("recent", 0, 20, true, true)));
        assertEquals(Arrays.asList("favorites|track:s2", "favorites|track:s3"), ids(tree.children("favorites", 0, 20, true, true)));
        assertEquals(Arrays.asList("radio-mode:panda", "radio-mode:familiar", "radio-mode:u-1"), ids(tree.children("radio", 0, 20, true, true)));
        assertEquals(Arrays.asList("station:st1"), ids(tree.children("stations", 0, 20, true, true)));
        List<LibraryTree.Node> playlists = tree.children("playlists", 0, 20, true, true);
        assertEquals("playlist:p1", playlists.get(0).id);
        assertTrue(playlists.get(0).browsable && playlists.get(0).playable);
        assertEquals(Arrays.asList("playlist:p1|track:s4", "playlist:p1|track:s5"), ids(tree.children("playlist:p1", 0, 20, true, true)));
        assertEquals(Arrays.asList("artist:ar1", "artist:ar2"), ids(tree.children("artists", 0, 20, true, true)));
        assertEquals(Arrays.asList("album:a1"), ids(tree.children("artist:ar1", 0, 20, true, true)));
        assertEquals(Arrays.asList("genre:pop punk"), ids(tree.children("genres", 0, 20, true, true)));
        assertEquals(Arrays.asList("genre-radio:pop punk", "genre-songs:pop punk", "genre-albums:pop punk"), ids(tree.children("genre:pop punk", 0, 20, true, true)));
        assertEquals(Arrays.asList("genre-songs:pop punk|track:s9"), ids(tree.children("genre-songs:pop punk", 0, 20, true, true)));
        assertEquals(Arrays.asList("collection:recent", "collection:unplayed", "favorites", "collection:hires"), ids(tree.children("collections", 0, 20, true, true)));
        assertEquals(Arrays.asList("collection:hires|track:s7"), ids(tree.children("collection:hires", 0, 20, true, true)));
        LibraryTree.Node track = tree.children("album:a3", 0, 20, true, true).get(0);
        assertTrue(track.playable && !track.browsable);
        assertEquals("cs2", track.coverArtId); // artwork by id, never a URL with a token
    }

    @Test
    public void albumsArePagedByTheServer() throws Exception {
        assertEquals(Arrays.asList("album:a1", "album:a2"), ids(tree.children("albums", 0, 2, true, true)));
        assertEquals(Arrays.asList("album:a3"), ids(tree.children("albums", 1, 2, true, true)));
        assertTrue(api.asked.contains("/albums?list=alphabetical&size=2&offset=2"));
    }

    @Test
    public void playingASongPlaysItsWholeContainerFromThere() throws Exception {
        LibraryTree.Resolution r = tree.resolve("playlist:p1|track:s5", true, true);
        assertEquals(2, r.tracks.size());
        assertEquals(1, r.start);
        assertEquals("playlist", r.source.get("kind"));
        LibraryTree.Resolution album = tree.resolve("album:a3", true, true); // play the container itself
        assertEquals(0, album.start);
        assertEquals(2, album.tracks.size());
        LibraryTree.Resolution station = tree.resolve("station:st1", true, true);
        assertEquals("station", station.radioSeedKind);
        LibraryTree.Resolution mode = tree.resolve("radio-mode:familiar", true, true);
        assertEquals("familiar", mode.radioPreset);
        LibraryTree.Resolution genre = tree.resolve("genre-radio:pop punk", true, true);
        assertEquals("genre", genre.radioSeedKind);
        assertEquals("pop punk", genre.radioSeedId);
    }

    @Test
    public void downloadsBrowseAndPlayWithoutTheServer() throws Exception {
        dlTracks.add(Json.map(Json.parse("{\"uri\":\"content://x/s4\",\"track\":" + t("s4", "Harder Better", "Daft Punk", "Discovery") + "}")));
        dlTracks.add(Json.map(Json.parse("{\"uri\":\"content://x/s5\",\"track\":" + t("s5", "Around the World", "Daft Punk", "Homework") + "}")));
        dlCollections.add(Json.map(Json.parse("{\"key\":\"playlist:p1\",\"kind\":\"playlist\",\"id\":\"p1\",\"name\":\"Workout\",\"trackIds\":[\"s4\",\"s5\"]}")));
        assertEquals(Arrays.asList("signin", "downloaded"), ids(tree.children("root", 0, 20, false, false)));
        assertEquals(Arrays.asList("dl:playlist:p1"), ids(tree.children("downloaded:playlists", 0, 20, false, false)));
        LibraryTree.Resolution r = tree.resolve("dl:playlist:p1|track:s5", false, false);
        assertEquals(1, r.start);
        assertEquals(2, r.tracks.size());
        assertEquals(Arrays.asList("downloaded:songs|track:s4", "downloaded:songs|track:s5"), ids(tree.children("downloaded:songs", 0, 20, false, false)));
        assertTrue(api.asked.isEmpty());
        assertEquals(1, tree.search("around", 0, 20, false, false).size()); // offline search: downloads only
    }

    @Test
    public void searchUsesTheServerAndIncludesPlaylistsAndStations() throws Exception {
        List<String> found = ids(tree.search("daft punk", 0, 20, true, true));
        assertEquals(Arrays.asList("artist:ar1", "track:s1"), found);
        assertEquals(Arrays.asList("playlist:p1"), ids(tree.search("workout", 0, 20, true, true)));
        assertTrue(tree.search("zzz", 0, 20, true, true).isEmpty());
        assertTrue(tree.search("  ", 0, 20, true, true).isEmpty());
    }

    @Test
    public void voiceRequestsAreDeterministic() throws Exception {
        LibraryTree.Resolution artist = tree.resolveVoice("Play Daft Punk", true, true);
        assertEquals("artist", artist.source.get("kind")); // exact artist (no song called "daft punk")
        LibraryTree.Resolution album = tree.resolveVoice("play Random Access Memories", true, true);
        assertEquals("album", album.source.get("kind"));
        assertEquals(2, album.tracks.size());
        LibraryTree.Resolution song = tree.resolveVoice("Get Lucky", true, true);
        assertEquals("s2", Json.str(song.tracks.get(song.start), "id")); // the exact song, not the first result
        LibraryTree.Resolution playlist = tree.resolveVoice("Play my workout playlist", true, true);
        assertEquals("playlist", playlist.source.get("kind"));
        LibraryTree.Resolution genre = tree.resolveVoice("Play Pop Punk", true, true);
        assertEquals("pop punk", genre.radioSeedId);
        LibraryTree.Resolution station = tree.resolveVoice("Play my Pop Punk Drive station", true, true);
        assertEquals("st1", station.radioSeedId);
        LibraryTree.Resolution none = tree.resolveVoice("Play zzz", true, true);
        assertTrue(none.error.contains("zzz"));
        assertTrue(tree.resolveVoice("play", true, true).resume);
        assertNull(LibraryTree.slice(new ArrayList<String>(), 3, 10).isEmpty() ? null : "x");
    }

    // ── 5.5.2: search pages through every song (it used to stop at 20) ──
    static String songs(int from, int to) {
        StringBuilder b = new StringBuilder();
        for (int k = from; k < to; k++) b.append(k > from ? "," : "").append(t("cs" + k, "Cyber Space " + k, "Sonic Team", "Sonic Frontiers"));
        return b.toString();
    }

    void pages(String encodedQuery, int total) {
        for (int off = 0; off < total; off += LibraryTree.SEARCH_PAGE) {
            int to = Math.min(total, off + LibraryTree.SEARCH_PAGE);
            String extra = off == 0 ? ",\"albums\":[],\"artists\":[],\"genres\":[]" : "";
            api.responses.put("/search?q=" + encodedQuery + "&limit=100" + (off > 0 ? "&offset=" + off : ""),
                "{\"tracks\":[" + songs(off, to) + "],\"tracks_has_more\":" + (to < total) + extra + "}");
        }
        api.responses.put("/playlists", "{\"playlists\":[]}");
        api.responses.put("/radio/stations", "[]");
    }

    void cyberSpace(int total) {
        pages("cyber%20space", total);
    }

    @Test
    public void searchHonoursPageAndSizeBeyondTheFirst20Songs() throws Exception {
        cyberSpace(240);
        List<String> found = ids(tree.search("cyber space", 1, 120, true, true));
        assertEquals(120, found.size());
        assertEquals("track:cs120", found.get(0)); // page 2 of 120: songs 120..239
        assertEquals("track:cs239", found.get(119));
        assertTrue(api.asked.contains("/search?q=cyber%20space&limit=100&offset=100"));
        assertTrue(api.asked.contains("/search?q=cyber%20space&limit=100&offset=200"));
    }

    @Test
    public void searchFetchesOnlyThePagesItNeeds() throws Exception {
        cyberSpace(240);
        assertEquals(28, tree.search("cyber space", 0, 28, true, true).size());
        assertFalse(api.asked.stream().anyMatch(p -> p.contains("offset=")));
    }

    @Test
    public void voiceFindsAnExactTitleBeyondTheFirstPage() throws Exception {
        pages("cyber%20space%20150", 240); // the search lists 100 songs first; "Cyber Space 150" is on page 2
        LibraryTree.Resolution r = tree.resolveVoice("play cyber space 150", true, true);
        assertEquals("cs150", Json.str(r.tracks.get(r.start), "id"));
        assertTrue(api.asked.contains("/search?q=cyber%20space%20150&limit=100&offset=100"));
    }

    @Test
    public void voiceDoesNotFetchMoreOnceTheExactTitleIsFound() throws Exception {
        pages("cyber%20space%205", 240);
        LibraryTree.Resolution r = tree.resolveVoice("play cyber space 5", true, true);
        assertEquals("cs5", Json.str(r.tracks.get(r.start), "id"));
        assertFalse(api.asked.stream().anyMatch(p -> p.contains("offset=")));
    }

}
