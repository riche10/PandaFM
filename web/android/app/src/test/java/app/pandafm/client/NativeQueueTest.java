package app.pandafm.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.Test;

/** The native queue behaves exactly like the web queue (web/src/player/queue.ts). */
public class NativeQueueTest {
    static int counter = 0;

    static Map<String, Object> track(String id) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("id", id);
        t.put("title", "Song " + id);
        t.put("artist", "Artist");
        t.put("duration_seconds", 200L);
        return t;
    }

    static List<Map<String, Object>> tracks(String... ids) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String id : ids) out.add(track(id));
        return out;
    }

    static NativeQueue queue() {
        return new NativeQueue(() -> "u" + (++counter), new Random(7));
    }

    static List<String> ids(NativeQueue q) {
        List<String> out = new ArrayList<>();
        for (QueueItem i : q.items) out.add(i.trackId());
        return out;
    }

    static Map<String, Object> source(String kind, String name) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("kind", kind);
        s.put("name", name);
        return s;
    }

    @Test
    public void loadPlayNextAddToQueueRemoveClear() {
        NativeQueue q = queue();
        q.load(tracks("a", "b", "c"), 0, source("album", "Album"), false);
        q.playNext(tracks("x"));
        q.addToQueue(tracks("y"));
        q.playNext(tracks("z")); // straight after the current song
        assertEquals(Arrays.asList("a", "z", "x", "y", "b", "c"), ids(q));
        q.addToQueue(tracks("w")); // after every hand-picked song, before the album
        assertEquals(Arrays.asList("a", "z", "x", "y", "w", "b", "c"), ids(q));
        assertFalse(q.remove(q.items.get(0).uid)); // never the one playing
        assertTrue(q.remove(q.items.get(2).uid));
        q.clearUpcoming("manual");
        assertEquals(Arrays.asList("a", "b", "c"), ids(q));
        q.clearUpcoming("all");
        assertEquals(Arrays.asList("a"), ids(q));
    }

    @Test
    public void moveOnlyAmongUpcomingAndAdoptsTheNeighboursPlace() {
        NativeQueue q = queue();
        q.load(tracks("a", "b", "c"), 0, null, false);
        q.playNext(tracks("m"));
        String c = q.items.get(3).uid;
        assertTrue(q.move(c, -1));
        assertTrue(q.move(c, -1)); // now right after the current song, hand-picked
        assertEquals(Arrays.asList("a", "c", "m", "b"), ids(q));
        assertEquals("manual", q.items.get(1).origin);
        assertFalse(q.move(q.items.get(1).uid, -1)); // can't pass the current song
    }

    @Test
    public void nextPreviousAndRepeat() {
        NativeQueue q = queue();
        q.load(tracks("a", "b"), 1, null, false);
        assertNull(q.nextIndex());
        q.cycleRepeat();
        assertEquals("all", q.repeat);
        assertEquals(Integer.valueOf(0), q.nextIndex());
        q.index = 0;
        assertEquals(Integer.valueOf(1), q.previousIndex()); // wraps with repeat all
        q.cycleRepeat();
        assertEquals("one", q.repeat);
        q.cycleRepeat();
        assertEquals("off", q.repeat);
        assertNull(q.previousIndex());
    }

    @Test
    public void shuffleKeepsCurrentAndHandPickedThenRestoresOrder() {
        NativeQueue q = queue();
        q.load(tracks("a", "b", "c", "d", "e"), 2, null, false);
        q.playNext(tracks("m"));
        q.setShuffle(true);
        assertEquals("c", q.current().trackId());
        assertEquals(0, q.index);
        assertEquals("m", q.items.get(1).trackId());
        assertEquals(6, q.items.size());
        q.setShuffle(false);
        assertEquals(Arrays.asList("a", "b", "c", "m", "d", "e"), ids(q));
        assertEquals(2, q.index);
        q.source = source("radio", "Rock Radio");
        q.setShuffle(true);
        assertFalse(q.shuffle); // radio never shuffles
    }

    @Test
    public void radioPicksRefillReplaceAndEnd() {
        NativeQueue q = queue();
        List<QueueItem> picks = q.wrapRadio(Arrays.asList(pick("r1", 1), pick("r2", 2), pick("r3", 3)), "S");
        Map<String, Object> src = source("radio", "Rock Radio");
        q.startRadio(picks, src, track("seed"), false);
        assertEquals(Arrays.asList("seed", "r1", "r2", "r3"), ids(q));
        assertEquals(Arrays.asList(1L, 2L, 3L), q.radioUpcomingSelections("S"));
        q.addRadio(Arrays.asList(3L), q.wrapRadio(Arrays.asList(pick("r4", 4)), "S"));
        assertEquals(Arrays.asList("seed", "r1", "r2", "r4"), ids(q));
        q.endRadio();
        assertEquals("tracks", q.source.get("kind"));
        assertEquals(4, q.items.size()); // the songs stay
    }

    static Map<String, Object> pick(String id, long sel) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("selection_id", sel);
        p.put("track", track(id));
        return p;
    }

    @Test
    public void snapshotRoundTripsAndRejectsGarbage() {
        NativeQueue q = queue();
        q.load(tracks("a", "b", "c"), 1, source("playlist", "Mix"), false);
        q.cycleRepeat();
        String json = Json.write(q.snapshot(NativeQueue.MAX_SAVED));
        assertFalse(json.contains("Bearer") || json.contains("token") || json.contains("/stream")); // identities, never URLs or secrets
        NativeQueue r = queue();
        assertTrue(r.restore(Json.map(Json.parse(json))));
        assertEquals(Arrays.asList("a", "b", "c"), ids(r));
        assertEquals(1, r.index);
        assertEquals("all", r.repeat);
        assertEquals("Mix", r.source.get("name"));
        for (String bad : new String[] {"{\"v\":2,\"items\":[]}", "{\"v\":1,\"items\":[],\"index\":0}", "{\"v\":1,\"items\":[{\"uid\":\"x\"}],\"index\":0}",
                "{\"v\":1,\"items\":[{\"uid\":\"x\",\"track\":{\"id\":\"a\"}}],\"index\":5}"}) {
            NativeQueue x = queue();
            assertFalse(bad, x.restore(Json.map(Json.tryParse(bad))));
            assertEquals(-1, x.index);
        }
        assertNull(Json.tryParse("{not json"));
    }

    @Test
    public void hugeQueuesAreSavedAroundTheCurrentSong() {
        NativeQueue q = queue();
        String[] many = new String[3000];
        for (int k = 0; k < many.length; k++) many[k] = "t" + k;
        q.load(tracks(many), 2500, null, false);
        Map<String, Object> snap = q.snapshot(NativeQueue.MAX_SAVED);
        assertEquals(NativeQueue.MAX_SAVED, Json.list(snap.get("items")).size());
        NativeQueue r = queue();
        assertTrue(r.restore(Json.map(Json.parse(Json.write(snap)))));
        assertEquals("t2500", r.current().trackId());
    }
}
