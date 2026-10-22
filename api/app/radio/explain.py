"""Turn a score breakdown into a few plain sentences ("Why this song?")."""

from app.radio.config import ModeProfile
from app.radio.scoring import Candidate, Profile, Seed

MIN_CONTRIBUTION = 0.15  # smaller effects aren't worth mentioning


def reasons(c: Candidate, breakdown: dict[str, float], seed: Seed, profile: Profile, mode: ModeProfile, limit: int = 3) -> list[str]:
    about = f"“{seed.name}”" if seed.name else None
    top_genre = max(c.genres, key=lambda g: profile.genre_affinity.get(g, 0.0), default=None)

    phrases = {
        "seed_artist": f"Same artist as {about}" if about else "By an artist you started with",
        "seed_genre": f"Similar genre to {about}" if about else "Close to the genres you play most",
        "seed_era": "From the same era",
        "genre_affinity": f"You often finish {top_genre}" if top_genre else "Genres you often finish",
        "artist_affinity": f"You often finish {c.artist}",
        "favorite": "One of your favorites",
        "completion": "You usually play this one through",
        "familiarity": "An old regular",
        "discovery": "You haven’t played this yet" if c.play_count == 0 else "Rarely played",
        "session": "Fits where this session is heading",
        "continuity": "Keeps the mood steady",
        "randomness": "A wildcard",
    }
    if mode.id == "discovery":
        phrases["discovery"] = "Discovery mode: " + phrases["discovery"][0].lower() + phrases["discovery"][1:]

    positive = sorted(
        ((name, value) for name, value in breakdown.items() if value >= MIN_CONTRIBUTION and name in phrases),
        key=lambda item: -item[1],
    )
    result: list[str] = []
    for name, _ in positive:
        phrase = phrases[name]
        if phrase not in result:
            result.append(phrase)
        if len(result) == limit:
            break
    return result or ["A fresh pick from your library"]
