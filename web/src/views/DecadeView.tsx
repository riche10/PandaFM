import { useParams } from 'react-router'
import { exploreApi } from '../api/explore'
import { AlbumCard, CardGrid } from '../components/Cards'
import { DetailHero } from '../components/DetailHero'
import { Icon } from '../components/Icon'
import { EmptyState, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { usePaged } from '../hooks/usePaged'
import { toast } from '../library'
import { player } from '../player'
import { LoadMore } from './LibraryView'

/** Your albums and songs from one decade. */
export function DecadeView() {
  const decade = Number(useParams().decade) || 0
  const label = `${decade}s`
  const albums = usePaged(`decade-albums:${decade}`, (offset, size, signal) => exploreApi.albums({ decade }, 'year', offset, size, signal).then((r) => r.albums), 24)
  const songs = usePaged(`decade-songs:${decade}`, (offset, size, signal) => exploreApi.tracks({ decade }, 'artist', offset, size, signal).then((r) => r.tracks), 50)
  const play = async (shuffle: boolean) => {
    const r = await exploreApi.tracks({ decade }, shuffle ? 'random' : 'artist', 0, 200).catch(() => null)
    if (!r?.tracks.length) return toast('Couldn’t load the songs.', 'error')
    player.playCollection(r.tracks, { source: { kind: 'tracks', name: label } })
  }
  return (
    <div className="page">
      <DetailHero
        color={null}
        art={<span className="genre-art genre-art--empty hero-art" aria-hidden="true"><span className="decade-art">{label}</span></span>}
        kind="Decade"
        title={label}
        meta="From your library"
        actions={
          <div className="hero-actions">
            <button type="button" className="icon-button icon-button--large play-circle" aria-label={`Play the ${label}`} onClick={() => void play(false)}><Icon name="play" /></button>
            <button type="button" className="icon-button icon-button--large" aria-label={`Shuffle the ${label}`} onClick={() => void play(true)}><Icon name="shuffle" /></button>
          </div>
        }
      />
      <section className="shelf">
        <h2 className="section-title">Albums</h2>
        {albums.state === 'loading' ? <Loading label="Loading albums…" /> : albums.items.length === 0 ? <EmptyState icon="album" title={`No albums from the ${label}`} /> : (
          <>
            <CardGrid>{albums.items.map((a) => <AlbumCard key={a.id} album={a} subtitle="year" />)}</CardGrid>
            <LoadMore visible={albums.hasMore} busy={albums.loadingMore} onClick={albums.loadMore} />
          </>
        )}
      </section>
      <section className="shelf">
        <h2 className="section-title">Songs</h2>
        {songs.state === 'loading' ? <Loading label="Loading songs…" /> : (
          <>
            <TrackList tracks={songs.items} onPlay={(i) => player.playCollection(songs.items, { startIndex: i, source: { kind: 'tracks', name: label } })} />
            <LoadMore visible={songs.hasMore} busy={songs.loadingMore} onClick={songs.loadMore} />
          </>
        )}
      </section>
    </div>
  )
}
