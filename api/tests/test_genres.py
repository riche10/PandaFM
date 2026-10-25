"""The shared genre model, and how stations and song seeds use it in selection."""

import random
from dataclasses import fields

import pytest

from app.radio.config import MODES
from app.radio.genres import (
    DRIFT_FLOOR, STATION_MIN, affinity, anchor_strength, canonical, families, neighbourhood, normalize, similarity, split,
)
from app.radio.scoring import Candidate, Profile, Recent, Seed, effective_weights, score
from app.radio.selection import choose
from app.radio.session import SessionState


@pytest.mark.parametrize("raw,expected", [
    ("Pop-Punk", "pop punk"), ("pop punk", "pop punk"), ("Alt. Rock", "alternative rock"), ("Alternative", "alternative rock"),
    ("Hip-Hop", "hip hop"), ("RnB", "r&b"), ("R&B", "r&b"), ("J-Rock", "j-rock"), ("JRock", "j-rock"), ("Post-Rock", "post-rock"),
    ("Électronica", "electronic"), ("  Metalcore ", "metalcore"),
])
def test_normalize_folds_spellings_and_aliases(raw, expected):
    assert normalize(raw) == expected


def test_split_and_canonical():
    assert split("Rock; Pop") == ("rock", "pop")
    assert split("Rock/Metal") == ("rock", "metal")
    assert canonical(["Pop-Punk", "pop punk", "Emo"]) == {"pop punk", "emo"}


def test_families_including_keyword_fallback():
    assert "metal" in families("metalcore")
    assert families("symphonic deathcore") == {"metal"}  # not in the taxonomy: keywords decide, metal first
    assert families("japanese city pop") == {"pop"}
    assert families("polka") == frozenset()


def test_similarity_follows_the_genre_graph():
    assert similarity("rock", "alternative rock") == 0.85  # family root and child
    assert similarity("alternative rock", "hard rock") == 0.7  # siblings
    assert similarity("rock", "pop punk") == 0.85
    assert 0.4 <= similarity("rock", "metalcore") < 0.5  # rock-adjacent metal
    assert similarity("rock", "film score") == 0.0
    assert similarity("rock", "classical") == 0.0
    assert similarity("ambient", "film score") == pytest.approx(0.45)
    assert similarity("rock", "metalcore") == similarity("metalcore", "rock")


def test_a_rock_neighbourhood():
    library = ["Rock", "Pop Punk", "Alternative Rock", "Metalcore", "J-Rock", "Film Score", "Classical", "Jazz", "Electronic", "Soundtrack"]
    assert neighbourhood(library, canonical(["Rock"])) == ["Alternative Rock", "J-Rock", "Metalcore", "Pop Punk", "Rock"]
    assert affinity(["Film Score"], canonical(["Rock"])) < STATION_MIN


def test_drift_fades_song_seeds_but_never_stations():
    strengths = [anchor_strength(n, strict=False) for n in range(40)]
    assert strengths[0] == 1.0 and all(a >= b for a, b in zip(strengths, strengths[1:])) and strengths[-1] == DRIFT_FLOOR
    assert all(anchor_strength(n, strict=True) == 1.0 for n in (0, 10, 500))


def cand(i: int, genre: str, plays: int = 0) -> Candidate:
    values = {f.name: None for f in fields(Candidate)}
    values.update(track_id=i, navidrome_id=f"n{i}", title=f"t{i}", artist=f"a{i}", artist_id=f"a{i}", album="x", album_id=f"al{i}",
                  genres=(genre,), year=2010, duration_s=200, cover_art_id=None, liked=False, play_count=plays, completed_count=plays // 2,
                  skip_count=0, early_skip_count=0, late_skip_count=0, hours_since_played=None, sources=frozenset())
    return Candidate(**values)


def mixed() -> list[Candidate]:
    rock = [cand(i, g, plays=40) for i, g in enumerate(["Rock", "Pop Punk", "Alternative Rock", "Metalcore", "J-Rock"] * 3)]
    unrelated = [cand(100 + i, g) for i, g in enumerate(["Film Score", "Classical", "Soundtrack", "Jazz"] * 4)]  # never played: discovery bait
    return rock + unrelated


def test_a_station_never_leaves_its_neighbourhood_even_exploring_in_discovery_mode():
    seed = Seed(name="Rock", genres=frozenset({"Rock"}), anchor=canonical(["Rock"]), strict=True)
    session = SessionState(exploration=1.0)
    for trial in range(5):
        picks = choose(mixed(), count=12, mode=MODES["discovery"], seed=seed, profile=Profile(), session=session,
                       recent=Recent(frozenset(), (), (), frozenset()), rng=random.Random(trial))
        assert picks and all(affinity(p.candidate.genres, seed.anchor) >= STATION_MIN for p in picks)
    w, _ = effective_weights(MODES["discovery"], 1.0, strict=True)
    assert w.seed_genre == MODES["discovery"].weights.seed_genre  # exploration doesn't loosen a station


def test_song_seeds_start_coherent_and_drift_gradually():
    film, rock = cand(200, "Film Score"), cand(201, "Alternative Rock", plays=40)
    anchor = canonical(["Rock"])
    recent = Recent(frozenset(), (), (), frozenset())
    gap = []
    for picks in (0, 6, 40):
        seed = Seed(name="A rock song", genres=frozenset({"Rock"}), anchor=anchor, strength=anchor_strength(picks, strict=False))
        w, _ = effective_weights(MODES["panda"], 0.0)
        s_rock = score(rock, seed, Profile(), SessionState(), recent, MODES["panda"], w, 0.5)[0]
        s_film = score(film, seed, Profile(), SessionState(), recent, MODES["panda"], w, 0.5)[0]
        gap.append(s_rock - s_film)
    assert gap[0] > 2.5  # at first a film score has no chance on rock radio
    assert gap[0] > gap[1] > gap[2] > 0  # the pull fades with each song but rock stays ahead
    first = choose(mixed(), count=10, mode=MODES["panda"], seed=Seed(name="x", genres=frozenset({"Rock"}), anchor=anchor),
                   profile=Profile(), session=SessionState(), recent=recent, rng=random.Random(1))
    assert not [p for p in first if affinity(p.candidate.genres, anchor) < 0.25]
