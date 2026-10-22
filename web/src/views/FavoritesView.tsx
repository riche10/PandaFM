import { getFavorites } from '../api/library'
import { AlbumCard, ArtistCard, CardGrid, PlayCircle, ShuffleButton } from '../components/Cards'
import { DetailHero } from '../components/DetailHero'
import { Icon } from '../components/Icon'
import { EmptyState, ErrorNotice, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useApi } from '../hooks/useApi'
import { useFavoritesVersion } from '../library'
import { countOf, formatLength, player, type QueueSource } from '../player'

export function FavoritesView() {
  const version = useFavoritesVersion()
  const [resource, retry] = useApi(`favorites:${version}`, (signal) => getFavorites(signal))
  const data = resource.state === 'ready' ? resource.data : resource.state === 'loading' ? resource.previous : undefined

  const tracks = data?.tracks ?? []
  const source: QueueSource = { kind: 'favorites', name: 'Favorites' }
  const length = formatLength(tracks.reduce((sum, t) => sum + (t.duration_seconds ?? 0), 0))
  return (
    <div className="page page--detail">
      <DetailHero
        color="hsl(340 32% 26%)"
        art={
          <span className="hero-art-tile hero-art-tile--favorites">
            <Icon name="heart" />
          </span>
        }
        kind="Collection"
        title="Favorites"
        meta={data ? [countOf(tracks.length, 'song', 'songs'), length].filter(Boolean).join(' · ') : ' '}
        actions={
          <>
            <PlayCircle label="Play favorite songs" disabled={tracks.length === 0} onPlay={() => player.playCollection(tracks, { source })} />
            <ShuffleButton label="Shuffle favorite songs" disabled={tracks.length < 2} onShuffle={() => player.playCollection(tracks, { source, shuffle: true })} />
          </>
        }
      />
      {resource.state === 'error' ? (
        <ErrorNotice error={resource.error} onRetry={retry} />
      ) : !data ? (
        <Loading label="Loading favorites…" />
      ) : !tracks.length && !data.albums.length && !data.artists.length ? (
        <EmptyState icon="heartOutline" title="Nothing here yet">
          <p>Tap the heart on a song, album or artist to keep it here. Favorites are saved in Navidrome, so other apps see them too.</p>
        </EmptyState>
      ) : (
        <>
          {tracks.length > 0 && <TrackList tracks={tracks} onPlay={(i) => player.playCollection(tracks, { startIndex: i, source })} />}
          {data.albums.length > 0 && (
            <section className="shelf" aria-label="Favorite albums">
              <h2 className="section-title">Albums</h2>
              <CardGrid>
                {data.albums.map((album) => (
                  <AlbumCard key={album.id} album={album} />
                ))}
              </CardGrid>
            </section>
          )}
          {data.artists.length > 0 && (
            <section className="shelf" aria-label="Favorite artists">
              <h2 className="section-title">Artists</h2>
              <CardGrid>
                {data.artists.map((artist) => (
                  <ArtistCard key={artist.id} artist={artist} />
                ))}
              </CardGrid>
            </section>
          )}
        </>
      )}
    </div>
  )
}
