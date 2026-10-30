"""Playlists, stored in Navidrome.

Changes return the updated playlist so the web app can show it without a
second request. Songs are removed by position plus the song id expected
there, because Subsonic only supports removal by position.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Query, Response

from app.deps import ItemId, NavidromeDep, SessionDep, UserId
from app.services.favorites import with_likes
from app.schemas.library import (
    Playlist,
    PlaylistAddTracks,
    PlaylistCreate,
    PlaylistList,
    PlaylistRename,
)

router = APIRouter(tags=["playlists"])


@router.get("/playlists", response_model=PlaylistList)
async def list_playlists(navidrome: NavidromeDep) -> PlaylistList:
    return PlaylistList(playlists=await navidrome.get_playlists())


@router.post("/playlists", response_model=Playlist, status_code=201)
async def create_playlist(body: PlaylistCreate, navidrome: NavidromeDep) -> Playlist:
    return await navidrome.create_playlist(body.name, body.track_ids)


@router.get("/playlists/{playlist_id}", response_model=Playlist)
async def get_playlist(playlist_id: ItemId, navidrome: NavidromeDep, db: SessionDep, user_id: UserId) -> Playlist:
    return await with_likes(db, user_id, await navidrome.get_playlist(playlist_id))


@router.patch("/playlists/{playlist_id}", response_model=Playlist)
async def rename_playlist(playlist_id: ItemId, body: PlaylistRename, navidrome: NavidromeDep) -> Playlist:
    await navidrome.rename_playlist(playlist_id, body.name)
    return await navidrome.get_playlist(playlist_id)


@router.delete("/playlists/{playlist_id}", status_code=204)
async def delete_playlist(playlist_id: ItemId, navidrome: NavidromeDep) -> Response:
    await navidrome.delete_playlist(playlist_id)
    return Response(status_code=204)


@router.post("/playlists/{playlist_id}/tracks", response_model=Playlist)
async def add_tracks(playlist_id: ItemId, body: PlaylistAddTracks, navidrome: NavidromeDep, db: SessionDep, user_id: UserId) -> Playlist:
    await navidrome.add_to_playlist(playlist_id, body.track_ids)
    return await with_likes(db, user_id, await navidrome.get_playlist(playlist_id))


@router.delete("/playlists/{playlist_id}/tracks/{index}", response_model=Playlist)
async def remove_track(
    playlist_id: ItemId,
    index: Annotated[int, Path(ge=0, le=100_000)],
    track_id: Annotated[str, Query(min_length=1, max_length=200, description="Song expected at that position")],
    navidrome: NavidromeDep,
    db: SessionDep,
    user_id: UserId,
    mix_index: Annotated[int | None, Query(ge=0, le=100_000, description="5.5.2: its position in the Panda Mix order, when removed from there")] = None,
) -> Playlist:
    await navidrome.remove_from_playlist(playlist_id, index, track_id)  # by its position in the playlist itself
    if mix_index is not None:
        from app.services import mix_playlists

        await mix_playlists.remove_occurrence(db, user_id, playlist_id, mix_index, track_id)
    return await with_likes(db, user_id, await navidrome.get_playlist(playlist_id))
