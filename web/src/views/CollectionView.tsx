import { useParams } from 'react-router'
import { exploreApi } from '../api/explore'
import { DetailHero } from '../components/DetailHero'
import { Icon } from '../components/Icon'
import { EmptyState, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useApi } from '../hooks/useApi'
import { usePaged } from '../hooks/usePaged'
import { player } from '../player'
import { LoadMore } from './LibraryView'

/** A smart collection (Unplayed, Lossless, Hi-Res, Rediscover), generated from your library and history. */
export function CollectionView() {
  const { collectionId = '' } = useParams()
  const [all] = useApi('explore:collections', (signal) => exploreApi.collections(signal))
  const info = all.state === 'ready' ? all.data.find((c) => c.id === collectionId) : undefined
  const name = info?.name ?? 'Collection'
  const songs = usePaged(`collection:${collectionId}`, (offset, size, signal) => exploreApi.collectionTracks(collectionId, 'artist', offset, size, signal).then((r) => r.tracks), 50)
  const play = (shuffle: boolean) => songs.items.length && player.playCollection(songs.items, { source: { kind: 'tracks', name }, shuffle })
  return (
    <div className="page">
      <DetailHero
        color={null}
        art={<span className="genre-art genre-art--empty hero-art" aria-hidden="true"><Icon name={collectionId === 'unplayed' ? 'sparkle' : collectionId === 'rediscover' ? 'compass' : 'tag'} /></span>}
        kind="Collection"
        title={name}
        meta={info ? `${info.description}${info.count != null ? ` · ${info.count} songs` : ''}` : ''}
        actions={
          <div className="hero-actions">
            <button type="button" className="icon-button icon-button--large play-circle" aria-label={`Play ${name}`} onClick={() => play(false)}><Icon name="play" /></button>
            <button type="button" className="icon-button icon-button--large" aria-label={`Shuffle ${name}`} onClick={() => play(true)}><Icon name="shuffle" /></button>
          </div>
        }
      />
      {songs.state === 'loading' ? <Loading label="Loading songs…" /> : songs.items.length === 0 ? <EmptyState icon="music" title="Nothing here yet" /> : (
        <>
          <TrackList tracks={songs.items} onPlay={(i) => player.playCollection(songs.items, { startIndex: i, source: { kind: 'tracks', name } })} />
          <LoadMore visible={songs.hasMore && collectionId !== 'rediscover'} busy={songs.loadingMore} onClick={songs.loadMore} />
        </>
      )}
    </div>
  )
}
