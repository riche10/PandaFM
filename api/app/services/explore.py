"""Library explorer queries over PandaFM's synced track cache.

Navidrome stays authoritative: only tracks the last sync saw as available
are used, and favourite albums come from Navidrome's stars. Filtering and
paging happen in PostgreSQL, so the app never downloads the whole library.
"""

from collections import defaultdict

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.audio.quality import AudioFacts, describe, sql_hi_res, sql_lossless
from app.explore import AlbumFacts, GenreEntry, decade_of, dominant_genres, genre_index, related_albums, search_genres
from app.radio.genres import canonical, neighbourhood, similarity, split
from app.schemas.library import AlbumSummary, GenreSummary, GenreTag, Track
from app.services import insights

_index_cache: dict[tuple, dict[str, GenreEntry]] = {}


async def _library_version(db: AsyncSession) -> tuple:
    row = (await db.execute(text("SELECT (SELECT max(finished_at) FROM library_syncs), (SELECT count(*) FROM tracks WHERE is_available), (SELECT max(last_synced_at) FROM tracks)"))).one()
    return tuple(row)


async def index(db: AsyncSession) -> dict[str, GenreEntry]:
    """All genres in the library, keyed by canonical name; recomputed once per sync."""
    version = await _library_version(db)
    if version not in _index_cache:
        rows = (await db.execute(text("SELECT t.id, t.album_id, t.artist_id, t.cover_art_id, g FROM tracks t, unnest(t.genres) g WHERE t.is_available AND g <> ''"))).all()
        _index_cache.clear()
        _index_cache[version] = genre_index(rows)
    return _index_cache[version]


def summary(g: GenreEntry) -> GenreSummary:
    return GenreSummary(key=g.key, name=g.name, songs=g.songs, albums=g.albums, artists=g.artists, cover_art_ids=g.covers)


def names(idx: dict[str, GenreEntry]) -> dict[str, str]:
    return {k: g.name for k, g in idx.items()}


TRACK_SELECT = """t.navidrome_id, t.title, t.artist, t.artist_id, t.album, t.album_id, t.cover_art_id, t.duration_s, t.year, t.genres,
                  t.suffix, t.bitrate_kbps, t.sample_rate, t.bit_depth, t.channels, t.size_bytes, coalesce(p.liked, false) AS liked"""


def track_of(r) -> Track:
    facts = AudioFacts(r.suffix, None, r.bitrate_kbps, r.sample_rate, r.bit_depth, r.channels, r.size_bytes, r.duration_s)
    return Track(
        id=r.navidrome_id, title=r.title, artist=r.artist, artist_id=r.artist_id, album=r.album, album_id=r.album_id,
        cover_art_id=r.cover_art_id, duration_seconds=r.duration_s, year=r.year, genres=list(r.genres or []), favorite=r.liked,
        suffix=r.suffix, bitrate_kbps=r.bitrate_kbps, sample_rate=r.sample_rate, bit_depth=r.bit_depth, channels=r.channels,
        size_bytes=r.size_bytes, quality=describe(facts) if r.suffix else None,
    )


async def _conditions(db: AsyncSession, *, genre: str | None, decade: int | None, favorites: bool, lossless: bool, hires: bool,
                      unplayed: bool, favorite_albums: list[str] | None = None) -> tuple[list[str], dict]:
    conds, params = ["t.is_available"], {}
    if genre:
        raws = sorted((await index(db)).get(genre, GenreEntry(genre, genre)).raws)
        conds.append("t.genres && CAST(:raws AS text[])")
        params["raws"] = raws or ["\u0001none"]
    if decade is not None:
        conds.append("t.year BETWEEN :d0 AND :d1")
        params.update(d0=decade, d1=decade + 9)
    if favorites:
        if favorite_albums is not None:
            conds.append("t.album_id = ANY(CAST(:fav_albums AS text[]))")
            params["fav_albums"] = favorite_albums or ["\u0001none"]
        else:
            conds.append("coalesce(p.liked, false)")
    if hires:
        sql, extra = sql_hi_res()
        conds.append(sql)
        params.update(extra)
    elif lossless:
        sql, extra = sql_lossless()
        conds.append(sql)
        params.update(extra)
    if unplayed:
        conds.append("coalesce(p.play_count, 0) = 0")  # no PandaFM play history at all
    return conds, params


TRACK_ORDERS = {"artist": "lower(t.artist), lower(coalesce(t.album, '')), t.id", "title": "lower(t.title), t.id",
                "recent": "t.first_seen_at DESC, t.id", "random": "random()"}


async def browse_tracks(db: AsyncSession, user_id: int, *, genre=None, decade=None, favorites=False, lossless=False, hires=False,
                        unplayed=False, order="artist", offset=0, limit=50) -> tuple[list[Track], int]:
    conds, params = await _conditions(db, genre=genre, decade=decade, favorites=favorites, lossless=lossless, hires=hires, unplayed=unplayed)
    rows = (await db.execute(text(
        f"""SELECT {TRACK_SELECT}, count(*) OVER () AS total FROM tracks t
            LEFT JOIN track_preferences p ON p.track_id = t.id AND p.user_id = :user
            WHERE {' AND '.join(conds)} ORDER BY {TRACK_ORDERS.get(order, TRACK_ORDERS['artist'])} OFFSET :offset LIMIT :limit"""),
        {**params, "user": user_id, "offset": offset, "limit": limit})).all()
    return [track_of(r) for r in rows], (rows[0].total if rows else 0)


ALBUM_ORDERS = {"name": "lower(min(t.album)), t.album_id", "year": "min(t.year) DESC NULLS LAST, lower(min(t.album))",
                "artist": "lower(min(t.artist)), lower(min(t.album))", "random": "random()"}


async def browse_albums(db: AsyncSession, user_id: int, *, genre=None, decade=None, favorite_albums: list[str] | None = None,
                        order="name", offset=0, limit=40) -> tuple[list[AlbumSummary], int]:
    conds, params = await _conditions(db, genre=genre, decade=decade, favorites=favorite_albums is not None, lossless=False, hires=False,
                                      unplayed=False, favorite_albums=favorite_albums)
    rows = (await db.execute(text(
        f"""SELECT t.album_id, min(t.album) AS name, min(t.artist) AS artist, min(t.artist_id) AS artist_id, min(t.cover_art_id) AS cover,
                   min(t.year) FILTER (WHERE t.year > 0) AS year, count(*) AS songs, sum(t.duration_s) AS duration, count(*) OVER () AS total
            FROM tracks t LEFT JOIN track_preferences p ON p.track_id = t.id AND p.user_id = :user
            WHERE {' AND '.join(conds)} AND t.album_id IS NOT NULL
            GROUP BY t.album_id ORDER BY {ALBUM_ORDERS.get(order, ALBUM_ORDERS['name'])} OFFSET :offset LIMIT :limit"""),
        {**params, "user": user_id, "offset": offset, "limit": limit})).all()
    genres = await _album_genres(db, [r.album_id for r in rows])
    from app.explore import genre_tags

    albums = [AlbumSummary(id=r.album_id, name=r.name or "Untitled", artist=r.artist or "Unknown artist", artist_id=r.artist_id, cover_art_id=r.cover,
                           year=r.year, track_count=r.songs, duration_seconds=r.duration, genres=genres.get(r.album_id, []),
                           genre_tags=[GenreTag(key=k, name=n) for k, n in genre_tags(genres.get(r.album_id, []))]) for r in rows]
    return albums, (rows[0].total if rows else 0)


async def _album_genres(db: AsyncSession, album_ids: list[str]) -> dict[str, list[str]]:
    if not album_ids:
        return {}
    rows = await db.execute(text("SELECT album_id, array_agg(DISTINCT g) AS g FROM tracks, unnest(genres) g WHERE album_id = ANY(:ids) AND is_available GROUP BY album_id"), {"ids": album_ids})
    return {r.album_id: sorted(r.g) for r in rows}


async def genre_detail(db: AsyncSession, key: str) -> tuple[GenreEntry, list[dict], list[GenreEntry]] | None:
    idx = await index(db)
    g = idx.get(key)
    if g is None:
        return None
    artists = (await db.execute(text(
        """SELECT t.artist_id, min(t.artist) AS name, count(*) AS songs, min(t.cover_art_id) AS cover FROM tracks t
           WHERE t.is_available AND t.artist_id IS NOT NULL AND t.genres && CAST(:raws AS text[])
           GROUP BY t.artist_id ORDER BY count(*) DESC, lower(min(t.artist)) LIMIT 18"""), {"raws": sorted(g.raws)})).all()
    related = sorted((o for o in idx.values() if o.key != key and similarity(key, o.key) >= 0.7), key=lambda o: (-similarity(key, o.key), -o.songs))[:8]
    return g, [{"id": a.artist_id, "name": a.name, "songs": a.songs, "cover_art_id": a.cover} for a in artists], related


async def decades(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(text(
        """SELECT (year / 10) * 10 AS decade, count(DISTINCT album_id) AS albums, count(*) AS songs FROM tracks
           WHERE is_available AND year > 0 GROUP BY 1 ORDER BY 1 DESC"""))).all()
    return [{"decade": r.decade, "label": f"{r.decade}s", "albums": r.albums, "songs": r.songs} for r in rows if decade_of(r.decade) is not None]


async def artist_genres(db: AsyncSession, artist_id: str) -> list[GenreTag]:
    rows = (await db.execute(text("SELECT genres FROM tracks WHERE artist_id = :a AND is_available"), {"a": artist_id})).scalars().all()
    idx = await index(db)
    return [GenreTag(key=k, name=idx[k].name if k in idx else k.title()) for k in dominant_genres([list(r or []) for r in rows])]


async def _genre_affinity(db: AsyncSession, user_id: int) -> dict[str, float]:
    rows = (await db.execute(text(
        """SELECT g, sum(p.completed_count * 2 + p.play_count - p.skip_count) AS w FROM track_preferences p JOIN tracks t ON t.id = p.track_id,
           unnest(t.genres) g WHERE p.user_id = :u GROUP BY g"""), {"u": user_id})).all()
    weights: dict[str, float] = defaultdict(float)
    for r in rows:
        for key in split(r.g):
            weights[key] += max(0, r.w or 0)
    top = max(weights.values(), default=0)
    return {k: w / top for k, w in weights.items()} if top else {}


async def related(db: AsyncSession, user_id: int, album_id: str, limit: int = 12) -> list[tuple[AlbumSummary, float, str]]:
    target_rows = (await db.execute(text("SELECT artist_id, year, genres FROM tracks WHERE album_id = :a AND is_available"), {"a": album_id})).all()
    if not target_rows:
        return []
    target_genres = canonical({g for r in target_rows for g in (r.genres or [])})
    if not target_genres:
        return []  # nothing to compare: no shelf rather than random albums
    years = [r.year for r in target_rows if r.year]
    target = AlbumFacts(album_id, "", target_rows[0].artist_id, min(years) if years else None, target_genres)
    idx = await index(db)
    hood = neighbourhood([raw for g in idx.values() for raw in g.raws], target_genres, 0.5)
    if not hood:
        return []
    rows = (await db.execute(text(
        """SELECT t.album_id, min(t.album) AS name, min(t.artist) AS artist, min(t.artist_id) AS artist_id, min(t.cover_art_id) AS cover,
                  min(t.year) FILTER (WHERE t.year > 0) AS year, count(*) AS songs, array_agg(DISTINCT g) AS genres
           FROM tracks t, unnest(t.genres) g WHERE t.is_available AND t.album_id IS NOT NULL AND t.album_id <> :a
             AND t.genres && CAST(:hood AS text[]) GROUP BY t.album_id"""), {"a": album_id, "hood": hood})).all()
    facts = {r.album_id: AlbumFacts(r.album_id, r.name or "", r.artist_id, r.year, canonical(r.genres or [])) for r in rows}
    ranked = related_albums(target, list(facts.values()), await _genre_affinity(db, user_id), names(idx), limit)
    by_id = {r.album_id: r for r in rows}
    from app.explore import genre_tags

    out = []
    for f, score, reason in ranked:
        r = by_id[f.id]
        out.append((AlbumSummary(id=r.album_id, name=r.name or "Untitled", artist=r.artist or "Unknown artist", artist_id=r.artist_id, cover_art_id=r.cover,
                                 year=r.year, track_count=r.songs, genres=sorted(r.genres or []),
                                 genre_tags=[GenreTag(key=k, name=n) for k, n in genre_tags(sorted(r.genres or []))]), score, reason))
    return out


async def top_genres(db: AsyncSession, user_id: int, limit: int = 8) -> tuple[str, list[GenreEntry]]:
    idx = await index(db)
    affinity = await _genre_affinity(db, user_id)
    if affinity:
        keys = [k for k, _ in sorted(affinity.items(), key=lambda kv: (-kv[1], kv[0])) if k in idx]
        if keys:
            return "history", [idx[k] for k in keys[:limit]]
    return "library", sorted(idx.values(), key=lambda g: (-g.songs, g.name))[:limit]


async def find_genres(db: AsyncSession, query: str, limit: int = 3) -> list[GenreEntry]:
    return search_genres(query, await index(db), limit)


async def collection_counts(db: AsyncSession, user_id: int) -> dict[str, int]:
    lossless, lp = sql_lossless()
    hires, hp = sql_hi_res()
    row = (await db.execute(text(
        f"""SELECT count(*) FILTER (WHERE coalesce(p.play_count, 0) = 0) AS unplayed,
                   count(*) FILTER (WHERE {lossless}) AS lossless, count(*) FILTER (WHERE {hires}) AS hires
            FROM tracks t LEFT JOIN track_preferences p ON p.track_id = t.id AND p.user_id = :u WHERE t.is_available"""),
        {**lp, **hp, "u": user_id})).one()
    return {"unplayed": row.unplayed, "lossless": row.lossless, "hires": row.hires}


async def rediscover(db: AsyncSession, user_id: int, limit: int) -> list[Track]:
    return await insights.rediscover(db, user_id, limit)  # the existing definition, not a new one
