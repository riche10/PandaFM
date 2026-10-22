import { Link, useParams } from 'react-router'
import { type Album, getAlbum } from '../api/library'
import { Cover } from '../components/Cover'
import { ErrorNotice } from '../components/ErrorNotice'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { useApi } from '../hooks/useApi'
import { player } from '../player'

export function AlbumView() {
  const { albumId = '' } = useParams()
  const [resource, retry] = useApi(`album:${albumId}`, (signal) => getAlbum(albumId, signal))

  return (
    <main className="page">
      <PageHeader />
      {resource.state === 'error' ? (
        <ErrorNotice error={resource.error} onRetry={resource.error.status === 404 ? undefined : retry} />
      ) : resource.state === 'loading' ? (
        <p className="hint">Loading album…</p>
      ) : (
        <AlbumDetail album={resource.data} />
      )}
    </main>
  )
}

function AlbumDetail({ album }: { album: Album }) {
  const facts = [
    album.year,
    album.track_count ? (album.track_count === 1 ? '1 song' : `${album.track_count} songs`) : null,
    album.duration_seconds ? formatLength(album.duration_seconds) : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <>
      <div className="hero">
        <Cover coverArtId={album.cover_art_id} size={600} className="hero-cover" />
        <div className="hero-text">
          <h1 className="page-title">{album.name}</h1>
          <p className="hero-subtitle">
            {album.artist_id ? <Link to={`/artists/${encodeURIComponent(album.artist_id)}`}>{album.artist}</Link> : album.artist}
          </p>
          {facts && <p className="hero-facts">{facts}</p>}
          <button
            type="button"
            className="button"
            onClick={() => player.playTracks(album.tracks, 0)}
            disabled={album.tracks.length === 0}
          >
            <Icon name="play" />
            Play album
          </button>
        </div>
      </div>
      <TrackList
        tracks={album.tracks}
        variant="album"
        albumArtist={album.artist}
        onPlay={(i) => player.playTracks(album.tracks, i)}
      />
    </>
  )
}

function formatLength(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
}
