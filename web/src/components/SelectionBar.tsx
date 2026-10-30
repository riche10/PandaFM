import { removalPlan } from '../library/playlistRemoval'
import type { PlaylistSummary, Track } from '../api/library'
import { openDialog } from '../dialogs/store'
import { favoritesStore, playlists, toast, toggleFavorite } from '../library'
import { isFavorite } from '../library/favorites'
import { descending, pick, type Selection } from '../library/selection'
import { offline, useOffline } from '../offline'
import { player } from '../player'
import { isNative } from '../platform/state'
import { Icon } from './Icon'
import { MenuButton, MenuItem } from './Menu'

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`

/** What you can do with the selected songs (5.3). Each action is the one-song menu's own, applied to all of them. */
export function SelectionBar({ selection, tracks, playlist, playlistIndexes, mixed, onRemoved, onClear, onSelectAll }: {
  selection: Selection
  tracks: Track[]
  playlist?: PlaylistSummary
  playlistIndexes?: number[]
  mixed?: boolean
  onRemoved?: () => void
  onClear: () => void
  onSelectAll: () => void
}) {
  const chosen = pick(selection, tracks)
  const downloaded = useOffline((s) => chosen.filter((t) => !!s.tracks?.[t.id]).length)
  if (chosen.length === 0) return null
  const allFavorite = chosen.every((t) => isFavorite(favoritesStore.getState(), 'track', t.id, !!t.favorite))
  const done = (message: string) => {
    toast(message)
    onClear()
  }
  const favorite = async () => {
    const targets = allFavorite ? chosen : chosen.filter((t) => !isFavorite(favoritesStore.getState(), 'track', t.id, !!t.favorite))
    await Promise.allSettled(targets.map((t) => toggleFavorite('track', t.id, allFavorite)))
    done(allFavorite ? `Removed ${songs(targets.length)} from Favorites` : `Added ${songs(targets.length)} to Favorites`)
  }
  const removeFromPlaylist = async (p: PlaylistSummary) => {
    let failed = 0
    // highest playlist positions first (the rest stay valid); from the Panda Mix order, each row's own
    // playlist position and its mixed position (5.5.2)
    for (const r of removalPlan(descending(selection), tracks.map((t) => t.id), playlistIndexes, mixed)) {
      try {
        await playlists().removeTrack(p.id, r.index, r.trackId, r.mixIndex)
      } catch {
        failed++
      }
    }
    onRemoved?.()
    done(failed ? `Couldn’t remove ${songs(failed)} from ${p.name}` : `Removed ${songs(chosen.length)} from ${p.name}`)
  }
  const removeDownloads = async () => {
    const count = downloaded
    for (const t of chosen) await offline()?.removeTrack(t.id).catch(() => undefined)
    done(`Removed ${songs(count)} from this device (still in your library)`)
  }
  const selectAllButton = chosen.length < tracks.length
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected songs">
      <span className="selection-count">{chosen.length} selected</span>
      <button type="button" className="button" onClick={() => { player.playCollection(chosen, { source: { kind: 'tracks', name: 'Selected songs' } }); onClear() }}>
        <Icon name="play" /> Play
      </button>
      <button type="button" className="button button--quiet" onClick={() => { player.playNext(chosen); done(`${songs(chosen.length)} will play next`) }}>Play next</button>
      <button type="button" className="button button--quiet" onClick={() => { player.addToQueue(chosen); done(`Added ${songs(chosen.length)} to the queue`) }}>Queue</button>
      <button type="button" className="button button--quiet" onClick={() => { openDialog({ type: 'add-to-playlist', tracks: chosen }); onClear() }}>Playlist</button>
      {isNative() && (
        <button type="button" className="button button--quiet" onClick={() => { openDialog({ type: 'download', target: { kind: 'tracks', id: null, ids: chosen.map((t) => t.id), name: songs(chosen.length) } }); onClear() }}>
          Download
        </button>
      )}
      <MenuButton label="More actions for the selected songs">
        {(close) => (
          <>
            <MenuItem icon={allFavorite ? 'paw' : 'pawOutline'} label={allFavorite ? 'Remove from Favorites' : 'Add to Favorites'} onSelect={() => { close(); void favorite() }} />
            {isNative() && downloaded > 0 && <MenuItem icon="trash" label="Remove downloads (keeps them on the server)" onSelect={() => { close(); void removeDownloads() }} />}
            {playlist && !playlist.readonly && <MenuItem icon="trash" label={`Remove from ${playlist.name} (the songs stay in your library)`} onSelect={() => { close(); void removeFromPlaylist(playlist) }} />}
            {selectAllButton && <MenuItem icon="check" label="Select all" onSelect={() => { close(); onSelectAll() }} />}
          </>
        )}
      </MenuButton>
      <span className="selection-spacer" />
      <button type="button" className="button button--quiet" onClick={onClear} aria-label="Clear selection">Clear</button>
    </div>
  )
}
