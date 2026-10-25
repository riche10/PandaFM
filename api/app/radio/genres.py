"""PandaFM's one genre model for recommendations.

Raw tags are messy ("Pop-Punk", "pop punk", "Alt. Rock", "Rock; Pop"), so
everything the radio does with genres goes through here:

- normalize(): one canonical name per genre (aliases folded together);
- families(): which broad families a genre belongs to (rock, metal, ...);
- similarity(): 0..1 between two genres (same 1, family root/child 0.85,
  siblings 0.7, neighbouring families less, unrelated 0);
- affinity(): how well a song's genres fit a set of anchor genres.

Song-seeded radio and saved stations both use it; there is no other genre
logic. All thresholds live here.
"""

import re
import unicodedata
from functools import lru_cache

# Canonical spellings for common variants (after basic cleaning).
ALIASES = {
    "alt rock": "alternative rock", "alternative": "alternative rock", "alt. rock": "alternative rock", "altrock": "alternative rock",
    "poppunk": "pop punk", "punk pop": "pop punk", "punk rock": "punk", "hip hop": "hip hop", "hiphop": "hip hop", "rap": "hip hop",
    "rnb": "r&b", "r and b": "r&b", "r n b": "r&b", "rhythm and blues": "r&b", "jrock": "j-rock", "j rock": "j-rock", "japanese rock": "j-rock",
    "jpop": "j-pop", "j pop": "j-pop", "kpop": "k-pop", "k pop": "k-pop", "electronica": "electronic", "electro": "electronic",
    "edm": "electronic", "dnb": "drum and bass", "drum n bass": "drum and bass", "lofi": "lo-fi", "lo fi": "lo-fi", "lo-fi hip hop": "lo-fi",
    "ost": "soundtrack", "original soundtrack": "soundtrack", "score": "film score", "film soundtrack": "film score", "movie score": "film score",
    "game soundtrack": "video game music", "vgm": "video game music", "nu-metal": "nu metal", "numetal": "nu metal", "alt metal": "alternative metal",
    "heavy metal": "metal", "post hardcore": "post-hardcore", "posthardcore": "post-hardcore", "synth pop": "synthpop", "synth-pop": "synthpop",
    "indie": "indie rock", "classic": "classical", "orchestra": "orchestral", "singer songwriter": "singer-songwriter", "trip-hop": "trip hop",
}

# Families and the genres in them. A genre may sit in more than one family.
FAMILIES: dict[str, set[str]] = {
    "rock": {"rock", "alternative rock", "hard rock", "indie rock", "j-rock", "pop rock", "emo", "grunge", "classic rock", "progressive rock",
             "garage rock", "psychedelic rock", "soft rock", "post-rock", "shoegaze", "britpop", "pop punk", "nu metal", "alternative metal", "stoner rock"},
    "punk": {"punk", "pop punk", "hardcore punk", "post-hardcore", "emo", "skate punk", "post-punk", "ska punk"},
    "metal": {"metal", "metalcore", "alternative metal", "nu metal", "deathcore", "death metal", "black metal", "thrash metal", "djent",
              "progressive metal", "symphonic metal", "post-metal", "power metal", "doom metal", "post-hardcore"},
    "pop": {"pop", "synthpop", "electropop", "dance pop", "indie pop", "k-pop", "j-pop", "teen pop", "pop rock", "art pop", "dream pop"},
    "electronic": {"electronic", "house", "techno", "trance", "dubstep", "drum and bass", "synthwave", "idm", "downtempo", "chillwave",
                   "electropop", "synthpop", "trip hop", "lo-fi", "breakbeat", "garage"},
    "hip hop": {"hip hop", "trap", "boom bap", "lo-fi", "trip hop", "grime", "drill"},
    "r&b": {"r&b", "soul", "neo soul", "funk", "contemporary r&b", "motown"},
    "jazz": {"jazz", "smooth jazz", "bebop", "jazz fusion", "swing", "big band", "acid jazz"},
    "blues": {"blues", "delta blues", "electric blues"},
    "classical": {"classical", "orchestral", "baroque", "opera", "chamber music", "romantic", "contemporary classical", "piano"},
    "soundtrack": {"soundtrack", "film score", "video game music", "anime", "musical", "orchestral"},
    "ambient": {"ambient", "new age", "drone", "dark ambient", "meditation"},
    "folk": {"folk", "indie folk", "singer-songwriter", "americana", "acoustic", "folk rock"},
    "country": {"country", "bluegrass", "alt-country", "americana"},
    "reggae": {"reggae", "ska", "dub", "dancehall"},
    "latin": {"latin", "reggaeton", "salsa", "bossa nova"},
}

# How close neighbouring families are (symmetric). Anything missing is 0.
FAMILY_NEIGHBOURS = {
    ("rock", "punk"): 0.75, ("rock", "metal"): 0.6, ("punk", "metal"): 0.55, ("rock", "pop"): 0.45, ("rock", "folk"): 0.35, ("rock", "blues"): 0.45,
    ("pop", "electronic"): 0.5, ("pop", "r&b"): 0.45, ("pop", "hip hop"): 0.35, ("pop", "latin"): 0.4, ("electronic", "ambient"): 0.55,
    ("electronic", "hip hop"): 0.35, ("ambient", "soundtrack"): 0.6, ("classical", "soundtrack"): 0.75, ("ambient", "classical"): 0.4,
    ("hip hop", "r&b"): 0.65, ("r&b", "jazz"): 0.45, ("jazz", "blues"): 0.5, ("jazz", "classical"): 0.3, ("folk", "country"): 0.7,
    ("blues", "r&b"): 0.45, ("reggae", "hip hop"): 0.3, ("punk", "pop"): 0.4,
}
CROSS_FAMILY_FACTOR = 0.75  # neighbouring families count for at most 0.75 of their closeness
ROOT_CHILD = 0.85
SIBLINGS = 0.7
SHARED_WORD = 0.5  # two genres outside the taxonomy that share a word ("dark folk" / "folk noir")

# Keyword hints for genres outside the taxonomy (first match wins: "symphonic metal" is metal).
KEYWORDS = [("metal", "metal"), ("core", "metal"), ("punk", "punk"), ("emo", "punk"), ("rock", "rock"), ("grunge", "rock"), ("hop", "hip hop"),
            ("rap", "hip hop"), ("trap", "hip hop"), ("r&b", "r&b"), ("soul", "r&b"), ("jazz", "jazz"), ("blues", "blues"), ("pop", "pop"),
            ("house", "electronic"), ("techno", "electronic"), ("trance", "electronic"), ("wave", "electronic"), ("step", "electronic"),
            ("electro", "electronic"), ("beat", "electronic"), ("score", "soundtrack"), ("soundtrack", "soundtrack"), ("game", "soundtrack"),
            ("ambient", "ambient"), ("orchestr", "classical"), ("symphon", "classical"), ("classical", "classical"), ("folk", "folk"),
            ("country", "country"), ("reggae", "reggae"), ("latin", "latin")]

STATION_MIN = 0.4  # a saved station only plays songs at least this close to its genres
OFF_GENRE = 0.25  # below this a song is "clearly unrelated" to the radio's anchor
UNKNOWN = 0.3  # a song with no genre tags: neither in nor clearly out
_SPLIT = re.compile(r"\s*[;,/|]\s*|\s+&\s+(?=[a-z])")


@lru_cache(maxsize=4096)
def normalize(raw: str) -> str:
    """One canonical name: lower case, plain separators, aliases folded together."""
    text = unicodedata.normalize("NFKD", raw or "").encode("ascii", "ignore").decode().lower().strip()
    text = text.replace("’", "'").replace("_", " ")
    text = re.sub(r"(?<=[a-z])-(?=[a-z])", " ", text) if text not in ("j-rock", "j-pop", "k-pop", "lo-fi", "post-rock") else text
    text = re.sub(r"\s+", " ", text).strip(" .")
    if text in ("post rock", "post-rock"):
        text = "post-rock"
    if text in ("post punk",):
        text = "post-punk"
    if text in ("alt country",):
        text = "alt-country"
    return ALIASES.get(text, text)


@lru_cache(maxsize=4096)
def split(raw: str) -> tuple[str, ...]:
    """'Rock; Pop' -> ('rock', 'pop'), canonical."""
    parts = [p for p in _SPLIT.split(raw or "") if p.strip()]
    return tuple(dict.fromkeys(normalize(p) for p in parts if normalize(p)))


def canonical(raws) -> frozenset[str]:
    return frozenset(g for raw in raws for g in split(raw))


@lru_cache(maxsize=4096)
def families(genre: str) -> frozenset[str]:
    found = {f for f, members in FAMILIES.items() if genre in members}
    if not found:
        for word, family in KEYWORDS:
            if word in genre:
                found = {family}
                break
    return frozenset(found)


def _neighbours(a: str, b: str) -> float:
    return FAMILY_NEIGHBOURS.get((a, b)) or FAMILY_NEIGHBOURS.get((b, a)) or 0.0


@lru_cache(maxsize=16384)
def similarity(a: str, b: str) -> float:
    if a == b:
        return 1.0
    fa, fb = families(a), families(b)
    if (a in FAMILIES and a in fb) or (b in FAMILIES and b in fa):
        return ROOT_CHILD
    if fa & fb:
        return SIBLINGS
    if fa and fb:
        return round(max(_neighbours(x, y) for x in fa for y in fb) * CROSS_FAMILY_FACTOR, 3)
    return SHARED_WORD if set(a.split()) & set(b.split()) else 0.0


def affinity(raw_genres, anchors: frozenset[str]) -> float:
    """How well a song (raw tags) fits the anchor genres (canonical): its best match."""
    genres = canonical(raw_genres)
    if not anchors:
        return 1.0
    if not genres:
        return UNKNOWN
    return max(similarity(g, a) for g in genres for a in anchors)


def neighbourhood(library_genres, anchors: frozenset[str], minimum: float = STATION_MIN) -> list[str]:
    """The library's raw genre tags close enough to the anchors (for candidate queries)."""
    return sorted(raw for raw in library_genres if raw and affinity((raw,), anchors) >= minimum)


# ── Drift ─────────────────────────────────────────────────────────────
DRIFT_RATE = 0.92  # each pick keeps 92% of the seed's pull...
DRIFT_FLOOR = 0.35  # ...but never less than this: the session doesn't forget where it started


def anchor_strength(picks_so_far: int, strict: bool) -> float:
    """1.0 for a saved station (always); fading gently for a song, album or artist seed."""
    if strict:
        return 1.0
    return max(DRIFT_FLOOR, DRIFT_RATE ** max(0, picks_so_far))
