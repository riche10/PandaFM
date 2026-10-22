import { useEffect, useState } from 'react'
import { Navigate, NavLink, useParams, useSearchParams } from 'react-router'
import { type AlbumListKind, listAlbumsPage, listArtists, listTracks, type TrackListOrder } from '../api/library'
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
    </div>
  )
}

/** Sort choices kept in the URL (?sort=), so Back and refresh keep them. */
function useSortParam<T extends string>(options: readonly { id: T }[], fallback: T): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get('sort') as T | null
  const current = options.some((o) => o.id === value) ? (value as T) : fallback
  return [current, (next) => setParams({ sort: next }, { replace: true })]
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

function LoadMore({ visible, busy, onClick }: { visible: boolean; busy: boolean; onClick: () => void }) {
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
  const albums = usePaged(`albums:${sort}`, (offset, size, signal) => listAlbumsPage(sort, offset, size, signal).then((r) => r.albums), 48)

  return (
    <>
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
  const songs = usePaged(`songs:${order}`, (offset, size, signal) => listTracks(order, offset, size, signal).then((r) => r.tracks), 100)

  return (
    <>
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
          <LoadMore visible={songs.hasMore && order === 'all'} busy={songs.loadingMore} onClick={songs.loadMore} />
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
