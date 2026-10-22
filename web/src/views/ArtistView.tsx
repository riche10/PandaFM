import { useParams } from 'react-router'
import { getArtist } from '../api/library'
import { AlbumGrid } from '../components/AlbumGrid'
import { albumCount } from '../components/ArtistList'
import { Cover } from '../components/Cover'
import { ErrorNotice } from '../components/ErrorNotice'
import { PageHeader } from '../components/PageHeader'
import { useApi } from '../hooks/useApi'

export function ArtistView() {
  const { artistId = '' } = useParams()
  const [resource, retry] = useApi(`artist:${artistId}`, (signal) => getArtist(artistId, signal))

  return (
    <main className="page">
      <PageHeader />
      {resource.state === 'error' ? (
        <ErrorNotice error={resource.error} onRetry={resource.error.status === 404 ? undefined : retry} />
      ) : resource.state === 'loading' ? (
        <p className="hint">Loading artist…</p>
      ) : (
        <>
          <div className="artist-hero">
            <Cover coverArtId={resource.data.cover_art_id} size={300} className="artist-hero-avatar" />
            <div>
              <h1 className="page-title">{resource.data.name}</h1>
              <p className="hero-facts">{albumCount(resource.data.albums.length)}</p>
            </div>
          </div>
          <AlbumGrid albums={resource.data.albums} subtitle="year" />
        </>
      )}
    </main>
  )
}
