"""Track likes (5.5.2): PandaFM owns them.

PandaFM is the source of truth for TRACK likes (Liked Songs, Panda Radio's liked signal, recommendations).
Every like and unlike is a durable listening event (favorite / unfavorite), and track_preferences.liked is
its projection: the latest explicit event wins (rebuild_preferences reconstructs it from events alone).
Navidrome/OpenSubsonic stars are an interoperability mirror and an import source, never an authority:

- liking/unliking in PandaFM is saved locally first, then mirrored to the music server best-effort (an
  outage never blocks or undoes it);
- a star seen during library sync may import a like, recorded as a favorite event with source
  'navidrome-import', only if PandaFM doesn't already have the song liked and the latest PandaFM event for
  it isn't an unfavorite (an explicit PandaFM unlike stays authoritative);
- an unstarred song, or a server with no stars at all (a fresh backend), changes nothing;
- when a backend replacement gives songs new ids, preferences move from the old (now unavailable) song to
  the new one only when the match is unambiguous both ways (title, artist, album, duration within 2 s).

Album and artist favorites still follow Navidrome's stars (unchanged in 5.5.2).
"""

import logging
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TrackPreference
from app.navidrome.client import NavidromeError
from app.schemas.events import TrackSnapshot
from app.schemas.library import FavoriteKind, Track
from app.services.events import record_favorite
from app.services.explore import TRACK_SELECT, track_of

log = logging.getLogger("pandafm.favorites")

LATEST_LIKE_EVENT = """(SELECT e.event_type FROM listening_events e WHERE e.user_id = :u AND e.track_id = {track}
                         AND e.event_type IN ('favorite', 'unfavorite') ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1)"""


async def liked_tracks(db: AsyncSession, user_id: int) -> list[Track]:
    """Liked Songs: from PandaFM, newest like first; songs the music server no longer has are kept but not listed."""
    rows = await db.execute(text(f"""
        SELECT {TRACK_SELECT},
               (SELECT max(e.occurred_at) FROM listening_events e WHERE e.user_id = :u AND e.track_id = t.id AND e.event_type = 'favorite') AS liked_at
        FROM track_preferences p JOIN tracks t ON t.id = p.track_id
        WHERE p.user_id = :u AND p.liked AND t.is_available
        ORDER BY liked_at DESC NULLS LAST, t.artist, t.album, t.title"""), {"u": user_id})
    return [track_of(r) for r in rows]


def _tracks_in(obj: Any, out: list[Track], depth: int = 0) -> None:
    if depth > 4 or obj is None:
        return
    if isinstance(obj, Track):
        out.append(obj)
    elif isinstance(obj, (list, tuple)):
        for x in obj:
            _tracks_in(x, out, depth + 1)
    elif isinstance(obj, BaseModel):
        for name in type(obj).model_fields:
            _tracks_in(getattr(obj, name, None), out, depth + 1)


async def with_likes(db: AsyncSession, user_id: int, result: Any) -> Any:
    """Every Track in a response shows PandaFM's liked state. Songs PandaFM doesn't know yet keep the
    music server's flag (PandaFM has no opinion on them). Best effort: the page works without it."""
    tracks: list[Track] = []
    _tracks_in(result, tracks)
    if not tracks:
        return result
    try:
        rows = await db.execute(text("""SELECT t.navidrome_id, coalesce(p.liked, false) AS liked FROM tracks t
                                         LEFT JOIN track_preferences p ON p.track_id = t.id AND p.user_id = :u
                                         WHERE t.navidrome_id = ANY(:ids)"""), {"u": user_id, "ids": list({t.id for t in tracks})})
        liked = {r.navidrome_id: r.liked for r in rows}
    except Exception:  # noqa: BLE001
        log.warning("Couldn't apply PandaFM's likes to a response (database)", exc_info=True)
        return result
    for t in tracks:
        if t.id in liked:
            t.favorite = liked[t.id]
    return result


async def set_track_like(db: AsyncSession, user_id: int, navidrome, track_id: str, liked: bool) -> None:
    """Like or unlike a song: saved in PandaFM first (the event and the liked state, committed), then
    mirrored to the music server best-effort."""
    row = (await db.execute(text("SELECT * FROM tracks WHERE navidrome_id = :id"), {"id": track_id})).first()
    if row is not None:
        snapshot = TrackSnapshot(id=row.navidrome_id, title=row.title, artist=row.artist, artist_id=row.artist_id, album=row.album,
                                 album_id=row.album_id, genres=list(row.genres or []), year=row.year, duration_seconds=row.duration_s,
                                 cover_art_id=row.cover_art_id)
    else:
        try:
            t = await navidrome.get_track(track_id)
        except NavidromeError as exc:
            raise HTTPException(503, "PandaFM doesn’t know this song yet and the music server isn’t answering.") from exc
        snapshot = TrackSnapshot(id=t.id, title=t.title, artist=t.artist, artist_id=t.artist_id, album=t.album, album_id=t.album_id,
                                 genres=t.genres, year=t.year, duration_seconds=t.duration_seconds, cover_art_id=t.cover_art_id)
    await record_favorite(db, user_id, snapshot, liked)  # durable and committed before anything else
    try:
        await navidrome.set_favorite(FavoriteKind.track, track_id, liked)
    except NavidromeError as exc:
        log.warning("Like saved in PandaFM; mirroring it to the music server failed (%s)", type(exc).__name__)


async def import_stars(db: AsyncSession, user_id: int, track_ids: list[int]) -> int:
    """Stars seen during sync: import a like where PandaFM has none and no explicit unlike. Returns how many."""
    if not track_ids:
        return 0
    rows = (await db.execute(text(f"""
        SELECT x.id FROM unnest(CAST(:ids AS bigint[])) AS x(id)
        WHERE NOT EXISTS (SELECT 1 FROM track_preferences p WHERE p.user_id = :u AND p.track_id = x.id AND p.liked)
          AND coalesce({LATEST_LIKE_EVENT.format(track='x.id')}, '') <> 'unfavorite'"""), {"ids": track_ids, "u": user_id})).scalars().all()
    if not rows:
        return 0
    await db.execute(text("""INSERT INTO track_preferences (user_id, track_id, liked) SELECT :u, x, true FROM unnest(CAST(:ids AS bigint[])) AS x
                             ON CONFLICT (user_id, track_id) DO UPDATE SET liked = true"""), {"u": user_id, "ids": list(rows)})
    await db.execute(text("""INSERT INTO listening_events (event_id, user_id, track_id, play_id, event_type, occurred_at, source, details)
                             SELECT gen_random_uuid(), :u, x, gen_random_uuid(), 'favorite', now(), 'navidrome-import', '{"import": "navidrome-star"}'::jsonb
                             FROM unnest(CAST(:ids AS bigint[])) AS x"""), {"u": user_id, "ids": list(rows)})
    return len(rows)


async def transfer_identities(db: AsyncSession, user_id: int) -> int:
    """A replaced backend may give the same songs new ids: move preferences from an old (now unavailable)
    song to a new one only when each has exactly one plausible match in the other direction too."""
    cols = [c.name for c in TrackPreference.__table__.columns if c.name not in ("user_id", "track_id")]
    norm = "lower(regexp_replace(coalesce({c}, ''), '\\s+', ' ', 'g'))"
    key = lambda a: f"{norm.format(c=a + '.title')} AS ti, {norm.format(c=a + '.artist')} AS ar, {norm.format(c=a + '.album')} AS al, {a}.duration_s AS d"  # noqa: E731
    pairs = (await db.execute(text(f"""
        WITH fresh AS (SELECT t.id, {key('t')} FROM tracks t
                       WHERE t.is_available AND NOT EXISTS (SELECT 1 FROM track_preferences p WHERE p.track_id = t.id AND p.user_id = :u)),
             gone AS (SELECT t.id, {key('t')} FROM tracks t JOIN track_preferences p ON p.track_id = t.id AND p.user_id = :u
                      WHERE NOT t.is_available AND (p.liked OR p.play_count > 0)),
             pairs AS (SELECT g.id AS old_id, f.id AS new_id FROM gone g JOIN fresh f
                       ON f.ti = g.ti AND f.ar = g.ar AND f.al = g.al AND f.ti <> '' AND abs(coalesce(f.d, -100) - coalesce(g.d, 100)) <= 2)
        SELECT old_id, new_id FROM pairs
        WHERE old_id IN (SELECT old_id FROM pairs GROUP BY old_id HAVING count(*) = 1)
          AND new_id IN (SELECT new_id FROM pairs GROUP BY new_id HAVING count(*) = 1)"""), {"u": user_id})).all()
    for old_id, new_id in pairs:
        await db.execute(text(f"""INSERT INTO track_preferences (user_id, track_id, {", ".join(cols)})
                                  SELECT user_id, :new, {", ".join(cols)} FROM track_preferences WHERE user_id = :u AND track_id = :old
                                  ON CONFLICT (user_id, track_id) DO NOTHING"""), {"u": user_id, "old": old_id, "new": new_id})
        await db.execute(text("""INSERT INTO listening_events (event_id, user_id, track_id, play_id, event_type, occurred_at, source, details)
                                 SELECT gen_random_uuid(), :u, :new, gen_random_uuid(), 'favorite', now(), 'identity-transfer',
                                        jsonb_build_object('from_track', :old) FROM track_preferences
                                 WHERE user_id = :u AND track_id = :new AND liked"""), {"u": user_id, "old": old_id, "new": new_id})
    if pairs:
        log.info("Moved preferences for %d songs that the music server now lists under new ids", len(pairs))
    return len(pairs)
