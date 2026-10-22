"""Store listening events and keep the statistics projection up to date.

Events are append-only and idempotent (the app's event_id is unique), so a
phone retrying a batch after a dropped connection never double-counts.
The projection (track_preferences) is updated only for genuinely new events
and can be rebuilt from scratch at any time.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ListeningEvent, RadioQueueItem, RadioSession, TrackPreference
from app.radio import session as radio_session
from app.radio.config import MODES, PANDA
from app.radio.signals import classify_skip, counts_as_listen
from app.schemas.events import EventBatch, EventIn, EventResult, TrackSnapshot
from app.services.library_sync import ensure_track


@dataclass(frozen=True)
class Scrobble:
    navidrome_id: str
    played_at: datetime


def snapshot_row(track: TrackSnapshot) -> dict[str, Any]:
    return {
        "navidrome_id": track.id,
        "title": track.title,
        "artist": track.artist,
        "artist_id": track.artist_id,
        "album": track.album,
        "album_id": track.album_id,
        "genres": track.genres,
        "year": track.year,
        "duration_s": track.duration_seconds,
        "cover_art_id": track.cover_art_id,
    }


async def ingest(db: AsyncSession, user_id: int, batch: EventBatch) -> tuple[EventResult, list[Scrobble]]:
    accepted = duplicates = 0
    scrobbles: list[Scrobble] = []
    for event in sorted(batch.events, key=lambda e: e.occurred_at):
        track_id = await ensure_track(db, snapshot_row(event.track))
        details = dict(event.details)
        kind = None
        if event.type == "skip":
            kind = classify_skip(event.position_s, event.duration_s or event.track.duration_seconds)
            details["skip_kind"] = kind  # decided here, not trusted from the client
        session_id = await _valid_session(db, user_id, event.radio_session_id)
        if event.radio_selection_id is not None and session_id:
            details["radio_selection_id"] = event.radio_selection_id

        inserted = await db.scalar(
            pg_insert(ListeningEvent)
            .values(
                event_id=event.event_id,
                user_id=user_id,
                track_id=track_id,
                play_id=event.play_id,
                radio_session_id=session_id,
                event_type=event.type,
                occurred_at=event.occurred_at,
                position_s=event.position_s,
                duration_s=event.duration_s,
                source=event.source,
                mode=event.mode,
                details=details,
            )
            .on_conflict_do_nothing(index_elements=["event_id"])
            .returning(ListeningEvent.id)
        )
        if inserted is None:
            duplicates += 1
            continue
        accepted += 1
        await _project(db, user_id, track_id, event, kind)
        if session_id and event.radio_selection_id is not None:
            await _steer(db, session_id, event.radio_selection_id, event, kind)
        if event.type == "play_completed" or (event.type == "skip" and counts_as_listen(event.position_s, event.duration_s)):
            scrobbles.append(Scrobble(event.track.id, event.occurred_at))
    await db.commit()
    return EventResult(accepted=accepted, duplicates=duplicates), scrobbles


async def _valid_session(db: AsyncSession, user_id: int, session_id: UUID | None) -> UUID | None:
    if session_id is None:
        return None
    owner = await db.scalar(select(RadioSession.user_id).where(RadioSession.id == session_id))
    return session_id if owner == user_id else None


async def _project(db: AsyncSession, user_id: int, track_id: int, event: EventIn, kind: str | None) -> None:
    """Fold one new event into the per-song statistics."""
    at = event.occurred_at
    values: dict[str, Any]
    if event.type == "play_started":
        values = {"play_count": 1, "last_played_at": at}
    elif event.type == "play_completed":
        values = {"completed_count": 1, "listened_s": event.duration_s or event.position_s or 0, "last_completed_at": at}
    elif event.type == "skip":
        values = {
            "skip_count": 1,
            "early_skip_count": 1 if kind == "early" else 0,
            "late_skip_count": 1 if kind == "late" else 0,
            "listened_s": event.position_s or 0,
            "last_skipped_at": at,
        }
    elif event.type in ("favorite", "unfavorite"):
        values = {"liked": event.type == "favorite"}  # mirrors Navidrome's star
    else:
        return  # pause / resume / seek are history, not statistics

    stmt = pg_insert(TrackPreference).values(user_id=user_id, track_id=track_id, **values)
    added = lambda col: getattr(TrackPreference, col) + stmt.excluded[col]  # noqa: E731
    latest = lambda col: func.greatest(getattr(TrackPreference, col), stmt.excluded[col])  # noqa: E731
    set_: dict[str, Any] = {"updated_at": func.now()}
    for column in values:
        if column == "liked":
            set_[column] = stmt.excluded.liked
        elif column.startswith("last_"):
            set_[column] = latest(column)
        else:
            set_[column] = added(column)
    await db.execute(stmt.on_conflict_do_update(index_elements=["user_id", "track_id"], set_=set_))


async def _steer(db: AsyncSession, session_id: UUID, selection_id: int, event: EventIn, kind: str | None) -> None:
    """A radio pick was started, finished or skipped: update the session's short-term taste."""
    session = await db.scalar(select(RadioSession).where(RadioSession.id == session_id).with_for_update())
    if session is None:
        return
    status = {"play_started": "played", "skip": "skipped"}.get(event.type)
    if status:
        await db.execute(
            update(RadioQueueItem)
            .where(RadioQueueItem.id == selection_id, RadioQueueItem.session_id == session_id, RadioQueueItem.status.in_(["queued", "played"]))
            .values(status=status)
        )
    if session.status != "active" or event.type not in ("skip", "play_completed"):
        return
    mode = MODES.get(session.mode, PANDA)
    state = radio_session.SessionState.from_json(session.state, mode.base_exploration)
    genres, artist_id = list(event.track.genres), event.track.artist_id
    if event.type == "skip":
        state = radio_session.on_skip(state, genres, artist_id, kind or "mid")
    else:
        state = radio_session.on_complete(state, genres, artist_id, mode.base_exploration)
    session.state = state.to_json()
    session.last_activity_at = func.now()


async def record_favorite(db: AsyncSession, user_id: int, track: TrackSnapshot, favorite: bool) -> None:
    """Favorites are set in Navidrome; this records the signal and mirrors it for radio."""
    from uuid import uuid4

    batch = EventBatch(
        events=[
            EventIn(
                event_id=uuid4(),
                type="favorite" if favorite else "unfavorite",
                track=track,
                play_id=uuid4(),
                occurred_at=datetime.now().astimezone(),
                source="favorites",
            )
        ]
    )
    await ingest(db, user_id, batch)


REBUILD_SQL = text(
    """
    WITH agg AS (
      SELECT track_id,
        count(*) FILTER (WHERE event_type = 'play_started') AS plays,
        count(*) FILTER (WHERE event_type = 'play_completed') AS completed,
        count(*) FILTER (WHERE event_type = 'skip') AS skips,
        count(*) FILTER (WHERE event_type = 'skip' AND details->>'skip_kind' = 'early') AS early,
        count(*) FILTER (WHERE event_type = 'skip' AND details->>'skip_kind' = 'late') AS late,
        coalesce(sum(CASE WHEN event_type = 'play_completed' THEN coalesce(duration_s, position_s, 0)
                          WHEN event_type = 'skip' THEN coalesce(position_s, 0) END), 0) AS listened,
        max(occurred_at) FILTER (WHERE event_type = 'play_started') AS last_played,
        max(occurred_at) FILTER (WHERE event_type = 'play_completed') AS last_completed,
        max(occurred_at) FILTER (WHERE event_type = 'skip') AS last_skipped
      FROM listening_events WHERE user_id = :user GROUP BY track_id
    )
    INSERT INTO track_preferences AS p (user_id, track_id, play_count, completed_count, skip_count,
        early_skip_count, late_skip_count, listened_s, last_played_at, last_completed_at, last_skipped_at)
    SELECT :user, track_id, plays, completed, skips, early, late, listened, last_played, last_completed, last_skipped FROM agg
    ON CONFLICT (user_id, track_id) DO UPDATE SET
      play_count = excluded.play_count, completed_count = excluded.completed_count, skip_count = excluded.skip_count,
      early_skip_count = excluded.early_skip_count, late_skip_count = excluded.late_skip_count,
      listened_s = excluded.listened_s, last_played_at = excluded.last_played_at,
      last_completed_at = excluded.last_completed_at, last_skipped_at = excluded.last_skipped_at, updated_at = now()
    """
)


async def rebuild_preferences(db: AsyncSession, user_id: int) -> int:
    """Recompute all statistics from the event history (liked is left to Navidrome sync)."""
    await db.execute(
        text(
            """UPDATE track_preferences SET play_count = 0, completed_count = 0, skip_count = 0, early_skip_count = 0,
               late_skip_count = 0, listened_s = 0, last_played_at = NULL, last_completed_at = NULL, last_skipped_at = NULL
               WHERE user_id = :user AND track_id NOT IN (SELECT track_id FROM listening_events WHERE user_id = :user)"""
        ),
        {"user": user_id},
    )
    result = await db.execute(REBUILD_SQL, {"user": user_id})
    await db.commit()
    return result.rowcount
