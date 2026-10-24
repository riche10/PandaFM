import { useState } from 'react'
import { Cover } from '../components/Cover'
import { Icon } from '../components/Icon'
import { formatBytes } from '../components/QualityBadge'
import { EmptyState } from '../components/States'
import { TrackList } from '../components/TrackList'
import { toast } from '../library'
import { collectionProgress, offline, useOffline } from '../offline'
import type { OfflineCollection } from '../offline/types'
import { player } from '../player'

const FILTERS = [
  { id: 'playlist', label: 'Playlists' },
  { id: 'album', label: 'Albums' },
  { id: 'tracks', label: 'Songs' },
] as const

/** Everything on this device, with progress, sync and removal. */
export function OfflineView() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('playlist')
  const collections = useOffline((s) => Object.values(s.collections))
  const tracks = useOffline((s) => Object.values(s.tracks))
  const paused = useOffline((s) => s.paused)
  const downloaded = tracks.filter((t) => t.status === 'downloaded')
  const failed = tracks.filter((t) => t.status === 'failed').length
  const used = downloaded.reduce((sum, t) => sum + (t.sizeBytes ?? 0), 0)
  const busy = tracks.some((t) => t.status === 'queued' || t.status === 'downloading')
  const shown = collections.filter((c) => (filter === 'playlist' ? c.kind === 'playlist' || c.kind === 'favorites' : c.kind === filter))

  return (
    <div className="page page--offline">
      <h1 className="page-title">Downloaded</h1>
      <p className="hint">
        {downloaded.length} songs · {formatBytes(used)} on this device
        {failed ? ` · ${failed} failed` : ''}
      </p>
      <div className="offline-actions">
        {busy && (
          <button type="button" className="button button--quiet" onClick={() => void (paused ? offline()?.resume() : offline()?.pause())}>
            {paused ? 'Resume downloads' : 'Pause downloads'}
          </button>
        )}
        {failed > 0 && <button type="button" className="button button--quiet" onClick={() => void offline()?.retryFailed()}>Retry failed</button>}
        <button type="button" className="button button--quiet" onClick={() => void offline()?.syncAll().then(() => toast('Checked kept downloads for changes'))}>Sync now</button>
      </div>
      <div className="chips" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      {filter === 'tracks' ? (
        downloaded.length ? (
          <TrackList tracks={downloaded.map((t) => t.track)} onPlay={(i) => player.playCollection(downloaded.map((t) => t.track), { startIndex: i, source: { kind: 'tracks', name: 'Downloaded' } })} />
        ) : (
          <EmptyState icon="download" title="Nothing downloaded yet">
            <p>Use Download on an album, playlist, Favorites or any song’s menu.</p>
          </EmptyState>
        )
      ) : shown.length ? (
        <ul className="offline-list">
          {shown.map((c) => <CollectionRow key={c.key} collection={c} />)}
        </ul>
      ) : (
        <EmptyState icon="download" title={`No downloaded ${filter === 'album' ? 'albums' : 'playlists'}`} />
      )}
    </div>
  )
}

function CollectionRow({ collection }: { collection: OfflineCollection }) {
  const progress = useOffline((s) => collectionProgress(s, collection.key))
  const tracks = useOffline((s) => collection.trackIds.map((id) => s.tracks[id]).filter(Boolean))
  if (!progress) return null
  const complete = progress.done === progress.total
  const play = () => player.playCollection(tracks.map((t) => t.track), { source: { kind: collection.kind === 'album' ? 'album' : 'playlist', name: collection.name } })
  return (
    <li className="offline-row">
      <button type="button" className="offline-play" onClick={play} aria-label={`Play ${collection.name}`}>
        <Cover coverArtId={collection.coverArtId} size={96} className="offline-art" />
      </button>
      <div className="offline-text">
        <span className="offline-name">{collection.kind === 'favorites' ? 'Favorites' : collection.name}</span>
        <span className="offline-meta">
          {complete ? `${progress.total} songs · ${formatBytes(progress.bytesDone)}` : `${progress.done} / ${progress.total} songs · ${formatBytes(progress.bytesDone)}${progress.bytesTotal ? ` / ${formatBytes(progress.bytesTotal)}` : ''}`}
          {collection.keepSynced ? ' · kept in sync' : ''}
          {progress.failed ? ` · ${progress.failed} failed` : ''}
        </span>
        {!complete && <progress className="offline-progress" max={progress.total} value={progress.done} />}
        {progress.current && <span className="offline-meta">Now: {progress.current}</span>}
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label={`Remove the download of ${collection.name} (keeps it on the server)`}
        onClick={() => {
          if (window.confirm(`Remove ${collection.name} from this device? It stays in your library, and songs another download needs are kept.`)) {
            void offline()?.removeCollection(collection.key).then(() => toast('Removed from this device'))
          }
        }}
      >
        <Icon name="trash" />
      </button>
    </li>
  )
}
