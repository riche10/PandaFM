import { listArtists } from '../api/library'
import { ArtistList } from '../components/ArtistList'
import { ErrorNotice } from '../components/ErrorNotice'
import { PageHeader } from '../components/PageHeader'
import { useApi } from '../hooks/useApi'

export function ArtistsView() {
  const [resource, retry] = useApi('artists', (signal) => listArtists(signal))

  return (
    <main className="page">
      <PageHeader />
      <h1 className="page-title">Artists</h1>
      {resource.state === 'error' ? (
        <ErrorNotice error={resource.error} onRetry={retry} />
      ) : resource.state === 'loading' ? (
        <p className="hint">Loading artists…</p>
      ) : resource.data.artists.length === 0 ? (
        <p className="hint">Navidrome hasn’t found any artists yet.</p>
      ) : (
        <ArtistList artists={resource.data.artists} />
      )}
    </main>
  )
}
