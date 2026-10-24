import { type ComponentType, useMemo } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { getFavorites, listAlbumsPage, listArtists, listTracks, type Track } from '../api/library'
import { getHomeSections } from '../api/radio'
import { AlbumCard, ArtistCard, PlaylistCard, QuickTile, Shelf, TrackCard } from '../components/Cards'
import { Cover } from '../components/Cover'
import { Icon, type IconName } from '../components/Icon'
import { ErrorNotice } from '../components/States'
import { TrackList } from '../components/TrackList'
import { Wordmark } from '../components/Wordmark'
import { useApi } from '../hooks/useApi'
import { toast, useFavoritesVersion, usePlaylists } from '../library'
import { startRadio } from '../library/play'
import { player, useRadio } from '../player'

/**
 * Home is a list of independent sections, each loading its own data. Future
 * personal sections (Back in Rotation, Study Panda, Because You've Been
 * Listening To…) slot into HOME_SECTIONS without touching the others.
 */
const HOME_SECTIONS: { id: string; Section: ComponentType }[] = [
  { id: 'quick-access', Section: QuickAccess },
  { id: 'panda-modes', Section: PandaModes },
  { id: 'history', Section: HistorySections },
  { id: 'recently-added', Section: RecentlyAdded },
  { id: 'favorites', Section: FavoriteSections },
  { id: 'playlists', Section: YourPlaylists },
  { id: 'artists', Section: ArtistsShelf },
  { id: 'random-albums', Section: RandomAlbums },
]

function greeting(hour = new Date().getHours()): string {
  if (hour < 5) return 'Good night'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function HomeView() {
  // Stage 2 kept searches at /?q=…; send old links to the Search page.
  const [params] = useSearchParams()
  const legacyQuery = params.get('q')
  if (legacyQuery) return <Navigate to={`/search?${new URLSearchParams({ q: legacyQuery })}`} replace />

  return (
    <div className="page page--home">
      <header className="home-header">
        <Wordmark size="small" heading={false} />
        <Link to="/settings" className="icon-button" aria-label="Settings">
          <Icon name="settings" />
        </Link>
      </header>
      <h1 className="greeting">{greeting()}</h1>
      {HOME_SECTIONS.map(({ id, Section }) => (
        <Section key={id} />
      ))}
    </div>
  )
}

const TONES = {
  favorites: 'linear-gradient(135deg, #8a3a5a, #2a1620)',
  playlists: 'linear-gradient(135deg, #6b4a32, #241912)',
  random: 'linear-gradient(135deg, #5c5531, #1f1d14)',
  artists: 'linear-gradient(135deg, #2f5a45, #151f1a)',
  shuffle: 'linear-gradient(135deg, #4a3a6b, #1c1725)',
  newest: 'linear-gradient(135deg, #2c4a6b, #161c24)',
}

function QuickAccess() {
  const navigate = useNavigate()
  const [newest] = useApi('home:newest-one', (signal) => listAlbumsPage('newest', 0, 1, signal))
  const latest = newest.state === 'ready' ? newest.data.albums[0] : undefined

  const randomAlbum = async () => {
    try {
      const { albums } = await listAlbumsPage('random', 0, 1)
      if (albums[0]) navigate(`/albums/${encodeURIComponent(albums[0].id)}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Couldn’t pick an album.', 'error')
    }
  }

  const shuffleLibrary = async () => {
    try {
      const { tracks } = await listTracks('random', 0, 200)
      player.playCollection(tracks, { source: { kind: 'songs', name: 'Your library, shuffled' } })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Couldn’t shuffle your library.', 'error')
    }
  }

  return (
    <nav className="quick-grid" aria-label="Quick access">
      <QuickTile to="/favorites" icon="heart" label="Favorites" tone={TONES.favorites} />
      <QuickTile to="/library/playlists" icon="playlist" label="Playlists" tone={TONES.playlists} />
      <QuickTile
        to="/library/albums?sort=newest"
        icon="clock"
        label="Recently added"
        tone={TONES.newest}
        art={latest?.cover_art_id ? <Cover coverArtId={latest.cover_art_id} size={96} className="quick-tile-cover" /> : undefined}
      />
      <QuickTile onSelect={() => void randomAlbum()} icon="album" label="Random album" tone={TONES.random} />
      <QuickTile to="/library/artists" icon="artist" label="Artists" tone={TONES.artists} />
      <QuickTile onSelect={() => void shuffleLibrary()} icon="shuffle" label="Shuffle my library" tone={TONES.shuffle} />
    </nav>
  )
}

const MODES: { id: string; label: string; icon: IconName; hint: string }[] = [
  { id: 'panda', label: 'Panda Radio', icon: 'radio', hint: 'Your taste, with a few surprises' },
  { id: 'study', label: 'Study', icon: 'book', hint: 'Steady, uninterrupted listening' },
  { id: 'familiar', label: 'Familiar', icon: 'heart', hint: 'Favourites and songs you finish' },
  { id: 'discovery', label: 'Discovery', icon: 'compass', hint: 'Corners of your library you rarely play' },
  { id: 'chaos', label: 'Chaos', icon: 'sparkle', hint: 'Anything goes, no repeats' },
]

/** Panda Radio modes: one engine, different weightings. Starts from your long-term taste. */
function PandaModes() {
  const active = useRadio()
  return (
    <section className="shelf modes" aria-labelledby="modes-title">
      <div className="section-head">
        <h2 id="modes-title" className="section-title">
          Panda Radio
        </h2>
      </div>
      <ul className="modes-row">
        {MODES.map((mode) => (
          <li key={mode.id}>
            <button
              type="button"
              className="mode-tile"
              aria-pressed={active?.mode === mode.id}
              onClick={() => void startRadio(mode.id, null)}
            >
              <Icon name={mode.icon} />
              <span className="mode-name">{mode.label}</span>
              <span className="mode-hint">{mode.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** From PandaFM's own listening history; each shelf hides itself until it has something real. */
function HistorySections() {
  const [resource] = useApi('home:history', (signal) => getHomeSections(signal))
  if (resource.state !== 'ready') return null
  const { recently_played, back_in_rotation, rediscover } = resource.data
  return (
    <>
      <TrackShelf title="Recently played" tracks={recently_played} source="Recently played" />
      <TrackShelf title="Back in rotation" tracks={back_in_rotation} source="Back in rotation" />
      <TrackShelf title="Rediscover your favorites" tracks={rediscover} source="Rediscover" />
    </>
  )
}

function TrackShelf({ title, tracks, source }: { title: string; tracks: Track[]; source: string }) {
  if (tracks.length === 0) return null
  return (
    <Shelf title={title}>
      {tracks.map((track, i) => (
        <TrackCard key={track.id} track={track} onPlay={() => player.playCollection(tracks, { startIndex: i, source: { kind: 'tracks', name: source } })} />
      ))}
    </Shelf>
  )
}

function AlbumShelf({ kind, title, to, hideWhenEmpty }: { kind: 'newest' | 'random'; title: string; to?: string; hideWhenEmpty?: boolean }) {
  const [resource, retry] = useApi(`home:${kind}`, (signal) => listAlbumsPage(kind, 0, 16, signal))
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

function RecentlyAdded() {
  return <AlbumShelf kind="newest" title="Recently added" to="/library/albums?sort=newest" />
}

function RandomAlbums() {
  return <AlbumShelf kind="random" title="Something different" to="/library/albums?sort=random" />
}

function FavoriteSections() {
  const version = useFavoritesVersion()
  const [resource] = useApi(`home:favorites:${version}`, (signal) => getFavorites(signal))
  const data = resource.state === 'ready' ? resource.data : resource.state === 'loading' ? resource.previous : undefined
  if (!data) return null
  const tracks = data.tracks.slice(0, 6)

  return (
    <>
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
          <div className="home-tracks">
            <TrackList
              tracks={tracks}
              header={false}
              onPlay={(i) => player.playCollection(data.tracks, { startIndex: i, source: { kind: 'favorites', name: 'Favorites' } })}
            />
          </div>
        ) : (
          <p className="hint">Tap the heart on any song and it will wait for you here.</p>
        )}
      </section>
      {data.albums.length > 0 && (
        <Shelf title="Favorite albums" to="/favorites">
          {data.albums.map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </Shelf>
      )}
    </>
  )
}

function YourPlaylists() {
  const all = usePlaylists()
  if (all.length === 0) return null
  return (
    <Shelf title="Your playlists" to="/library/playlists">
      {all.slice(0, 16).map((playlist) => (
        <PlaylistCard key={playlist.id} playlist={playlist} />
      ))}
    </Shelf>
  )
}

function ArtistsShelf() {
  const [resource] = useApi('home:artists', (signal) => listArtists(signal))
  const all = resource.state === 'ready' ? resource.data.artists : []
  // A different handful of artists each visit.
  const picks = useMemo(() => [...all].sort(() => Math.random() - 0.5).slice(0, 16), [all])
  if (picks.length === 0) return null
  return (
    <Shelf title="Artists" to="/library/artists">
      {picks.map((artist) => (
        <ArtistCard key={artist.id} artist={artist} />
      ))}
    </Shelf>
  )
}
