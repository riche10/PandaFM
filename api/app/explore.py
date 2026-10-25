"""Library explorer: genres, decades, related albums, genre search.

Pure functions over the user's own library and PandaFM history (no external
services). Genre identity comes from the Stage 4.3 model (app/radio/genres.py):
spellings like "Pop-Punk" / "pop punk" are one genre; genres in the same family
(Pop Punk, Alternative Rock) stay separate genres here and are only related
through similarity.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from app.radio.genres import families, normalize, similarity, split


@dataclass
class GenreEntry:
    key: str  # canonical, e.g. "pop punk"
    name: str  # the library's own most common spelling, e.g. "Pop Punk"
    raws: set[str] = field(default_factory=set)  # every tag spelling that maps to it (for queries)
    songs: int = 0
    albums: int = 0
    artists: int = 0
    covers: list[str] = field(default_factory=list)


def display_name(spellings: Counter) -> str:
    """Most used spelling; on a tie prefer one with capitals ("Pop Punk" over "pop punk"), then A-Z."""
    return sorted(spellings.items(), key=lambda kv: (-kv[1], not any(c.isupper() for c in kv[0]), kv[0]))[0][0]


def genre_index(rows) -> dict[str, GenreEntry]:
    """rows: (track_id, album_id, artist_id, cover_art_id, raw_genre) for available tracks."""
    spellings: dict[str, Counter] = defaultdict(Counter)
    tracks: dict[str, set] = defaultdict(set)
    albums: dict[str, set] = defaultdict(set)
    artists: dict[str, set] = defaultdict(set)
    covers: dict[str, dict[str, str]] = defaultdict(dict)  # one cover per album
    raws: dict[str, set] = defaultdict(set)
    for track_id, album_id, artist_id, cover, raw in rows:
        parts = split(raw)
        for key in parts:
            # "Rock; Pop" names two genres; a plain tag names itself
            spellings[key][raw.strip() if len(parts) == 1 else key.title()] += 1
            raws[key].add(raw)
            tracks[key].add(track_id)
            if album_id:
                albums[key].add(album_id)
                if cover and len(covers[key]) < 4:
                    covers[key].setdefault(album_id, cover)
            if artist_id:
                artists[key].add(artist_id)
    return {
        key: GenreEntry(key, display_name(spellings[key]), raws[key], len(tracks[key]), len(albums[key]), len(artists[key]), list(covers[key].values()))
        for key in spellings
    }


def genre_tags(raw_genres, names: dict[str, str] | None = None, limit: int = 8) -> list[tuple[str, str]]:
    """Deduplicated (key, display) pairs for chips, in tag order; empty values ignored."""
    seen: dict[str, str] = {}
    for raw in raw_genres or []:
        if not raw or not raw.strip():
            continue
        for key in split(raw):
            if key not in seen:
                seen[key] = (names or {}).get(key) or (raw.strip() if len(split(raw)) == 1 else key.title())
    return list(seen.items())[:limit]


def dominant_genres(track_genres: list[list[str]], limit: int = 3, min_share: float = 0.15) -> list[str]:
    """An artist's strongest genres: share of their songs carrying each, one-offs left out."""
    counts: Counter = Counter()
    for raws in track_genres:
        for key in {k for raw in raws or [] for k in split(raw)}:
            counts[key] += 1
    total = len(track_genres)
    if not total or not counts:
        return []
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    strong = [k for k, n in ranked if n / total >= min_share and (n >= 2 or total < 4)]
    return (strong or [ranked[0][0]])[:limit]


@dataclass(frozen=True)
class AlbumFacts:
    id: str
    name: str
    artist_id: str | None
    year: int | None
    genres: frozenset[str]  # canonical


def genre_closeness(a: frozenset[str], b: frozenset[str]) -> float:
    """Symmetric: how well each album's genres are matched by the other's."""
    if not a or not b:
        return 0.0
    there = sum(max(similarity(x, y) for y in b) for x in a) / len(a)
    back = sum(max(similarity(y, x) for x in a) for y in b) / len(b)
    return round((there + back) / 2, 4)


RELATED_MIN_GENRE = 0.5  # below this an album isn't "like" the other one: the shelf stays hidden


def related_albums(target: AlbumFacts, candidates: list[AlbumFacts], affinity: dict[str, float] | None = None,
                   names: dict[str, str] | None = None, limit: int = 12) -> list[tuple[AlbumFacts, float, str]]:
    """Albums from the library like the target: genre first, then era, then the user's genre taste.
    Same artist is left out (that's 'More by'). Deterministic. Returns (album, score, reason)."""
    out = []
    for c in candidates:
        if c.id == target.id or (target.artist_id and c.artist_id == target.artist_id):
            continue
        closeness = genre_closeness(target.genres, c.genres)
        if closeness < RELATED_MIN_GENRE:
            continue
        era = 1 - min(abs(target.year - c.year), 20) / 20 if target.year and c.year else 0.5
        taste = max(((affinity or {}).get(g, 0.0) for g in c.genres), default=0.0)
        score = round(0.75 * closeness + 0.15 * era + 0.10 * taste, 4)
        shared = sorted(c.genres, key=lambda g: (-max(similarity(g, t) for t in target.genres), g))[:2] if target.genres else []
        reason = " · ".join((names or {}).get(g, g.title()) for g in shared)
        out.append((c, score, reason))
    out.sort(key=lambda x: (-x[1], x[0].name.lower(), x[0].id))
    return out[:limit]


def decade_of(year: int | None) -> int | None:
    return (year // 10) * 10 if year and year > 0 else None


def search_genres(query: str, index: dict[str, GenreEntry], limit: int = 3) -> list[GenreEntry]:
    """Genres for a search: exact matches first, then word matches, then family matches."""
    q = normalize(query)
    if len(q) < 2:
        return []
    scored = []
    for key, g in index.items():
        if key == q or g.name.lower() == query.strip().lower():
            rank = 3.0
        elif q in key.split() or key.startswith(q) or (len(q) >= 3 and q in key):
            rank = 2.0
        elif q in families(key):
            rank = 1.0  # "rock" also finds Pop Punk, but below real matches
        else:
            continue
        scored.append((rank, g.songs, g))
    scored.sort(key=lambda x: (-x[0], -x[1], x[2].name))
    return [g for _, _, g in scored[:limit]]
