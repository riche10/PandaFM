import type { ComponentType } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { getFavorites, listAlbumsPage } from '../api/library'
import { AlbumCard, PlaylistCard, QuickTile, Shelf } from '../components/Cards'
import { ErrorNotice } from '../components/States'
import { TrackList } from '../components/TrackList'
import { Wordmark } from '../components/Wordmark'
import { useApi } from '../hooks/useApi'
import { useFavoritesVersion, usePlaylists } from '../library'
import { player } from '../player'

/**
 * Home is a list of independent sections, each loading its own data. Future
 * personal sections (Back in Rotation, Study Panda, Because You've Been
 * Listening To…) slot into HOME_SECTIONS without touching the others.
 */
const HOME_SECTIONS: { id: string; Section: ComponentType }[] = [
  { id: 'quick-access', Section: QuickAccess },
  { id: 'recently-played', Section: RecentlyPlayed },
  { id: 'recently-added', Section: RecentlyAdded },
  { id: 'favorite-songs', Section: FavoriteSongs },
  { id: 'playlists', Section: YourPlaylists },
  { id: 'random-albums', Section: RandomAlbums },
]

export function HomeView() {
  // Stage 2 kept searches at /?q=…; send old links to the Search page.
  const [params] = useSearchParams()
  const legacyQuery = params.get('q')
  if (legacyQuery) return <Navigate to={`/search?${new URLSearchParams({ q: legacyQuery })}`} replace />

  return (
    <div className="page page--home">
      <header className="home-header">
        <Wordmark size="small" />
      </header>
      {HOME_SECTIONS.map(({ id, Section }) => (
        <Section key={id} />
      ))}
    </div>
  )
}

function QuickAccess() {
  return (
    <nav className="quick-grid" aria-label="Quick access">
      <QuickTile to="/favorites" icon="heart" label="Favorites" tone="linear-gradient(135deg, #4a2a3a, #23161d)" />
      <QuickTile to="/library/albums?sort=newest" icon="clock" label="Recently added" tone="linear-gradient(135deg, #2c3a4a, #161c24)" />
      <QuickTile to="/library/albums?sort=random" icon="shuffle" label="Random albums" tone="linear-gradient(135deg, #3d3a26, #1f1d14)" />
      <QuickTile to="/library/artists" icon="artist" label="Artists" tone="linear-gradient(135deg, #2a3d33, #151f1a)" />
      <QuickTile to="/library/songs" icon="music" label="Songs" tone="linear-gradient(135deg, #3a2f4a, #1c1725)" />
      <QuickTile to="/library/playlists" icon="playlist" label="Playlists" tone="linear-gradient(135deg, #46332a, #221915)" />
    </nav>
  )
}

function AlbumShelf({ kind, title, to, hideWhenEmpty }: { kind: 'recent' | 'newest' | 'random'; title: string; to?: string; hideWhenEmpty?: boolean }) {
  const [resource, retry] = useApi(`home:${kind}`, (signal) => listAlbumsPage(kind, 0, 12, signal))
  if (resource.state === 'loading') return null
  if (resource.state === 'error') {
    return hideWhenEmpty ? null : (
      <Shelf title={title}>
        <ErrorNotice error={resource.error} onRetry={retry} />
      </Shelf>
    )
  }
  if (resource.data.albums.length === 0 && hideWhenEmpty) return null
  return (
    <Shelf title={title} to={to}>
      {resource.data.albums.map((album) => (
        <AlbumCard key={album.id} album={album} />
      ))}
    </Shelf>
  )
}

// Navidrome's own play history. PandaFM doesn't report plays to Navidrome
// yet, so this only fills from other Navidrome clients until listening
// history arrives; with nothing to show, the section stays out of the way.
function RecentlyPlayed() {
  return <AlbumShelf kind="recent" title="Recently played" hideWhenEmpty />
}

function RecentlyAdded() {
  return <AlbumShelf kind="newest" title="Recently added" to="/library/albums?sort=newest" />
}

function RandomAlbums() {
  return <AlbumShelf kind="random" title="Something different" to="/library/albums?sort=random" />
}

function FavoriteSongs() {
  const version = useFavoritesVersion()
  const [resource] = useApi(`home:favorites:${version}`, (signal) => getFavorites(signal))
  const data = resource.state === 'ready' ? resource.data : resource.state === 'loading' ? resource.previous : undefined
  if (!data) return null
  const tracks = data.tracks.slice(0, 5)

  return (
    <section className="shelf" aria-label="Favorite songs">
      <div className="section-head">
        <h2 className="section-title">
          <Link to="/favorites">Favorite songs</Link>
        </h2>
        {data.tracks.length > 0 && (
          <Link to="/favorites" className="show-all">
            Show all
          </Link>
        )}
      </div>
      {tracks.length > 0 ? (
        <TrackList tracks={tracks} onPlay={(i) => player.playCollection(data.tracks, { startIndex: i, source: { kind: 'favorites', name: 'Favorites' } })} header={false} />
      ) : (
        <p className="hint">Tap the heart on any song and it will wait for you here.</p>
      )}
    </section>
  )
}

function YourPlaylists() {
  const all = usePlaylists()
  if (all.length === 0) return null
  return (
    <Shelf title="Your playlists" to="/library/playlists">
      {all.slice(0, 12).map((playlist) => (
        <PlaylistCard key={playlist.id} playlist={playlist} />
      ))}
    </Shelf>
  )
}
