import { useEffect, useState } from 'react'
import { Link, Navigate, NavLink, useParams, useSearchParams } from 'react-router'
import { anyFilter, exploreApi, type LibraryFilterState, readFilters, writeFilters } from '../api/explore'
import { type AlbumListKind, listAlbumsPage, listArtists, listTracks, type Track, type TrackListOrder } from '../api/library'
import { GenreArt } from '../components/GenreArt'
import { useOffline } from '../offline'
import { AlbumCard, ArtistCard, CardGrid, PlaylistCard } from '../components/Cards'
import { Icon } from '../components/Icon'
import { EmptyState, ErrorNotice, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { openDialog } from '../dialogs/store'
import { useApi } from '../hooks/useApi'
import { usePaged } from '../hooks/usePaged'
import { playlists, usePlaylists, usePlaylistsStatus } from '../library'
import { player } from '../player'
import { isNative } from '../platform/state'

const TABS = [
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'songs', label: 'Songs' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'genres', label: 'Genres' },
  { id: 'decades', label: 'Decades' },
  { id: 'collections', label: 'Collections' },
] as const

export function LibraryView() {
  const { tab = 'albums' } = useParams()
  if (!TABS.some((t) => t.id === tab)) return <Navigate to="/library/albums" replace />

  return (
    <div className="page">
      <h1 className="page-title">Library</h1>
      <nav className="tabs" aria-label="Library sections">
        {TABS.map((t) => (
          <NavLink key={t.id} to={`/library/${t.id}`} className="tab" replace>
            {t.label}
          </NavLink>
        ))}
        {isNative() && (
          <NavLink to="/offline" className="tab">
            Downloaded
          </NavLink>
        )}
      </nav>
      {tab === 'albums' && <AlbumsTab />}
      {tab === 'artists' && <ArtistsTab />}
      {tab === 'songs' && <SongsTab />}
      {tab === 'playlists' && <PlaylistsTab />}
      {tab === 'genres' && <GenresTab />}
      {tab === 'decades' && <DecadesTab />}
      {tab === 'collections' && <CollectionsTab />}
    </div>
  )
}

/** Sort choices kept in the URL (?sort=), so Back and refresh keep them. */
function useSortParam<T extends string>(options: readonly { id: T }[], fallback: T): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get('sort') as T | null
  const current = options.some((o) => o.id === value) ? (value as T) : fallback
  // Merge, so a sort change keeps active filters.
  return [current, (next) => setParams((p) => { const n = new URLSearchParams(p); n.set('sort', next); return n }, { replace: true })]
}

function SortChips<T extends string>({ options, value, onChange, onRepeat }: { options: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; onRepeat?: (id: T) => void }) {
  return (
    <div className="chips" role="group" aria-label="Sort">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="chip"
          aria-pressed={o.id === value}
          onClick={() => (o.id === value ? onRepeat?.(o.id) : onChange(o.id))}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function LoadMore({ visible, busy, onClick }: { visible: boolean; busy: boolean; onClick: () => void }) {
  if (!visible) return null
  return (
    <div className="load-more">
      <button type="button" className="button button--quiet" onClick={onClick} disabled={busy}>
        {busy ? 'Loading…' : 'Load more'}
      </button>
    </div>
  )
}

const ALBUM_SORTS = [
  { id: 'newest', label: 'Recently added' },
  { id: 'alphabetical', label: 'A–Z' },
  { id: 'random', label: 'Random' },
] as const satisfies readonly { id: AlbumListKind; label: string }[]

function AlbumsTab() {
  const [sort, setSort] = useSortParam(ALBUM_SORTS, 'newest')
  const [params] = useSearchParams()
  const filters = readFilters(params)
  const filtered = anyFilter(filters)
  // Filtered: the server's library cache does the work (paged); unfiltered: exactly as before.
  const albums = usePaged(filtered ? `albums:f:${sort}:${writeFilters(new URLSearchParams(), filters)}` : `albums:${sort}`, (offset, size, signal) =>
    filtered
      ? exploreApi.albums({ genre: filters.genre, decade: filters.decade, favorites: filters.favorites }, sort === 'random' ? 'random' : sort === 'alphabetical' ? 'name' : 'year', offset, size, signal).then((r) => r.albums)
      : listAlbumsPage(sort, offset, size, signal).then((r) => r.albums), 48)

  return (
    <>
      <FilterBar kind="albums" />
      <SortChips options={ALBUM_SORTS} value={sort} onChange={setSort} onRepeat={(id) => id === 'random' && albums.retry()} />
      {albums.state === 'error' && albums.error ? (
        <ErrorNotice error={albums.error} onRetry={albums.retry} />
      ) : albums.state === 'loading' ? (
        <Loading label="Loading albums…" />
      ) : albums.items.length === 0 ? (
        <EmptyState icon="album" title="No albums yet">
          <p>Navidrome hasn’t found any music. If you just added some, wait for its next library scan.</p>
        </EmptyState>
      ) : (
        <>
          <CardGrid>
            {albums.items.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </CardGrid>
          <LoadMore visible={albums.hasMore} busy={albums.loadingMore} onClick={albums.loadMore} />
        </>
      )}
    </>
  )
}

const ARTIST_STEP = 120

function ArtistsTab() {
  const [resource, retry] = useApi('library:artists', (signal) => listArtists(signal))
  const [limit, setLimit] = useState(ARTIST_STEP)

  if (resource.state === 'error') return <ErrorNotice error={resource.error} onRetry={retry} />
  if (resource.state === 'loading') return <Loading label="Loading artists…" />
  const { artists } = resource.data
  if (artists.length === 0) return <EmptyState icon="artist" title="No artists yet" />
  return (
    <>
      <CardGrid>
        {artists.slice(0, limit).map((artist) => (
          <ArtistCard key={artist.id} artist={artist} />
        ))}
      </CardGrid>
      <LoadMore visible={artists.length > limit} busy={false} onClick={() => setLimit(limit + ARTIST_STEP)} />
    </>
  )
}

const SONG_SORTS = [
  { id: 'all', label: 'All songs' },
  { id: 'random', label: 'Random' },
] as const satisfies readonly { id: TrackListOrder; label: string }[]

function SongsTab() {
  const [order, setOrder] = useSortParam(SONG_SORTS, 'all')
  const [params] = useSearchParams()
  const filters = readFilters(params)
  const filtered = anyFilter(filters) && !filters.downloaded
  const local = useOffline((s) => s.tracks)
  const remote = usePaged(filtered ? `songs:f:${order}:${writeFilters(new URLSearchParams(), filters)}` : `songs:${order}`, (offset, size, signal) =>
    filtered
      ? exploreApi.tracks({ genre: filters.genre, decade: filters.decade, favorites: filters.favorites, lossless: filters.lossless, hires: filters.hires }, order === 'random' ? 'random' : 'artist', offset, size, signal).then((r) => r.tracks)
      : listTracks(order, offset, size, signal).then((r) => r.tracks), 100)
  // "Downloaded on this device" filters the device's own downloads (the server can't know them).
  const songs = filters.downloaded
    ? { ...remote, state: 'ready' as const, items: filterLocal(Object.values(local).filter((t) => t.status === 'downloaded').map((t) => t.track), filters), hasMore: false }
    : remote

  return (
    <>
      <FilterBar kind="songs" />
      <SortChips options={SONG_SORTS} value={order} onChange={setOrder} onRepeat={(id) => id === 'random' && songs.retry()} />
      {songs.state === 'error' && songs.error ? (
        <ErrorNotice error={songs.error} onRetry={songs.retry} />
      ) : songs.state === 'loading' ? (
        <Loading label="Loading songs…" />
      ) : songs.items.length === 0 ? (
        <EmptyState icon="music" title="No songs yet" />
      ) : (
        <>
          <TrackList tracks={songs.items} onPlay={(i) => player.playCollection(songs.items, { startIndex: i, source: { kind: 'songs', name: order === 'random' ? 'Random songs' : 'All songs' } })} />
          <LoadMore visible={songs.hasMore && (order === 'all' || filtered)} busy={songs.loadingMore} onClick={songs.loadMore} />
        </>
      )}
    </>
  )
}

function PlaylistsTab() {
  const all = usePlaylists()
  const status = usePlaylistsStatus()

  useEffect(() => {
    void playlists().load()
  }, [])

  if (status === 'error' && all.length === 0) {
    return <ErrorNotice error="Couldn’t load your playlists from Navidrome." onRetry={() => void playlists().load()} />
  }
  if (status !== 'ready' && all.length === 0) return <Loading label="Loading playlists…" />
  return (
    <CardGrid>
      <div className="card card--new">
        <button type="button" className="card-new" onClick={() => openDialog({ type: 'new-playlist', tracks: [] })}>
          <span className="card-new-art">
            <Icon name="plus" />
          </span>
          <span className="card-title">New playlist</span>
        </button>
      </div>
      {all.map((playlist) => (
        <PlaylistCard key={playlist.id} playlist={playlist} />
      ))}
    </CardGrid>
  )
}

/** Filters button plus the active filters as removable chips; the filters live in the URL. */
function FilterBar({ kind }: { kind: 'albums' | 'songs' }) {
  const [params, setParams] = useSearchParams()
  const f = readFilters(params)
  const [genres] = useApi('explore:genres:name', (signal) => exploreApi.genres('name', signal))
  const apply = (next: LibraryFilterState) => setParams(writeFilters(params, next)) // a new history entry: Back undoes it
  const genreName = f.genre && genres.state === 'ready' ? (genres.data.find((g) => g.key === f.genre)?.name ?? f.genre) : f.genre
  const active: [string, Partial<LibraryFilterState>][] = [
    ...(f.genre ? [[genreName ?? f.genre, { genre: null }] as [string, Partial<LibraryFilterState>]] : []),
    ...(f.decade ? [[`${f.decade}s`, { decade: null }] as [string, Partial<LibraryFilterState>]] : []),
    ...(f.favorites ? [['Favorites', { favorites: false }] as [string, Partial<LibraryFilterState>]] : []),
    ...(f.lossless ? [['Lossless', { lossless: false }] as [string, Partial<LibraryFilterState>]] : []),
    ...(f.hires ? [['Hi-Res', { hires: false }] as [string, Partial<LibraryFilterState>]] : []),
    ...(f.downloaded ? [['Downloaded', { downloaded: false }] as [string, Partial<LibraryFilterState>]] : []),
  ]
  return (
    <div className="filter-bar">
      <button type="button" className="chip" aria-haspopup="dialog" onClick={() => openDialog({ type: 'filters', kind, value: f, onApply: apply })}>
        <Icon name="filter" /> Filters{active.length ? ` (${active.length})` : ''}
      </button>
      {active.map(([label, clear]) => (
        <button key={label} type="button" className="chip" aria-pressed="true" aria-label={`Remove filter ${label}`} onClick={() => apply({ ...f, ...clear })}>
          {label} ✕
        </button>
      ))}
    </div>
  )
}

function filterLocal(tracks: Track[], f: LibraryFilterState): Track[] {
  const norm = (g: string) => g.toLowerCase().replace(/[-_]/g, ' ').trim()
  return tracks.filter((t) =>
    (!f.genre || (t.genres ?? []).some((g) => norm(g) === f.genre)) &&
    (!f.decade || (t.year != null && t.year >= f.decade && t.year <= f.decade + 9)) &&
    (!f.favorites || t.favorite) &&
    (!f.lossless || t.quality?.lossless === true) &&
    (!f.hires || t.quality?.hi_res === true))
}

function GenresTab() {
  const [resource, retry] = useApi('explore:genres:songs', (signal) => exploreApi.genres('songs', signal))
  if (resource.state === 'error') return <ErrorNotice error={resource.error} onRetry={retry} />
  if (resource.state === 'loading') return <Loading label="Loading genres…" />
  if (resource.data.length === 0) return <EmptyState icon="music" title="No genres yet"><p>Your music’s genre tags appear here after the next library sync.</p></EmptyState>
  return (
    <ul className="tile-grid" aria-label="Genres">
      {resource.data.map((g) => (
        <li key={g.key}>
          <Link className="tile" to={`/genres/${encodeURIComponent(g.key)}`}>
            <GenreArt covers={g.cover_art_ids} className="tile-art" />
            <span className="tile-name">{g.name}</span>
            <span className="tile-sub">{g.songs} songs · {g.albums} albums</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function DecadesTab() {
  const [resource, retry] = useApi('explore:decades', (signal) => exploreApi.decades(signal))
  if (resource.state === 'error') return <ErrorNotice error={resource.error} onRetry={retry} />
  if (resource.state === 'loading') return <Loading label="Loading decades…" />
  if (resource.data.length === 0) return <EmptyState icon="album" title="No years in your music’s tags" />
  return (
    <ul className="tile-grid" aria-label="Decades">
      {resource.data.map((d) => (
        <li key={d.decade}>
          <Link className="tile tile--decade" to={`/decades/${d.decade}`}>
            <span className="tile-name">{d.label}</span>
            <span className="tile-sub">{d.albums} albums · {d.songs} songs</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function CollectionsTab() {
  const [resource, retry] = useApi('explore:collections', (signal) => exploreApi.collections(signal))
  if (resource.state === 'error') return <ErrorNotice error={resource.error} onRetry={retry} />
  if (resource.state === 'loading') return <Loading label="Loading collections…" />
  const items = [...resource.data, ...(isNative() ? [{ id: 'downloaded', name: 'Downloaded', description: 'Music on this device', count: null, link: '/offline' }] : [])]
  return (
    <ul className="tile-grid" aria-label="Smart collections">
      {items.map((c) => (
        <li key={c.id}>
          <Link className="tile tile--collection" to={c.link ?? `/collections/${c.id}`}>
            <span className="tile-name">{c.name}</span>
            <span className="tile-sub">{c.description}{c.count != null ? ` · ${c.count}` : ''}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
