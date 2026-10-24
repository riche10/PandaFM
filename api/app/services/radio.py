"""Panda Radio sessions: gather candidates in SQL, choose with the pure engine
(app/radio), and record every choice with its score breakdown.

Candidates come from a handful of cheap queries (seed artist, seed genres,
adjacent genres, favorites, your best artists, nearby years, unplayed songs,
a random slice), a few hundred songs at most, never the whole library.
"""

import random
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import RadioQueueItem, RadioSession, Track
from app.radio import config
from app.radio import session as radio_session
from app.radio.config import MODES, ModeProfile
from app.radio.presets import from_snapshot, preset_reasons, snapshot
from app.radio.explain import reasons
from app.radio.scoring import Candidate, Profile, Recent, Seed
from app.radio.selection import Pick, choose
from app.radio.signals import smoothed_affinity
from app.schemas.library import Track as TrackOut
from app.schemas.radio import RadioPick, RadioSessionOut


class RadioError(Exception):
    """Something the listener should hear about (no music, unknown mode, ended session)."""


SKIP_SQL = f"(p.early_skip_count * {config.SKIP_WEIGHT['early']} + (p.skip_count - p.early_skip_count - p.late_skip_count) * {config.SKIP_WEIGHT['mid']} + p.late_skip_count * {config.SKIP_WEIGHT['late']})"


async def load_profile(db: AsyncSession, user_id: int) -> Profile:
    """Long-term artist and genre affinity, aggregated in the database."""
    base = f"""SUM(p.completed_count) AS completed, SUM({SKIP_SQL}) AS skips,
               SUM(p.play_count) AS plays, SUM(CASE WHEN p.liked THEN 1 ELSE 0 END) AS liked
               FROM track_preferences p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = :user"""
    artists = await db.execute(text(f"SELECT t.artist_id AS key, {base} AND t.artist_id IS NOT NULL GROUP BY t.artist_id"), {"user": user_id})
    genres = await db.execute(text(f"SELECT g AS key, {base.replace('JOIN tracks t ON t.id = p.track_id', 'JOIN tracks t ON t.id = p.track_id CROSS JOIN LATERAL unnest(t.genres) AS g')} GROUP BY g"), {"user": user_id})
    affinity = lambda rows: {r.key: smoothed_affinity(float(r.completed or 0), float(r.skips or 0), float(r.plays or 0), float(r.liked or 0)) for r in rows}  # noqa: E731
    return Profile(genre_affinity=affinity(genres), artist_affinity=affinity(artists))


async def resolve_seed(db: AsyncSession, kind: str | None, navidrome_id: str | None, profile: Profile, user_id: int) -> tuple[Seed, dict[str, Any] | None, int | None]:
    """Turn a song/album/artist (or nothing) into a Seed. Returns (seed, json for the session, seed track id)."""
    if kind == "track":
        t = await db.scalar(select(Track).where(Track.navidrome_id == navidrome_id))
        if t is None:
            raise RadioError("That song isn’t in PandaFM’s library cache yet. Try again after the next library sync.")
        seed = Seed(name=t.title, track_id=t.id, artist_id=t.artist_id, album_id=t.album_id, genres=frozenset(t.genres), year=t.year)
        return seed, {"kind": "track", "id": navidrome_id, "name": t.title}, t.id
    if kind in ("album", "artist"):
        column = Track.album_id if kind == "album" else Track.artist_id
        rows = (await db.execute(select(Track).where(column == navidrome_id, Track.is_available))).scalars().all()
        if not rows:
            raise RadioError(f"That {kind} isn’t in PandaFM’s library cache yet. Try again after the next library sync.")
        genres = frozenset(g for t in rows for g in t.genres)
        years = [t.year for t in rows if t.year]
        name = rows[0].album if kind == "album" else rows[0].artist
        seed = Seed(name=name, artist_id=rows[0].artist_id, album_id=rows[0].album_id if kind == "album" else None, genres=genres, year=min(years) if years else None)
        return seed, {"kind": kind, "id": navidrome_id, "name": name}, None
    # No seed: start from long-term taste, or from favorites, or (brand new) anywhere.
    liked_genres = sorted(((g, a) for g, a in profile.genre_affinity.items() if a > 0), key=lambda x: -x[1])[:3]
    if not liked_genres:
        rows = await db.execute(
            text("SELECT unnest(t.genres) AS g, count(*) AS n FROM track_preferences p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = :user AND p.liked GROUP BY g ORDER BY n DESC LIMIT 3"),
            {"user": user_id},
        )
        liked_genres = [(r.g, r.n) for r in rows]
    return Seed(genres=frozenset(g for g, _ in liked_genres)), None, None


async def gather_candidates(db: AsyncSession, user_id: int, mode: ModeProfile, seed: Seed, profile: Profile, exclude: set[int], rng: random.Random) -> list[Candidate]:
    await db.execute(text("SELECT setseed(:s)"), {"s": rng.uniform(-1, 1)})  # repeatable random() for tests
    base = "SELECT t.id FROM tracks t WHERE t.is_available AND NOT (t.id = ANY(:exclude))"
    params: dict[str, Any] = {"exclude": list(exclude) or [0], "user": user_id}
    limits = mode.candidates
    queries: dict[str, tuple[str, dict[str, Any]]] = {
        "random": (f"{base} ORDER BY random() LIMIT :n", {}),
        "favorites": (f"{base} AND EXISTS (SELECT 1 FROM track_preferences p WHERE p.track_id = t.id AND p.user_id = :user AND p.liked) ORDER BY random() LIMIT :n", {}),
        "underplayed": (f"{base} AND NOT EXISTS (SELECT 1 FROM track_preferences p WHERE p.track_id = t.id AND p.user_id = :user AND p.play_count > 0) ORDER BY random() LIMIT :n", {}),
    }
    if seed.artist_id:
        queries["seed_artist"] = (f"{base} AND t.artist_id = :artist ORDER BY random() LIMIT :n", {"artist": seed.artist_id})
    if seed.genres:
        genres = list(seed.genres)
        queries["seed_genre"] = (f"{base} AND t.genres && CAST(:genres AS text[]) ORDER BY random() LIMIT :n", {"genres": genres})
        adjacent = (
            await db.execute(
                text("SELECT g FROM (SELECT unnest(genres) AS g FROM tracks WHERE is_available AND genres && CAST(:genres AS text[])) x WHERE NOT (g = ANY(CAST(:genres AS text[]))) GROUP BY g ORDER BY count(*) DESC LIMIT 6"),
                {"genres": genres},
            )
        ).scalars().all()
        if adjacent:
            queries["adjacent_genre"] = (f"{base} AND t.genres && CAST(:adjacent AS text[]) ORDER BY random() LIMIT :n", {"adjacent": list(adjacent)})
    if seed.year:
        queries["era"] = (f"{base} AND t.year BETWEEN :year - 5 AND :year + 5 ORDER BY random() LIMIT :n", {"year": seed.year})
    top_artists = [a for a, v in sorted(profile.artist_affinity.items(), key=lambda x: -x[1]) if v > 0.2][:8]
    if top_artists:
        queries["top_artists"] = (f"{base} AND t.artist_id = ANY(:artists) ORDER BY random() LIMIT :n", {"artists": top_artists})

    sources: dict[int, set[str]] = {}
    for name, (sql, extra) in queries.items():
        for track_id in (await db.execute(text(sql), {**params, **extra, "n": limits.get(name, 40)})).scalars():
            sources.setdefault(track_id, set()).add(name)
    if not sources:
        return []

    rows = await db.execute(
        text(
            """SELECT t.id, t.navidrome_id, t.title, t.artist, t.artist_id, t.album, t.album_id, t.genres, t.year,
                      t.duration_s, t.cover_art_id, coalesce(p.liked, false) AS liked, coalesce(p.play_count, 0) AS play_count,
                      coalesce(p.completed_count, 0) AS completed_count, coalesce(p.skip_count, 0) AS skip_count,
                      coalesce(p.early_skip_count, 0) AS early_skip_count, coalesce(p.late_skip_count, 0) AS late_skip_count,
                      EXTRACT(EPOCH FROM (now() - p.last_played_at)) / 3600.0 AS hours
               FROM tracks t LEFT JOIN track_preferences p ON p.track_id = t.id AND p.user_id = :user
               WHERE t.id = ANY(:ids)"""
        ),
        {"user": user_id, "ids": list(sources)},
    )
    return [
        Candidate(
            track_id=r.id, navidrome_id=r.navidrome_id, title=r.title, artist=r.artist, artist_id=r.artist_id,
            album=r.album, album_id=r.album_id, genres=tuple(r.genres or ()), year=r.year, duration_s=r.duration_s,
            cover_art_id=r.cover_art_id, liked=r.liked, play_count=r.play_count, completed_count=r.completed_count,
            skip_count=r.skip_count, early_skip_count=r.early_skip_count, late_skip_count=r.late_skip_count,
            hours_since_played=float(r.hours) if r.hours is not None else None, sources=frozenset(sources[r.id]),
        )
        for r in rows
    ]


def track_out(c: Candidate) -> TrackOut:
    return TrackOut(
        id=c.navidrome_id, title=c.title, artist=c.artist, artist_id=c.artist_id, album=c.album, album_id=c.album_id,
        cover_art_id=c.cover_art_id, duration_seconds=c.duration_s, year=c.year, genres=list(c.genres), favorite=c.liked,
    )


def session_out(s: RadioSession) -> RadioSessionOut:
    state = s.state or {}
    mode = MODES.get(s.mode)
    label = s.display_name or (mode.label if mode else s.mode)
    return RadioSessionOut(
        id=s.id, mode=s.mode, mode_label=label, preset_id=str(s.preset_id) if s.preset_id else s.mode, status=s.status,
        seed_kind=(s.seed or {}).get("kind"), seed_name=(s.seed or {}).get("name"),
        skips=state.get("skips", 0), completions=state.get("completions", 0), exploration=round(state.get("exploration", 0.0), 2),
    )


async def _pick(db: AsyncSession, session: RadioSession, count: int, extra_exclude: set[int], rng: random.Random) -> list[RadioPick]:
    mode = profile_of(session)
    state = radio_session.SessionState.from_json(session.state, mode.base_exploration)
    profile = await load_profile(db, session.user_id)
    seed_json = (session.state or {}).get("_seed") or {}
    seed = Seed(
        name=(session.seed or {}).get("name"), track_id=session.seed_track_id, artist_id=seed_json.get("artist_id"),
        album_id=seed_json.get("album_id"), genres=frozenset(seed_json.get("genres", [])), year=seed_json.get("year"),
    )
    exclude = set(state.recent_track_ids) | extra_exclude | ({session.seed_track_id} if session.seed_track_id else set())
    candidates = await gather_candidates(db, session.user_id, mode, seed, profile, exclude, rng)
    recent = Recent(frozenset(exclude), tuple(state.recent_artist_ids), tuple(state.recent_album_ids), frozenset(state.last_genres))
    picks: list[Pick] = choose(candidates, count=count, mode=mode, seed=seed, profile=profile, session=state, recent=recent, rng=rng)

    position = (await db.scalar(select(func.coalesce(func.max(RadioQueueItem.position), 0)).where(RadioQueueItem.session_id == session.id))) or 0
    out: list[RadioPick] = []
    for pick in picks:
        c = pick.candidate
        why = reasons(c, pick.breakdown, seed, profile, mode)
        controls = (session.profile or {}).get("controls")
        if session.preset_id and controls:  # a custom preset: say what it leans towards
            why = [*why, *preset_reasons(session.display_name or mode.label, controls)][:4]
        position += 1
        item = RadioQueueItem(
            session_id=session.id, track_id=c.track_id, position=position, score=pick.score,
            score_breakdown={**pick.breakdown, "_sources": sorted(c.sources)}, reason=why[0], state_version=state.steer_version,
        )
        db.add(item)
        await db.flush()
        state = radio_session.on_pick(state, c.track_id, c.artist_id, c.album_id, list(c.genres))
        out.append(RadioPick(selection_id=item.id, track=track_out(c), reasons=why, score=pick.score, breakdown=pick.breakdown))
    session.state = {**state.to_json(), "_seed": seed_json}
    session.last_activity_at = func.now()
    return out


def profile_of(session: RadioSession) -> ModeProfile:
    """The profile a session plays with: its snapshot (custom presets), else its built-in mode."""
    if session.profile:
        return from_snapshot(session.profile, session.mode)
    return MODES[session.mode]


async def start(db: AsyncSession, user_id: int, mode_id: str, seed_kind: str | None, seed_id: str | None, count: int,
                rng: random.Random | None = None, *, display_name: str | None = None, preset_id: UUID | None = None,
                controls: dict | None = None) -> tuple[RadioSession, Candidate | None, list[RadioPick]]:
    if mode_id not in MODES:
        raise RadioError(f"Unknown radio mode “{mode_id}”.")
    rng = rng or random.Random()
    name = display_name or MODES[mode_id].label
    snap = snapshot(mode_id, controls, name) if controls is not None else None
    mode = from_snapshot(snap, mode_id) if snap else MODES[mode_id]
    profile = await load_profile(db, user_id)
    seed, seed_meta, seed_track_id = await resolve_seed(db, seed_kind, seed_id, profile, user_id)
    # End any other active session: one radio at a time.
    await db.execute(update(RadioSession).where(RadioSession.user_id == user_id, RadioSession.status == "active").values(status="ended", ended_at=func.now()))
    session = RadioSession(
        id=uuid4(), user_id=user_id, seed_track_id=seed_track_id, seed=seed_meta, mode=mode_id,
        preset_id=preset_id, display_name=name, profile=snap,
        state={**radio_session.SessionState(exploration=mode.base_exploration).to_json(),
               "_seed": {"artist_id": seed.artist_id, "album_id": seed.album_id, "genres": sorted(seed.genres), "year": seed.year}},
    )
    db.add(session)
    await db.flush()
    picks = await _pick(db, session, count, set(), rng)
    if not picks:
        await db.rollback()
        raise RadioError("PandaFM has no songs to choose from yet. Sync your library first.")
    seed_candidate = None
    if seed_track_id:
        seed_candidate = (await gather_seed(db, user_id, seed_track_id))
    await db.commit()
    return session, seed_candidate, picks


async def gather_seed(db: AsyncSession, user_id: int, track_id: int) -> Candidate | None:
    r = (await db.execute(text("SELECT t.*, coalesce(p.liked, false) AS liked FROM tracks t LEFT JOIN track_preferences p ON p.track_id = t.id AND p.user_id = :u WHERE t.id = :id"), {"u": user_id, "id": track_id})).first()
    if r is None:
        return None
    return Candidate(track_id=r.id, navidrome_id=r.navidrome_id, title=r.title, artist=r.artist, artist_id=r.artist_id, album=r.album, album_id=r.album_id,
                     genres=tuple(r.genres or ()), year=r.year, duration_s=r.duration_s, cover_art_id=r.cover_art_id, liked=r.liked)


async def get_session(db: AsyncSession, user_id: int, session_id: UUID, lock: bool = False) -> RadioSession:
    query = select(RadioSession).where(RadioSession.id == session_id, RadioSession.user_id == user_id)
    session = await db.scalar(query.with_for_update() if lock else query)
    if session is None:
        raise RadioError("That radio session doesn’t exist.")
    return session


async def extend(db: AsyncSession, user_id: int, session_id: UUID, upcoming: list[int], target: int, rng: random.Random | None = None) -> tuple[RadioSession, list[int], list[RadioPick]]:
    """Top the app's radio buffer back up to `target`, replacing queued picks the session has moved away from."""
    rng = rng or random.Random()
    session = await get_session(db, user_id, session_id, lock=True)
    if session.status != "active":
        raise RadioError("This radio session has ended.")
    steer_version = (session.state or {}).get("steer_version", 0)
    held = (await db.execute(select(RadioQueueItem).where(RadioQueueItem.session_id == session_id, RadioQueueItem.id.in_(upcoming or [0]), RadioQueueItem.status == "queued"))).scalars().all()
    stale = [item.id for item in held if item.state_version < steer_version]
    if stale:
        await db.execute(update(RadioQueueItem).where(RadioQueueItem.id.in_(stale)).values(status="replaced"))
    kept = [item for item in held if item.id not in stale]
    picks = await _pick(db, session, max(0, target - len(kept)), {item.track_id for item in kept}, rng)
    await db.commit()
    return session, stale, picks


async def end(db: AsyncSession, user_id: int, session_id: UUID) -> RadioSession:
    session = await get_session(db, user_id, session_id, lock=True)
    if session.status == "active":
        session.status = "ended"
        session.ended_at = func.now()
        await db.commit()
        await db.refresh(session)
    return session
