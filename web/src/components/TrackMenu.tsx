import { useNavigate } from 'react-router'
import type { PlaylistSummary, Track } from '../api/library'
import { openDialog } from '../dialogs/store'
import { playlists, toast, toggleFavorite, useFavorite } from '../library'
import { startRadio } from '../library/play'
import { player, playerStore } from '../player'
import { offline, useOfflineTrack } from '../offline'
import { isNative } from '../platform/state'
import { Cover } from './Cover'
import { QualityBadge } from './QualityBadge'
import { MenuButton, MenuItem } from './Menu'

export interface PlaylistContext {
  playlist: PlaylistSummary
  index: number
  /** 5.5.2: its position in the Panda Mix order, when removed from there */
  mixIndex?: number
  onRemoved?: () => void
}

export function TrackMenu({ track, onPlay, inPlaylist }: { track: Track; onPlay: () => void; inPlaylist?: PlaylistContext }) {
  const navigate = useNavigate()
  const favorite = useFavorite('track', track.id, track.favorite)
  const local = useOfflineTrack(track.id)

  const removeFromPlaylist = async (context: PlaylistContext) => {
    try {
      await playlists().removeTrack(context.playlist.id, context.index, track.id, context.mixIndex)
      context.onRemoved?.()
      toast(`Removed from ${context.playlist.name}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Couldn’t remove the song.', 'error')
    }
  }

  return (
    <MenuButton
      label={`More options for ${track.title}`}
      className="track-menu"
      header={
        <div className="menu-header">
          <Cover coverArtId={track.cover_art_id} size={96} className="menu-header-art" />
          <span className="menu-header-text">
            <span className="menu-header-title">{track.title}</span>
            <span className="menu-header-sub">{track.artist}</span>
            <QualityBadge track={track} />
          </span>
        </div>
      }
    >
      {(close) => {
        const run = (action: () => void) => () => {
          close()
          action()
        }
        return (
          <>
            <MenuItem icon="play" label="Play" onSelect={run(onPlay)} />
            <MenuItem icon="playNext" label="Play next" onSelect={run(() => { player.playNext([track]); toast(`“${track.title}” will play next`) })} />
            <MenuItem icon="queue" label="Add to queue" onSelect={run(() => { player.addToQueue([track]); toast(`Added “${track.title}” to the queue`) })} />
            <MenuItem
              icon={favorite ? 'heart' : 'heartOutline'}
              label={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
              onSelect={run(() => void toggleFavorite('track', track.id, favorite))}
            />
            <MenuItem icon="playlist" label="Add to playlist" onSelect={run(() => openDialog({ type: 'add-to-playlist', tracks: [track] }))} />
            <MenuItem icon="info" label="Info" onSelect={run(() => openDialog({ type: 'track-info', track }))} />
            <MenuItem
              icon="radio"
              label="Start Panda Radio"
              onSelect={run(() => {
                // From the song that's playing: keep it going and let radio follow.
                const s = playerStore.getState()
                const keepCurrent = s.items[s.index]?.track.id === track.id
                void startRadio('panda', { kind: 'track', id: track.id, name: track.title }, { keepCurrent })
              })}
            />
            {inPlaylist && !inPlaylist.playlist.readonly && (
              <MenuItem icon="trash" label="Remove from this playlist" onSelect={run(() => void removeFromPlaylist(inPlaylist))} />
            )}
            {isNative() && !local && (
              <MenuItem icon="download" label="Download" onSelect={run(() => openDialog({ type: 'download', target: { kind: 'track', id: track.id, name: track.title } }))} />
            )}
            {isNative() && local && (
              <MenuItem
                icon="trash"
                label="Remove download (keeps it on the server)"
                onSelect={run(() => void offline()?.removeTrack(track.id).then(() => toast('Removed from this device. It’s still in your library.')))}
              />
            )}
            {track.album_id && (
              <MenuItem icon="album" label="View album" onSelect={run(() => navigate(`/albums/${encodeURIComponent(track.album_id!)}`))} />
            )}
            {track.artist_id && (
              <MenuItem icon="artist" label="View artist" onSelect={run(() => navigate(`/artists/${encodeURIComponent(track.artist_id!)}`))} />
            )}
          </>
        )
      }}
    </MenuButton>
  )
}
