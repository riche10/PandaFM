"""Panda Radio's engine without a database: signals, session steering,
scoring, weighted selection, modes, and the recommendation traps.

A synthetic library and seeded random numbers keep every test deterministic.
"""

import random
from collections import Counter

from app.radio import config, session as S
from app.radio.config import MODES
from app.radio.explain import reasons
from app.radio.scoring import Candidate, Profile, Recent, Seed
from app.radio.selection import Pick, choose
from app.radio.signals import classify_skip, counts_as_listen, smoothed_affinity

GENRES = {
    "synthwave": ["Neon", "Chrome", "Laser"],
    "electronic": ["Pulse", "Circuit"],
    "ambient": ["Mist", "Fog"],
    "indie": ["Static", "Lantern"],
    "jazz": ["Blue Note Cat"],
}


def library(history=None, **overrides_by_artist) -> list[Candidate]:
    """10 artists x 2 albums x 5 songs. Years cluster by genre.

    `history(artist, album)` may return listening stats per album.
    """
    tracks: list[Candidate] = []
    track_id = 0
    for g_index, (genre, artists) in enumerate(GENRES.items()):
        for artist in artists:
            for album in range(2):
                for n in range(5):
                    track_id += 1
                    extra = {**(history(artist, album) if history else {}), **overrides_by_artist.get(artist, {})}
                    tracks.append(
                        Candidate(
                            track_id=track_id,
                            navidrome_id=f"nd{track_id}",
                            title=f"{artist} {album}-{n}",
                            artist=artist,
                            artist_id=f"ar-{artist}",
                            album=f"{artist} album {album}",
                            album_id=f"al-{artist}-{album}",
                            genres=(genre,) if genre != "synthwave" else ("synthwave", "electronic") if n % 2 else ("synthwave",),
                            year=1985 + g_index * 8 + album,
                            duration_s=200,
                            cover_art_id=None,
                            **extra,
                        )
                    )
    return tracks


SYNTH_SEED = Seed(name="Night Run", artist_id="ar-Neon", genres=frozenset({"synthwave"}), year=1986)


def run(mode_id: str, tracks: list[Candidate], *, seed: Seed = SYNTH_SEED, batches: int = 3, size: int = 10, rng_seed: int = 1, profile: Profile | None = None, skip_if=None) -> tuple[list[Pick], S.SessionState]:
    """Simulate a radio session: pick a batch, 'listen' (skip or complete), repeat."""
    mode = MODES[mode_id]
    rng = random.Random(rng_seed)
    state = S.SessionState(exploration=mode.base_exploration)
    picks: list[Pick] = []
    for _ in range(batches):
        recent = Recent(
            frozenset(state.recent_track_ids),
            tuple(state.recent_artist_ids),
            tuple(state.recent_album_ids),
            frozenset(state.last_genres),
        )
        batch = choose(tracks, count=size, mode=mode, seed=seed, profile=profile or Profile(), session=state, recent=recent, rng=rng)
        for pick in batch:
            c = pick.candidate
            state = S.on_pick(state, c.track_id, c.artist_id, c.album_id, list(c.genres))
            if skip_if and skip_if(c):
                state = S.on_skip(state, list(c.genres), c.artist_id, "early")
            else:
                state = S.on_complete(state, list(c.genres), c.artist_id, mode.base_exploration)
        picks.extend(batch)
    return picks, state


def share(picks: list[Pick], test) -> float:
    return sum(1 for p in picks if test(p.candidate)) / len(picks)


def is_synth(c: Candidate) -> bool:
    return "synthwave" in c.genres


# ── Signals ───────────────────────────────────────────────────────────


def test_skip_classification_early_mid_late():
    assert classify_skip(10, 200) == "early"
    assert classify_skip(100, 200) == "mid"
    assert classify_skip(185, 200) == "late"
    assert classify_skip(8, 30) == "early"  # short song: a third of it
    assert classify_skip(15, 30) == "late"  # ...and the last 30 s are near-neutral
    assert classify_skip(45, None) == "mid"


def test_a_few_seconds_is_not_a_listen():
    assert not counts_as_listen(2, 200)
    assert not counts_as_listen(25, 40)  # never under 30 s
    assert counts_as_listen(120, 200)  # half
    assert counts_as_listen(250, 900)  # or 4 minutes


def test_one_skip_barely_moves_long_term_taste():
    one_skip = smoothed_affinity(completed=0, weighted_skips=1, plays=1)
    assert -0.2 < one_skip < 0
    many = smoothed_affinity(completed=0, weighted_skips=10, plays=10)
    assert many < -0.6
    loved = smoothed_affinity(completed=8, weighted_skips=0, plays=8, liked=1)
    assert loved > 0.6


# ── Session state ─────────────────────────────────────────────────────


def test_repeated_skips_steer_the_session_but_late_skips_do_not():
    state = S.SessionState()
    state = S.on_skip(state, ["synthwave"], "ar-Neon", "early")
    assert state.steer_version == 0 and state.skip_streak == 1
    state = S.on_skip(state, ["synthwave"], "ar-Chrome", "early")
    assert state.steer_version == 1
    assert state.genre_weights["synthwave"] < -0.6
    assert state.exploration > 0.5
    late = S.on_skip(S.SessionState(), ["ambient"], "ar-Mist", "late")
    assert late.skip_streak == 0 and late.steer_version == 0


def test_a_completed_song_stabilises_and_old_signals_fade():
    state = S.on_skip(S.on_skip(S.SessionState(), ["indie"], None, "early"), ["indie"], None, "early")
    calmer = S.on_complete(state, ["jazz"], "ar-Blue", base_exploration=0.1)
    assert calmer.skip_streak == 0
    assert calmer.exploration < state.exploration
    faded = calmer
    for _ in range(12):
        faded = S.on_complete(faded, ["jazz"], None)
    assert abs(faded.genre_weights.get("indie", 0.0)) < 0.15  # drifted back towards neutral


def test_state_survives_json_round_trip():
    state = S.on_pick(S.on_skip(S.SessionState(), ["indie"], "ar-Static", "mid"), 7, "ar-Static", "al-1", ["indie"])
    assert S.SessionState.from_json(state.to_json()) == state


# ── Selection basics ──────────────────────────────────────────────────


def test_same_random_seed_same_radio():
    a, _ = run("panda", library(), rng_seed=42)
    b, _ = run("panda", library(), rng_seed=42)
    assert [p.candidate.track_id for p in a] == [p.candidate.track_id for p in b]


def test_no_song_repeats_and_artists_are_spaced():
    picks, _ = run("panda", library(), batches=4)
    ids = [p.candidate.track_id for p in picks]
    assert len(ids) == len(set(ids))
    artists = [p.candidate.artist_id for p in picks]
    gap = MODES["panda"].artist_gap
    for i in range(len(artists)):
        assert artists[i] not in artists[max(0, i - gap) : i]


def test_radio_is_related_to_the_seed_not_random():
    picks, _ = run("panda", library(), batches=1)
    library_rate = share([Pick(c, 0, {}) for c in library()], is_synth)
    assert share(picks, is_synth) >= library_rate * 1.8


def test_breakdown_adds_up_and_names_its_terms():
    picks, _ = run("panda", library(), batches=1)
    for pick in picks:
        assert abs(sum(pick.breakdown.values()) - pick.score) < 1e-3
        assert set(pick.breakdown) <= set(config.Weights.__dataclass_fields__)


# ── Steering and stability ────────────────────────────────────────────


def test_skipping_one_direction_turns_the_session_quickly():
    tracks = library()
    first, _ = run("panda", tracks, batches=1)
    steered, state = run("panda", tracks, batches=3, size=5, skip_if=is_synth)
    later = steered[10:]  # after the first ten picks, most of them skipped
    assert share(first, is_synth) >= 0.6
    assert share(later, is_synth) <= 0.25
    assert state.steer_version >= 2


def test_one_skip_does_not_overreact():
    tracks = library()
    skipped_once = {tracks[0].track_id}
    picks, _ = run("panda", tracks, batches=2, size=5, skip_if=lambda c: c.track_id in skipped_once)
    assert share(picks[5:], is_synth) >= 0.4


# ── The recommendation traps ──────────────────────────────────────────


def test_favorites_do_not_loop():
    # Ten synthwave favorites, all played within the last hour.
    favs = {"Neon": {"liked": True, "play_count": 30, "completed_count": 30, "hours_since_played": 1.0}}
    picks, _ = run("panda", library(**favs), batches=3)
    assert share(picks, lambda c: c.liked) <= 0.2
    ids = [p.candidate.track_id for p in picks]
    assert len(ids) == len(set(ids))


def test_one_loved_artist_cannot_take_over():
    profile = Profile(artist_affinity={"ar-Neon": 1.0}, genre_affinity={"synthwave": 1.0})
    loved = {"Neon": {"liked": True, "completed_count": 50, "play_count": 50}}
    picks, _ = run("familiar", library(**loved), batches=3, profile=profile)
    top_artist, count = Counter(p.candidate.artist_id for p in picks).most_common(1)[0]
    assert count / len(picks) <= 0.27, (top_artist, count)


def test_panda_and_discovery_keep_surfacing_unplayed_music():
    # Every artist's first album is well played; their second album never was.
    played_first_album = lambda artist, album: {"play_count": 10, "completed_count": 8} if album == 0 else {}  # noqa: E731
    unplayed = lambda c: c.play_count == 0  # noqa: E731
    panda, _ = run("panda", library(played_first_album), batches=2)
    discovery, _ = run("discovery", library(played_first_album), batches=2)
    assert share(panda, unplayed) >= 0.3  # no echo chamber in the default mode
    assert share(discovery, unplayed) >= 0.6
    assert share(discovery, unplayed) > share(panda, unplayed)


def test_discovery_is_still_related_not_random():
    picks, _ = run("discovery", library(), batches=1)
    library_rate = share([Pick(c, 0, {}) for c in library()], is_synth)
    assert share(picks, is_synth) > library_rate


# ── Modes are weightings of one engine, with visible differences ──────


def _history() -> dict:
    return {
        "Neon": {"liked": True, "play_count": 25, "completed_count": 24},
        "Chrome": {"play_count": 12, "completed_count": 10},
        "Pulse": {"play_count": 8, "completed_count": 7},
    }


def test_familiar_versus_discovery():
    familiar, _ = run("familiar", library(**_history()), batches=2)
    discovery, _ = run("discovery", library(**_history()), batches=2)
    mean_plays = lambda picks: sum(p.candidate.play_count for p in picks) / len(picks)  # noqa: E731
    assert mean_plays(familiar) > mean_plays(discovery) * 2
    assert share(familiar, lambda c: c.liked) > share(discovery, lambda c: c.liked)


def test_study_is_steadier_than_chaos():
    def continuity(picks: list[Pick]) -> float:
        pairs = list(zip(picks, picks[1:]))
        return sum(1 for a, b in pairs if set(a.candidate.genres) & set(b.candidate.genres)) / len(pairs)

    study, _ = run("study", library(), batches=2)
    chaos, _ = run("chaos", library(), batches=2)
    assert continuity(study) > continuity(chaos) + 0.25
    genres = lambda picks: len({g for p in picks for g in p.candidate.genres})  # noqa: E731
    assert genres(chaos) > genres(study)


def test_cold_start_works_with_no_history_or_seed():
    picks, _ = run("panda", library(), seed=Seed(), batches=1)
    assert len(picks) == 10
    assert len({p.candidate.track_id for p in picks}) == 10


# ── Explanations ──────────────────────────────────────────────────────


def test_explanations_are_plain_sentences():
    favs = {"Neon": {"liked": True}}
    picks, _ = run("familiar", library(**favs), batches=1)
    fav_pick = next(p for p in picks if p.candidate.liked)
    text = reasons(fav_pick.candidate, fav_pick.breakdown, SYNTH_SEED, Profile(), MODES["familiar"])
    assert "One of your favorites" in text
    assert all(isinstance(t, str) and "{" not in t for t in text)

    discovery, _ = run("discovery", library(), batches=1)
    found = [reasons(p.candidate, p.breakdown, SYNTH_SEED, Profile(), MODES["discovery"]) for p in discovery]
    assert any(any(r.startswith("Discovery mode:") for r in rs) for rs in found)
