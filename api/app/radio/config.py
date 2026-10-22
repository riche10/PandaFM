"""Every tunable number in Panda Radio, in one place.

Modes are not separate algorithms: each is a weighting profile over the same
engine (candidates -> scores -> weighted random choice). To change how radio
behaves, change numbers here; the engine code has no magic numbers.
"""

from dataclasses import dataclass, field, replace

# ── What counts as what (see signals.py) ──────────────────────────────
EARLY_SKIP_SECONDS = 30.0  # leaving before this is a clear "not now"
EARLY_SKIP_FRACTION = 1 / 3  # ...or before a third of a short song
LATE_SKIP_FRACTION = 0.8  # past 80% a skip is nearly neutral
LATE_SKIP_REMAINING_S = 30.0  # ...as is skipping the last 30 seconds
SKIP_WEIGHT = {"early": 1.0, "mid": 0.5, "late": 0.1}  # how negative each skip is

# A play counts as a real listen (and is scrobbled to Navidrome) after half
# the song or 4 minutes, but never under 30 seconds. Last.fm uses the same rule.
LISTEN_MIN_S = 30.0
LISTEN_FRACTION = 0.5
LISTEN_MAX_S = 240.0

# ── Long-term taste: slow by design ───────────────────────────────────
# Affinities are smoothed towards neutral by this many imaginary plays, so
# a single skip moves an artist or genre by about 1/(1+prior).
AFFINITY_PRIOR = 5.0
FAVORITE_AFFINITY_WEIGHT = 2.0  # a favorite counts like two completions
TRACK_HISTORY_PRIOR = 3.0  # smoothing for one song's completion/skip rates
FAMILIARITY_SATURATION = 20  # play counts beyond this don't add familiarity

# Recently played songs are held back so favorites can't loop.
RECENT_PLAY_PENALTY = [(6, 1.0), (48, 0.6), (24 * 7, 0.25)]  # (within hours, penalty)

# ── Session taste: fast by design ─────────────────────────────────────
SESSION_SKIP_DELTA = {"early": 0.45, "mid": 0.25, "late": 0.03}
SESSION_ARTIST_FACTOR = 1.3  # a skipped artist drops faster than its genres
SESSION_COMPLETE_DELTA = 0.2
SESSION_DECAY = 0.85  # every event pulls session weights towards neutral
SESSION_EXPLORATION_STEP = {"early": 0.3, "mid": 0.15, "late": 0.0}
SESSION_EXPLORATION_SETTLE = 0.5  # a completed song halves exploration
STEER_SKIP_STREAK = 2  # this many skips in a row re-plan the queued radio songs
SESSION_HISTORY = 60  # remembered picks for repetition rules

# ── Candidates ────────────────────────────────────────────────────────
TARGET_BUFFER = 8  # radio songs the app keeps queued ahead
START_BATCH = 10


@dataclass(frozen=True)
class Weights:
    seed_artist: float = 0.8  # same artist as the seed
    seed_genre: float = 1.5  # genre overlap with the seed
    seed_era: float = 0.4  # close in year to the seed
    genre_affinity: float = 1.0  # long-term: genres you finish
    artist_affinity: float = 1.0  # long-term: artists you finish
    favorite: float = 1.0  # starred in Navidrome
    completion: float = 0.8  # you usually finish this song
    familiarity: float = 0.3  # you've played it a lot
    discovery: float = 0.7  # rarely or never played
    session: float = 1.5  # where this session is heading
    continuity: float = 0.3  # like the previous pick
    randomness: float = 0.6  # controlled noise
    recent_track: float = 3.0  # penalty: played recently / already in this session
    recent_artist: float = 1.5  # penalty: same artist as a recent pick
    recent_album: float = 1.0  # penalty: same album as a recent pick
    skip_history: float = 1.2  # penalty: you often skip this song
    session_skip: float = 2.0  # penalty: you skipped this artist in this session


@dataclass(frozen=True)
class ModeProfile:
    id: str
    label: str
    description: str
    weights: Weights
    pool_size: int = 30  # how many top candidates the random choice draws from
    temperature: float = 0.35  # higher = flatter odds within the pool
    base_exploration: float = 0.1
    artist_gap: int = 3  # an artist may not repeat within this many picks
    album_gap: int = 6
    # How many candidates each source contributes before scoring.
    candidates: dict[str, int] = field(
        default_factory=lambda: {
            "seed_artist": 40,
            "seed_genre": 120,
            "adjacent_genre": 60,
            "favorites": 50,
            "top_artists": 50,
            "era": 40,
            "underplayed": 60,
            "random": 40,
        }
    )


PANDA = ModeProfile(
    id="panda",
    label="Panda Radio",
    description="Balanced: your taste, where this session is going, and a few surprises.",
    weights=Weights(),
)

FAMILIAR = ModeProfile(
    id="familiar",
    label="Familiar",
    description="Favorites, songs you finish and artists you know.",
    weights=replace(
        Weights(),
        favorite=2.0,
        completion=1.5,
        familiarity=1.2,
        artist_affinity=1.5,
        genre_affinity=1.3,
        discovery=0.1,
        randomness=0.3,
    ),
    pool_size=25,
    temperature=0.25,
    base_exploration=0.0,
)

DISCOVERY = ModeProfile(
    id="discovery",
    label="Discovery",
    description="Corners of your library you rarely play, still close to your taste.",
    weights=replace(
        Weights(),
        discovery=2.2,
        familiarity=-0.4,
        favorite=0.3,
        completion=0.3,
        seed_genre=1.3,
        genre_affinity=0.8,
        artist_affinity=0.3,
        randomness=0.8,
    ),
    pool_size=40,
    temperature=0.45,
    base_exploration=0.25,
)

STUDY = ModeProfile(
    id="study",
    label="Study",
    description="Steady and uninterrupted: styles you listen to all the way through.",
    weights=replace(
        Weights(),
        seed_genre=2.0,
        continuity=2.0,
        completion=1.5,
        genre_affinity=1.4,
        discovery=0.2,
        randomness=0.2,
        recent_artist=0.6,
        seed_era=0.6,
    ),
    pool_size=20,
    temperature=0.2,
    base_exploration=0.0,
    artist_gap=1,
    album_gap=3,
)

CHAOS = ModeProfile(
    id="chaos",
    label="Chaos",
    description="Anything goes: high novelty, still no repeats.",
    weights=replace(
        Weights(),
        seed_artist=0.0,
        seed_genre=0.2,
        seed_era=0.0,
        genre_affinity=0.2,
        artist_affinity=0.2,
        discovery=1.5,
        session=0.8,
        continuity=-0.5,
        randomness=2.5,
        recent_artist=2.5,
        recent_album=2.0,
    ),
    pool_size=60,
    temperature=1.0,
    base_exploration=0.6,
    artist_gap=5,
    album_gap=10,
)

MODES: dict[str, ModeProfile] = {m.id: m for m in (PANDA, FAMILIAR, DISCOVERY, STUDY, CHAOS)}

# Exploration (raised by repeated skips) loosens the seed and widens the net.
EXPLORATION_SEED_RELIEF = 0.6  # seed_genre/seed_artist shrink by up to 60%
EXPLORATION_EXTRA_RANDOMNESS = 1.0
EXPLORATION_EXTRA_DISCOVERY = 0.8
EXPLORATION_EXTRA_TEMPERATURE = 1.0  # temperature grows by up to 100%
