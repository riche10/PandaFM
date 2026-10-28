"""Persistent Panda Mix playlists (5.3).

Turning Panda Mix on for a playlist is the only thing that analyses a whole
playlist. Until every song is analysed the mixed order is the playlist's own
order; then it is optimised once and stays stable: later playlist edits insert
new songs where they fit and drop removed ones, without reshuffling the rest.
Remix draws a new order on purpose. Navidrome's playlist is never modified.
"""

import random
from collections import Counter

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.mix import order as mix_order
from app.models import MixPlaylist
from app.services.mix import MixAnalyzer, usable_analyses

MODES = ("auto", "gentle", "flow", "energetic")
PRIORITY = 50  # behind the songs about to play


def _meta(tracks) -> dict[str, dict]:
    return {t.id: {"album_id": t.album_id, "track_number": t.track_number} for t in tracks}


async def _row(db: AsyncSession, user_id: int, playlist_id: str) -> MixPlaylist | None:
    return (await db.execute(select(MixPlaylist).where(MixPlaylist.user_id == user_id, MixPlaylist.playlist_id == playlist_id))).scalar_one_or_none()


async def state(db: AsyncSession, navidrome, analyzer: MixAnalyzer | None, user_id: int, playlist_id: str) -> dict:
    row = await _row(db, user_id, playlist_id)
    if row is None or not row.enabled:
        return {"playlist_id": playlist_id, "enabled": False}
    playlist = await navidrome.get_playlist(playlist_id)
    playlist_ids = [t.id for t in playlist.tracks]
    ids = list(dict.fromkeys(playlist_ids))  # analyse identical audio once, even if the playlist repeats it
    found = await usable_analyses(db, ids)
    ready = {i: f["payload"] for i, f in found.items() if f["status"] == "ready"}
    if analyzer is not None:
        for k, i in enumerate(ids):
            if i not in found:
                analyzer.schedule(i, PRIORITY + k)
    analysed = sum(1 for i in playlist_ids if i in found)

    # Reconcile the saved order as a multiset. A playlist may intentionally
    # contain the same song twice; never collapse those occurrences.
    remaining = Counter(playlist_ids)
    order = []
    for i in row.mixed_order:
        if remaining[i] > 0:
            order.append(i)
            remaining[i] -= 1

    meta = _meta(playlist.tracks)
    if row.status == "preparing" and all(i in found for i in ids):
        order = mix_order.mixed_order(playlist_ids, meta, ready, row.seed, current=row.mixed_order)  # optimised once, then stable
        row.status = "ready"
    else:
        missing = Counter(playlist_ids)
        for i in order:
            missing[i] -= 1
        for i in playlist_ids:
            if missing[i] > 0:
                order = mix_order.insert(order, i, meta, ready) if row.status == "ready" else order + [i]
                missing[i] -= 1
    if order != row.mixed_order:
        row.mixed_order = order
    await db.commit()
    return {"playlist_id": playlist_id, "enabled": True, "mode": row.mode, "status": row.status, "analysed": sum(1 for i in ids if i in found),
            "total": len(ids), "order": order, "seed": row.seed, "facts": {i: _facts(i, found, analyzer) for i in ids},
            "why": [{"from": a, "to": b, "reasons": mix_order.explain(meta.get(a, {}), meta.get(b, {}), ready.get(a), ready.get(b))}
                    for a, b in zip(order, order[1:])]}


def _facts(track_id: str, found: dict, analyzer: MixAnalyzer | None) -> dict:
    """What the playlist can show for a song: only values Panda is confident about."""
    f = found.get(track_id)
    if f is None:
        state = (analyzer.state_of(track_id) if analyzer else None) or "pending"
        return {"status": "analysing" if state == "running" else state}
    if f["status"] != "ready" or not f["payload"]:
        return {"status": "failed"}
    a = f["payload"]
    bpm_ok = (a.get("bpm_confidence") or 0) >= 0.4 and a.get("bpm")
    key_ok = (a.get("key_confidence") or 0) >= 0.3 and a.get("key_camelot")
    return {"status": "ready", "bpm": round(a["bpm"]) if bpm_ok else None, "key": a.get("key") if key_ok else None,
            "camelot": a.get("key_camelot") if key_ok else None, "lufs": a.get("integrated_lufs")}


async def enable(db: AsyncSession, navidrome, analyzer, user_id: int, playlist_id: str, mode: str) -> dict:
    mode = mode if mode in MODES else "auto"
    row = await _row(db, user_id, playlist_id)
    if row is None:
        playlist = await navidrome.get_playlist(playlist_id)
        db.add(MixPlaylist(user_id=user_id, playlist_id=playlist_id, enabled=True, mode=mode, seed=0, status="preparing",
                           mixed_order=[t.id for t in playlist.tracks]))
    else:
        row.enabled = True
        row.mode = mode  # a new personality changes the transitions, not the order
    await db.commit()
    return await state(db, navidrome, analyzer, user_id, playlist_id)


async def remix(db: AsyncSession, navidrome, analyzer, user_id: int, playlist_id: str) -> dict:
    row = await _row(db, user_id, playlist_id)
    if row is None or not row.enabled:
        return {"playlist_id": playlist_id, "enabled": False}
    row.seed = random.randint(1, 2**31 - 1)
    row.status = "preparing"  # recomputed (once) as soon as every song is analysed: usually at once
    await db.commit()
    return await state(db, navidrome, analyzer, user_id, playlist_id)


async def disable(db: AsyncSession, user_id: int, playlist_id: str) -> None:
    row = await _row(db, user_id, playlist_id)
    if row is not None:
        row.enabled = False  # analyses stay cached; turning it back on is quick
        await db.commit()


async def enabled_ids(db: AsyncSession, user_id: int) -> list[dict]:
    rows = (await db.execute(select(MixPlaylist).where(MixPlaylist.user_id == user_id, MixPlaylist.enabled.is_(True)))).scalars().all()
    return [{"playlist_id": r.playlist_id, "mode": r.mode, "status": r.status} for r in rows]
