"""Library explorer logic: genre index, chips, artist genres, related albums, decades, genre search."""

from collections import Counter

from app.explore import (
    AlbumFacts, decade_of, display_name, dominant_genres, genre_closeness, genre_index, genre_tags, related_albums, search_genres,
)
from app.radio.genres import canonical


def test_spellings_of_one_genre_merge_with_a_readable_name():
    rows = [(1, "al1", "ar1", "c1", "Pop-Punk"), (2, "al1", "ar1", "c1", "pop punk"), (3, "al2", "ar2", "c2", "Pop Punk"),
            (4, "al2", "ar2", "c2", "Pop Punk"), (5, "al3", "ar3", "c3", "Alternative Rock"), (6, "al4", "ar3", "c4", "Rock; Pop")]
    idx = genre_index(rows)
    assert set(idx) == {"pop punk", "alternative rock", "rock", "pop"}  # related genres stay separate
    pp = idx["pop punk"]
    assert (pp.name, pp.songs, pp.albums, pp.artists) == ("Pop Punk", 4, 2, 2)
    assert pp.raws == {"Pop-Punk", "pop punk", "Pop Punk"} and pp.covers == ["c1", "c2"]
    assert idx["rock"].name == "Rock"
    assert display_name(Counter({"pop punk": 2, "Pop Punk": 2})) == "Pop Punk"


def test_album_genre_chips_dedupe_and_ignore_empties():
    assert genre_tags(["Pop-Punk", "pop punk", "", "  ", "Emo", "Alternative Rock"]) == [
        ("pop punk", "Pop-Punk"), ("emo", "Emo"), ("alternative rock", "Alternative Rock")]
    assert genre_tags([]) == [] and genre_tags(None) == []
    assert len(genre_tags([f"Tag {i}" for i in range(30)])) == 8  # excessive tagging is capped
    assert genre_tags(["Pop Punk"], {"pop punk": "Pop Punk"}) == [("pop punk", "Pop Punk")]


def test_artist_dominant_genres_leave_one_offs_out():
    tracks = [["Pop Punk", "Emo"]] * 5 + [["Pop Punk"]] * 2 + [["Alternative Rock"]] * 3 + [["Film Score"]]
    assert dominant_genres(tracks) == ["pop punk", "emo", "alternative rock"]
    assert dominant_genres([["Jazz"]]) == ["jazz"]  # a single song still has a genre
    assert dominant_genres([[], []]) == []


def album(i, artist, year, *genres):
    return AlbumFacts(f"a{i}", f"Album {i}", artist, year, canonical(genres))


def test_related_albums_rank_by_genre_then_era_and_skip_same_artist_and_unrelated():
    target = album(0, "magnolia", 2015, "Pop Punk", "Emo")
    candidates = [album(1, "paramore", 2016, "Pop Punk", "Alternative Rock"), album(2, "foo", 2010, "Rock"),
                  album(3, "zimmer", 2015, "Film Score"), album(4, "magnolia", 2017, "Pop Punk"), album(5, "mcr", 2021, "Emo"),
                  album(6, "nogenre", 2015)]
    ranked = related_albums(target, candidates)
    ids = [a.id for a, _, _ in ranked]
    assert ids == ["a5", "a1", "a2"]  # same artist (a4), film score (a3) and no-genre (a6) are left out
    assert ranked[1][2] == "Pop Punk · Alternative Rock"
    assert related_albums(target, candidates) == ranked  # deterministic
    assert genre_closeness(canonical(["Rock"]), canonical(["Film Score"])) == 0.0
    assert related_albums(album(9, "x", 2000), candidates) == []  # a zero-genre album has no shelf


def test_decades_skip_missing_years():
    assert [decade_of(y) for y in (1999, 2000, 2026, None, 0)] == [1990, 2000, 2020, None, None]


def test_genre_search_ranks_exact_above_word_above_family():
    idx = genre_index([(1, "a", "x", None, "Pop Punk"), (2, "b", "y", None, "Punk"), (3, "c", "z", None, "Alternative Rock"),
                       (4, "d", "w", None, "Rock"), (5, "e", "v", None, "Film Score")])
    assert [g.key for g in search_genres("pop punk", idx)] == ["pop punk"]
    assert [g.key for g in search_genres("Pop-Punk", idx)] == ["pop punk"]
    assert [g.key for g in search_genres("rock", idx, limit=5)] == ["rock", "alternative rock", "pop punk"]
    assert search_genres("x", idx) == [] and search_genres("polka", idx) == []
