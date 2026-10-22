"""Home sections and listening statistics, computed from PandaFM's own history.

Kept deliberately simple and explainable: no hidden scoring here.
"""

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.library import Track

TRACK_COLUMNS = """t.navidrome_id, t.title, t.artist, t.artist_id, t.album, t.album_id, t.cover_art_id,
                   t.duration_s, t.year, t.genres, coalesce(p.liked, false) AS liked"""


def _track(r) -> Track:
    return Track(
        id=r.navidrome_id, title=r.title, artist=r.artist, artist_id=r.artist_id, album=r.album, album_id=r.album_id,
        cover_art_id=r.cover_art_id, duration_seconds=r.duration_s, year=r.year, genres=list(r.genres or []), favorite=r.liked,
    )


async def recently_played(db: AsyncSession, user_id: int, limit: int = 20) -> list[Track]:
    rows = await db.execute(
        text(
            f"""SELECT {TRACK_COLUMNS} FROM (
                  SELECT DISTINCT ON (track_id) track_id, occurred_at FROM listening_events
                  WHERE user_id = :user AND event_type = 'play_started' ORDER BY track_id, occurred_at DESC
                ) last JOIN tracks t ON t.id = last.track_id
                LEFT JOIN track_preferences p ON p.track_id = t.id AND p.user_id = :user
                WHERE t.is_available ORDER BY last.occurred_at DESC LIMIT :limit"""
        ),
        {"user": user_id, "limit": limit},
    )
    return [_track(r) for r in rows]


async def back_in_rotation(db: AsyncSession, user_id: int, limit: int = 20) -> list[Track]:
    """Songs you've finished several times and more often than skipped, not played this past week."""
    rows = await db.execute(
        text(
            f"""SELECT {TRACK_COLUMNS} FROM track_preferences p JOIN tracks t ON t.id = p.track_id
                WHERE p.user_id = :user AND t.is_available AND p.completed_count >= 2
                  AND p.completed_count > p.early_skip_count AND p.last_played_at < now() - interval '7 days'
                ORDER BY p.completed_count DESC, p.last_played_at ASC LIMIT :limit"""
        ),
        {"user": user_id, "limit": limit},
    )
    return [_track(r) for r in rows]


async def rediscover(db: AsyncSession, user_id: int, limit: int = 20) -> list[Track]:
    """Favorites you haven't played in PandaFM for six weeks (or ever)."""
    rows = await db.execute(
        text(
            f"""SELECT {TRACK_COLUMNS} FROM track_preferences p JOIN tracks t ON t.id = p.track_id
                WHERE p.user_id = :user AND t.is_available AND p.liked
                  AND (p.last_played_at IS NULL OR p.last_played_at < now() - interval '42 days')
                ORDER BY p.last_played_at ASC NULLS FIRST, t.id LIMIT :limit"""
        ),
        {"user": user_id, "limit": limit},
    )
    return [_track(r) for r in rows]


async def stats(db: AsyncSession, user_id: int) -> dict[str, Any]:
    one = lambda sql: db.scalar(text(sql), {"user": user_id})  # noqa: E731
    totals = (
        await db.execute(
            text(
                """SELECT count(*) FILTER (WHERE event_type = 'play_started') AS plays,
                          count(*) FILTER (WHERE event_type = 'play_completed') AS completed,
                          count(*) FILTER (WHERE event_type = 'skip') AS skips,
                          count(*) FILTER (WHERE event_type = 'skip' AND details->>'skip_kind' = 'early') AS early,
                          count(*) AS events
                   FROM listening_events WHERE user_id = :user"""
            ),
            {"user": user_id},
        )
    ).one()
    ranked = lambda order: db.execute(  # noqa: E731
        text(
            f"""SELECT t.artist AS name, sum(p.completed_count) AS completed, sum(p.skip_count) AS skips,
                       sum(p.early_skip_count) AS early, sum(p.play_count) AS plays
                FROM track_preferences p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = :user
                GROUP BY t.artist HAVING sum(p.play_count) > 0 ORDER BY {order} DESC LIMIT 10"""
        ),
        {"user": user_id},
    )
    genres = await db.execute(
        text(
            """SELECT g AS name, round(sum(p.listened_s) / 60.0) AS minutes, sum(p.completed_count) AS completed
               FROM track_preferences p JOIN tracks t ON t.id = p.track_id CROSS JOIN LATERAL unnest(t.genres) g
               WHERE p.user_id = :user GROUP BY g HAVING sum(p.listened_s) > 0 ORDER BY minutes DESC LIMIT 10"""
        ),
        {"user": user_id},
    )
    sessions = await db.execute(
        text(
            """SELECT s.mode, s.status, s.seed->>'name' AS seed, s.created_at,
                      count(i.id) FILTER (WHERE i.status = 'played') AS played,
                      count(i.id) FILTER (WHERE i.status = 'skipped') AS skipped,
                      count(i.id) FILTER (WHERE i.status = 'replaced') AS replaced,
                      count(i.id) AS chosen
               FROM radio_sessions s LEFT JOIN radio_queue_items i ON i.session_id = s.id
               WHERE s.user_id = :user GROUP BY s.id ORDER BY s.created_at DESC LIMIT 10"""
        ),
        {"user": user_id},
    )
    plays = totals.plays or 0
    rows = lambda result: [dict(r._mapping) for r in result]  # noqa: E731
    return {
        "events": totals.events,
        "plays": plays,
        "completion_rate": round(totals.completed / plays, 3) if plays else None,
        "skip_rate": round(totals.skips / plays, 3) if plays else None,
        "early_skip_rate": round(totals.early / plays, 3) if plays else None,
        "tracks_cached": await one("SELECT count(*) FROM tracks"),
        "tracks_available": await one("SELECT count(*) FROM tracks WHERE is_available"),
        "radio_sessions": await one("SELECT count(*) FROM radio_sessions WHERE user_id = :user"),
        "top_completed_artists": rows(await ranked("sum(p.completed_count)")),
        "most_skipped_artists": rows(await ranked("sum(p.early_skip_count) + sum(p.skip_count)")),
        "top_genres": rows(genres),
        "recent_sessions": rows(sessions),
    }
