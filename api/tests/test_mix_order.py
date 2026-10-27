"""Panda Mix playlist order (5.3): optimised, deterministic, stable under edits."""

from collections import Counter

from app.mix.order import insert, mixed_order


def an(bpm, conf=0.8, key=None, lufs=-10.0):
    return {"bpm": bpm, "bpm_confidence": conf, "key_camelot": key, "key_confidence": 0.6 if key else 0, "integrated_lufs": lufs}


def test_similar_tempos_end_up_next_to_each_other():
    ids = ["a128", "b90", "c127", "d91", "e126", "f92"]
    analyses = {"a128": an(128), "b90": an(90), "c127": an(127), "d91": an(91), "e126": an(126), "f92": an(92)}
    order = mixed_order(ids, {}, analyses)
    fast = [order.index(i) for i in ("a128", "c127", "e126")]
    slow = [order.index(i) for i in ("b90", "d91", "f92")]
    assert max(fast) - min(fast) == 2 and max(slow) - min(slow) == 2  # each group is contiguous
    assert order[0] == "a128"  # the playlist's own first song leads
    assert sorted(order) == sorted(ids)  # never adds or drops songs


def test_orders_are_deterministic_and_remix_changes_them():
    ids = [f"t{k}" for k in range(12)]
    analyses = {i: an(90 + 7 * (k % 6)) for k, i in enumerate(ids)}
    assert mixed_order(ids, {}, analyses, 0) == mixed_order(ids, {}, analyses, 0)
    remixes = {tuple(mixed_order(ids, {}, analyses, s)) for s in (11, 22, 33)}
    assert len(remixes) > 1 and all(sorted(r) == sorted(ids) for r in remixes)


def test_inserting_a_song_keeps_everything_else_in_place():
    order = ["a", "b", "c", "d"]
    analyses = {"a": an(100), "b": an(110), "c": an(120), "d": an(130), "x": an(121)}
    out = insert(order, "x", {}, analyses)
    assert [i for i in out if i != "x"] == order and out.index("x") in (2, 3)  # next to its tempo neighbours


def test_album_runs_stay_together():
    meta = {"l1": {"album_id": "live", "track_number": 1}, "l2": {"album_id": "live", "track_number": 2}}
    analyses = {"l1": an(120), "l2": an(95), "x": an(121), "y": an(96)}
    order = mixed_order(["l1", "x", "y", "l2"], meta, analyses)
    assert order.index("l2") == order.index("l1") + 1


def test_duplicate_playlist_entries_are_never_dropped():
    ids = ["a", "b", "a", "c"]
    analyses = {"a": an(120), "b": an(122), "c": an(124)}
    out = mixed_order(ids, {}, analyses)
    assert Counter(out) == Counter(ids)

    inserted = insert(["a", "b"], "a", {}, analyses)
    assert Counter(inserted) == Counter(["a", "a", "b"])
