import { useState } from 'react'
import { useParams } from 'react-router'
import { getArtist, getArtistTracks } from '../api/library'
import { AlbumCard, CardGrid, PlayCircle, ShuffleButton } from '../components/Cards'
import { Cover } from '../components/Cover'
import { DetailHero } from '../components/DetailHero'
import { GenreChips } from '../components/GenreChips'
import { FavoriteButton } from '../components/FavoriteButton'
import { MenuButton, MenuItem } from '../components/Menu'
import { startRadio } from '../library/play'
import { ErrorNotice, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useApi } from '../hooks/useApi'
import { useArtworkColor } from '../hooks/useArtworkColor'
import { countOf, player, type QueueSource } from '../player'

const SONGS_PREVIEW = 5

export function ArtistView() {
  const { artistId = '' } = useParams()
  const [resource, retry] = useApi(`artist:${artistId}`, (signal) => getArtist(artistId, signal))
  const [songs] = useApi(`artist-tracks:${artistId}`, (signal) => getArtistTracks(artistId, signal))
  const [allSongs, setAllSongs] = useState(false)
  const artist = resource.state === 'ready' ? resource.data : undefined
  // Artists rarely have their own picture in a local library; borrow the first album's colour.
  const color = useArtworkColor(artist?.albums[0]?.cover_art_id ?? artist?.cover_art_id ?? null)

  if (resource.state === 'error') {
    return (
      <div className="page">
        <ErrorNotice error={resource.error} onRetry={resource.error.status === 404 ? undefined : retry} />
      </div>
    )
  }
  if (!artist) return <div className="page"><Loading label="Loading artist…" /></div>

  const tracks = songs.state === 'ready' ? songs.data.tracks : []
  const source: QueueSource = { kind: 'artist', id: artist.id, name: artist.name }
  return (
    <div className="page page--detail">
      <DetailHero
        color={color}
        round
        art={<Cover coverArtId={artist.cover_art_id ?? artist.albums[0]?.cover_art_id ?? null} size={600} />}
        kind="Artist"
        title={artist.name}
        meta={[countOf(artist.albums.length, 'album', 'albums'), tracks.length ? countOf(tracks.length, 'song', 'songs') : null].filter(Boolean).join(' · ')}
        actions={
          <>
            <PlayCircle label={`Play ${artist.name}`} disabled={!tracks.length} onPlay={() => player.playCollection(tracks, { source })} />
            <ShuffleButton label={`Shuffle ${artist.name}`} disabled={tracks.length < 2} onShuffle={() => player.playCollection(tracks, { source, shuffle: true })} />
            <FavoriteButton kind="artist" id={artist.id} fromServer={artist.favorite} label={artist.name} className="icon-button--large" />
            <MenuButton label={`More options for ${artist.name}`} className="icon-button--large">
              {(close) => (
                <MenuItem icon="radio" label="Start Panda Radio" onSelect={() => { close(); void startRadio('panda', { kind: 'artist', id: artist.id, name: artist.name }) }} />
              )}
            </MenuButton>
          </>
        }
      />
      <GenreChips tags={artist.genres} />
      {tracks.length > 0 && (
        <section className="shelf" aria-label="Songs">
          <div className="section-head">
            <h2 className="section-title">Songs</h2>
            {tracks.length > SONGS_PREVIEW && (
              <button type="button" className="show-all" onClick={() => setAllSongs(!allSongs)}>
                {allSongs ? 'Show fewer' : `Show all ${tracks.length}`}
              </button>
            )}
          </div>
          <TrackList tracks={allSongs ? tracks : tracks.slice(0, SONGS_PREVIEW)} onPlay={(i) => player.playCollection(tracks, { startIndex: i, source })} header={false} />
        </section>
      )}
      <section className="shelf" aria-label="Albums">
        <h2 className="section-title">Albums</h2>
        <CardGrid>
          {artist.albums.map((album) => (
            <AlbumCard key={album.id} album={album} subtitle="year" />
          ))}
        </CardGrid>
      </section>
    </div>
  )
}
