"""Panda Mix playlist order (5.3): optimised, deterministic, stable under edits."""

from collections import Counter

from app.mix.order import insert, mixed_order


def an(bpm, conf=0.8, key=None, lufs=-10.0):
    return {"bpm": bpm, "bpm_confidence": conf, "key_camelot": key, "key_confidence": 0.7 if key else 0, "integrated_lufs": lufs}


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


# ── 5.4: musically driven order and Remix ──
import random as _random  # noqa: E402

from app.mix.order import components, cost, explain, order_cost, _difference  # noqa: E402


def test_half_and_double_time_are_neighbours():
    analyses = {"a128": an(128), "b90": an(90), "c64": an(64), "d92": an(92)}
    order = mixed_order(["a128", "b90", "c64", "d92"], {}, analyses)
    assert abs(order.index("c64") - order.index("a128")) == 1  # 64 ≈ 128
    assert abs(order.index("b90") - order.index("d92")) == 1


def test_confident_tempo_gaps_matter_more_than_uncertain_ones():
    sure = cost({}, {}, an(90, conf=0.9), an(160, conf=0.9))
    unsure = cost({}, {}, an(90, conf=0.35), an(160, conf=0.35))
    assert sure > unsure
    assert components(an(90, conf=0.2), an(160, conf=0.2))["tempo"] == 0.35  # unknown is neutral, not guessed


def test_confident_compatible_keys_are_preferred():
    analyses = {"x": an(120, key="8A"), "y": an(120, key="3B"), "z": an(120, key="9A"), "w": an(120, key="2B")}
    order = mixed_order(["x", "y", "z", "w"], {}, analyses)
    assert abs(order.index("x") - order.index("z")) == 1 and abs(order.index("y") - order.index("w")) == 1


def _library(n=30, seed=5):
    rng = _random.Random(seed)
    keys = [f"{k}{m}" for k in range(1, 13) for m in "AB"]
    return {f"t{i}": an(rng.choice([88, 120, 124, 128, 140, 174]) * rng.uniform(0.98, 1.02), conf=rng.uniform(0.3, 0.95), key=rng.choice(keys),
                        lufs=rng.uniform(-16, -6)) for i in range(n)}


def test_remix_is_different_but_never_clearly_worse():
    analyses = _library()
    ids = list(analyses)
    current = mixed_order(ids, {}, analyses, 0)
    best = order_cost(current, {}, analyses)
    for seed in range(1, 16):
        remix = mixed_order(ids, {}, analyses, seed, current=current)
        assert sorted(remix) == sorted(ids)
        assert order_cost(remix, {}, analyses) <= best * 1.10 + 0.05 + 1e-6, seed  # musically coherent: never a scramble
        assert remix == mixed_order(ids, {}, analyses, seed, current=current)  # deterministic for its seed
    assert sum(_difference(mixed_order(ids, {}, analyses, s, current=current), current) >= 0.3 for s in range(1, 16)) >= 10  # and actually new


def test_remix_keeps_repeated_songs():
    analyses = _library(8)
    ids = list(analyses) + ["t0", "t3"]
    assert sorted(mixed_order(ids, {}, analyses, 7, current=ids)) == sorted(ids)


def test_why_here_uses_only_confident_facts():
    sure = explain({}, {}, {**an(128, key="8A"), "integrated_lufs": -9.0}, {**an(130, key="9A"), "integrated_lufs": -9.5})
    assert sure == ["128 → 130 BPM, close tempo", "8A → 9A compatible key", "Similar loudness"]
    unsure = explain({}, {}, an(128, conf=0.2), an(130, conf=0.2))
    assert unsure[:2] == ["Tempo uncertain", "Key uncertain"]
    assert explain({}, {}, an(75), an(150))[0] == "75 → 150 BPM (half/double time), close tempo"
