package app.pandafm.client;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.function.Supplier;

/**
 * The Android playback queue (5.0.1): the one authority for what plays next on
 * Android, owned by the playback service so it works without the WebView.
 * A faithful port of the web queue (web/src/player/queue.ts): Play next goes
 * right after the current song, Add to queue after the hand-picked songs,
 * shuffle keeps the current and hand-picked songs, radio picks never shuffle.
 * Pure Java; not thread-safe on purpose: QueueController serialises access.
 */
final class NativeQueue {
    static final int VERSION = 1;
    static final int MAX_SAVED = 500;

    List<QueueItem> items = new ArrayList<>();
    int index = -1;
    Map<String, Object> source; // {kind, name, id?, radio?: {sessionId, mode, modeLabel, seedName, presetId?, autoplay?, stationId?}}
    boolean shuffle;
    List<QueueItem> ordered; // while shuffled: the collection's own order
    String repeat = "off"; // off | all | one

    private final Supplier<String> uids;
    private final Random random;

    NativeQueue(Supplier<String> uids, Random random) {
        this.uids = uids;
        this.random = random;
    }

    QueueItem current() {
        return index >= 0 && index < items.size() ? items.get(index) : null;
    }

    List<QueueItem> upcoming() {
        return index < 0 ? new ArrayList<>(items) : new ArrayList<>(items.subList(Math.min(index + 1, items.size()), items.size()));
    }

    List<QueueItem> manualUpcoming() {
        List<QueueItem> out = new ArrayList<>();
        for (QueueItem item : upcoming()) {
            if (!"manual".equals(item.origin)) break;
            out.add(item);
        }
        return out;
    }

    String radioSessionId() {
        if (source == null || !"radio".equals(source.get("kind"))) return null;
        return Json.str(Json.map(source.get("radio")), "sessionId");
    }

    List<QueueItem> wrap(List<Map<String, Object>> tracks, String origin) {
        List<QueueItem> out = new ArrayList<>();
        for (Map<String, Object> t : tracks) if (Json.str(t, "id") != null) out.add(new QueueItem(uids.get(), t, origin, null, null));
        return out;
    }

    /** Start a collection; with shuffle the chosen (or a random) song plays first. */
    void load(List<Map<String, Object>> tracks, Integer startIndex, Map<String, Object> source, boolean shuffleOn) {
        List<QueueItem> wrapped = wrap(tracks, "context");
        if (wrapped.isEmpty()) return;
        int start = startIndex != null ? Math.min(Math.max(0, startIndex), wrapped.size() - 1) : shuffleOn ? random.nextInt(wrapped.size()) : 0;
        items = wrapped;
        index = start;
        this.source = source;
        shuffle = false;
        ordered = null;
        if (shuffleOn) setShuffle(true);
    }

    void playNext(List<Map<String, Object>> tracks) {
        List<QueueItem> add = wrap(tracks, "manual");
        if (add.isEmpty()) return;
        if (index < 0) { items = add; index = 0; return; }
        items.addAll(index + 1, add);
    }

    void addToQueue(List<Map<String, Object>> tracks) {
        List<QueueItem> add = wrap(tracks, "manual");
        if (add.isEmpty()) return;
        if (index < 0) { items = add; index = 0; return; }
        items.addAll(index + 1 + manualUpcoming().size(), add);
    }

    boolean remove(String uid) {
        int at = indexOf(uid);
        if (at < 0 || at == index) return false;
        items.remove(at);
        if (at < index) index--;
        if (ordered != null) ordered.removeIf(i -> i.uid.equals(uid));
        return true;
    }

    void clearUpcoming(String which) {
        Set<String> drop = new HashSet<>();
        for (QueueItem i : "manual".equals(which) ? manualUpcoming() : upcoming()) drop.add(i.uid);
        items.removeIf(i -> drop.contains(i.uid));
        if (ordered != null) ordered.removeIf(i -> drop.contains(i.uid));
    }

    boolean jumpTo(String uid) {
        int at = indexOf(uid);
        if (at < 0) return false;
        index = at;
        return true;
    }

    /** Move an upcoming item one place, among upcoming items only (adopting its neighbour's place). */
    boolean move(String uid, int direction) {
        int at = indexOf(uid);
        int to = at + direction;
        if (at <= index || to <= index || to >= items.size()) return false;
        Collections.swap(items, at, to);
        items.set(to, items.get(to).withOrigin(items.get(at).origin));
        return true;
    }

    void setShuffle(boolean on) {
        if (source != null && "radio".equals(source.get("kind"))) return; // radio chooses its own order
        if (on == shuffle || index < 0) { shuffle = on && index >= 0; return; }
        QueueItem now = items.get(index);
        List<QueueItem> manual = manualUpcoming();
        Set<String> manualIds = new HashSet<>();
        for (QueueItem m : manual) manualIds.add(m.uid);
        if (on) {
            List<QueueItem> context = new ArrayList<>();
            for (QueueItem i : items) if ("context".equals(i.origin)) context.add(i);
            List<QueueItem> rest = new ArrayList<>();
            for (QueueItem i : context) if (!i.uid.equals(now.uid) && !manualIds.contains(i.uid)) rest.add(i);
            Collections.shuffle(rest, random);
            List<QueueItem> next = new ArrayList<>();
            next.add(now);
            next.addAll(manual);
            next.addAll(rest);
            items = next;
            index = 0;
            shuffle = true;
            ordered = context;
            return;
        }
        List<QueueItem> keep = new ArrayList<>();
        for (QueueItem i : ordered == null ? new ArrayList<QueueItem>() : ordered) if (!manualIds.contains(i.uid)) keep.add(i);
        int at = -1;
        for (int k = 0; k < keep.size(); k++) if (keep.get(k).uid.equals(now.uid)) at = k;
        List<QueueItem> next = new ArrayList<>();
        if (at < 0) { // the current song was hand-picked: the collection continues from the top
            next.add(now);
            next.addAll(manual);
            next.addAll(keep);
            index = 0;
        } else {
            next.addAll(keep.subList(0, at));
            next.add(now);
            next.addAll(manual);
            next.addAll(keep.subList(at + 1, keep.size()));
            index = at;
        }
        items = next;
        shuffle = false;
        ordered = null;
    }

    void cycleRepeat() {
        repeat = "off".equals(repeat) ? "all" : "all".equals(repeat) ? "one" : "off";
    }

    Integer nextIndex() {
        if (index < 0) return null;
        if (index + 1 < items.size()) return index + 1;
        return "all".equals(repeat) && !items.isEmpty() ? 0 : null;
    }

    Integer previousIndex() {
        if (index > 0) return index - 1;
        return "all".equals(repeat) && items.size() > 1 ? items.size() - 1 : null;
    }

    // ── Panda Radio ──
    List<QueueItem> wrapRadio(List<Map<String, Object>> picks, String sessionId) {
        List<QueueItem> out = new ArrayList<>();
        for (Map<String, Object> p : picks) {
            Map<String, Object> track = Json.map(p.get("track"));
            Long sel = Json.num(p, "selection_id");
            if (track != null && Json.str(track, "id") != null) out.add(new QueueItem(uids.get(), track, "context", sessionId, sel));
        }
        return out;
    }

    void startRadio(List<QueueItem> picks, Map<String, Object> radioSource, Map<String, Object> seedTrack, boolean keepCurrent) {
        List<QueueItem> next = new ArrayList<>();
        if (keepCurrent && index >= 0) {
            next.add(items.get(index));
            next.addAll(manualUpcoming());
        } else if (seedTrack != null) {
            List<Map<String, Object>> seed = new ArrayList<>();
            seed.add(seedTrack);
            next.addAll(wrap(seed, "context"));
        }
        next.addAll(picks);
        items = next;
        index = next.isEmpty() ? -1 : 0;
        source = radioSource;
        shuffle = false;
        ordered = null;
    }

    void addRadio(List<Long> replaced, List<QueueItem> picks) {
        Set<Long> drop = new HashSet<>(replaced);
        List<QueueItem> keep = new ArrayList<>();
        for (int k = 0; k < items.size(); k++) {
            QueueItem i = items.get(k);
            if (k <= index || !i.isRadio() || !drop.contains(i.radioSelection)) keep.add(i);
        }
        keep.addAll(picks);
        items = keep;
    }

    /** Autoplay: keep everything and continue with radio picks. */
    void appendRadio(List<QueueItem> picks, Map<String, Object> radioSource) {
        source = radioSource;
        shuffle = false;
        ordered = null;
        items.addAll(picks);
    }

    List<Long> radioUpcomingSelections(String sessionId) {
        List<Long> out = new ArrayList<>();
        for (QueueItem i : upcoming()) if (sessionId.equals(i.radioSession)) out.add(i.radioSelection);
        return out;
    }

    /** Stop radio: the queue stays, it just stops growing. */
    void endRadio() {
        if (source == null || !"radio".equals(source.get("kind"))) return;
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("kind", "tracks");
        s.put("name", source.get("name"));
        source = s;
    }

    private int indexOf(String uid) {
        for (int k = 0; k < items.size(); k++) if (items.get(k).uid.equals(uid)) return k;
        return -1;
    }

    // ── snapshot (for the phone UI) and persistence (versioned, capped, no secrets) ──
    Map<String, Object> snapshot(int cap) {
        int from = 0, to = items.size();
        if (cap > 0 && items.size() > cap) {
            from = Math.max(0, Math.min(index - 100, items.size() - cap));
            to = from + cap;
        }
        List<Object> list = new ArrayList<>();
        for (QueueItem i : items.subList(from, to)) list.add(i.toMap());
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", (long) VERSION);
        m.put("items", list);
        m.put("index", (long) (index < 0 ? -1 : index - from));
        m.put("source", source);
        m.put("shuffle", shuffle);
        m.put("repeat", repeat);
        if (ordered != null && cap <= 0) {
            List<Object> o = new ArrayList<>();
            for (QueueItem i : ordered) o.add(i.uid);
            m.put("ordered", o);
        }
        return m;
    }

    /** Restore a saved queue; false (and nothing changed) for anything malformed. */
    boolean restore(Map<String, Object> m) {
        if (m == null || !Long.valueOf(VERSION).equals(Json.num(m, "v"))) return false;
        List<QueueItem> loaded = new ArrayList<>();
        for (Map<String, Object> raw : Json.maps(m.get("items"))) {
            QueueItem i = QueueItem.fromMap(raw);
            if (i == null) return false;
            loaded.add(i);
        }
        Long at = Json.num(m, "index");
        if (loaded.isEmpty() || at == null || at < 0 || at >= loaded.size()) return false;
        String rep = Json.str(m, "repeat");
        items = loaded;
        index = at.intValue();
        source = Json.map(m.get("source"));
        shuffle = Json.bool(m, "shuffle");
        ordered = null; // a restored shuffle keeps its order; turning shuffle off continues from the current song
        repeat = "all".equals(rep) || "one".equals(rep) ? rep : "off";
        return true;
    }
}
