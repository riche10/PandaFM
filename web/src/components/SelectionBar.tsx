import type { PlaylistSummary, Track } from '../api/library'
import { openDialog } from '../dialogs/store'
import { favoritesStore, playlists, toast, toggleFavorite } from '../library'
import { isFavorite } from '../library/favorites'
import { descending, pick, type Selection } from '../library/selection'
import { offline, useOffline } from '../offline'
import { player } from '../player'
import { isNative } from '../platform/state'
import { Icon } from './Icon'

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`

/** What you can do with the selected songs (5.3). Each action is the one-song menu's own, applied to all of them. */
export function SelectionBar({ selection, tracks, playlist, onClear, onSelectAll }: {
  selection: Selection
  tracks: Track[]
  playlist?: PlaylistSummary
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
    for (const index of descending(selection)) { // highest first: the remaining positions stay valid
      try {
        await playlists().removeTrack(p.id, index, tracks[index].id)
      } catch {
        failed++
      }
    }
    done(failed ? `Couldn’t remove ${songs(failed)} from ${p.name}` : `Removed ${songs(chosen.length)} from ${p.name}`)
  }
  const removeDownloads = async () => {
    const count = downloaded
    for (const t of chosen) await offline()?.removeTrack(t.id).catch(() => undefined)
    done(`Removed ${songs(count)} from this device (still in your library)`)
  }
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected songs">
      <span className="selection-count">{songs(chosen.length)} selected</span>
      <button type="button" className="button" onClick={() => { player.playCollection(chosen, { source: { kind: 'tracks', name: 'Selected songs' } }); onClear() }}>
        <Icon name="play" /> Play
      </button>
      <button type="button" className="button button--quiet" onClick={() => { player.playNext(chosen); done(`${songs(chosen.length)} will play next`) }}>Play next</button>
      <button type="button" className="button button--quiet" onClick={() => { player.addToQueue(chosen); done(`Added ${songs(chosen.length)} to the queue`) }}>Add to queue</button>
      <button type="button" className="button button--quiet" onClick={() => { openDialog({ type: 'add-to-playlist', tracks: chosen }); onClear() }}>Add to playlist</button>
      <button type="button" className="button button--quiet" onClick={() => void favorite()}>{allFavorite ? 'Remove from Favorites' : 'Add to Favorites'}</button>
      {isNative() && (
        <button type="button" className="button button--quiet" onClick={() => { openDialog({ type: 'download', target: { kind: 'tracks', id: null, ids: chosen.map((t) => t.id), name: songs(chosen.length) } }); onClear() }}>
          Download
        </button>
      )}
      {isNative() && downloaded > 0 && <button type="button" className="button button--quiet" onClick={() => void removeDownloads()}>Remove downloads</button>}
      {playlist && !playlist.readonly && <button type="button" className="button button--quiet" onClick={() => void removeFromPlaylist(playlist)}>Remove from {playlist.name}</button>}
      <span className="selection-spacer" />
      {chosen.length < tracks.length && <button type="button" className="button button--quiet" onClick={onSelectAll}>Select all</button>}
      <button type="button" className="button button--quiet" onClick={onClear} aria-label="Clear selection">Clear</button>
    </div>
  )
}
