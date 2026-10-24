import { Link, useParams } from 'react-router'
import { type Album, getAlbum, getArtist } from '../api/library'
import { AlbumCard, PlayCircle, Shelf, ShuffleButton } from '../components/Cards'
import { Cover } from '../components/Cover'
import { DetailHero } from '../components/DetailHero'
import { FavoriteButton } from '../components/FavoriteButton'
import { MenuButton, MenuItem } from '../components/Menu'
import { ErrorNotice, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { Icon } from '../components/Icon'
import { openDialog } from '../dialogs/store'
import { useOffline } from '../offline'
import { isNative } from '../platform/state'
import { toast } from '../library'
import { startRadio } from '../library/play'
import { useApi } from '../hooks/useApi'
import { useArtworkColor } from '../hooks/useArtworkColor'
import { countOf, formatLength, player, type QueueSource } from '../player'

export function AlbumView() {
  const { albumId = '' } = useParams()
  const [resource, retry] = useApi(`album:${albumId}`, (signal) => getAlbum(albumId, signal))
  const album = resource.state === 'ready' ? resource.data : undefined
  const color = useArtworkColor(album?.cover_art_id ?? null)
  const downloaded = useOffline((s) => !!s.collections[`album:${albumId}`])

  if (resource.state === 'error') {
    return (
      <div className="page">
        <ErrorNotice error={resource.error} onRetry={resource.error.status === 404 ? undefined : retry} />
      </div>
    )
  }
  if (!album) return <div className="page"><Loading label="Loading album…" /></div>

  const source: QueueSource = { kind: 'album', id: album.id, name: album.name }
  const facts = [album.year, album.genres[0], countOf(album.tracks.length, 'song', 'songs'), formatLength(album.duration_seconds)].filter(Boolean)
  return (
    <div className="page page--detail">
      <DetailHero
        color={color}
        art={<Cover coverArtId={album.cover_art_id} size={600} />}
        kind="Album"
        title={album.name}
        meta={
          <>
            {album.artist_id ? <Link to={`/artists/${encodeURIComponent(album.artist_id)}`} className="hero-artist">{album.artist}</Link> : <span className="hero-artist">{album.artist}</span>}
            {facts.map((fact) => (
              <span key={String(fact)}> · {fact}</span>
            ))}
          </>
        }
        actions={
          <>
            <PlayCircle label={`Play ${album.name}`} disabled={!album.tracks.length} onPlay={() => player.playCollection(album.tracks, { source })} />
            <ShuffleButton label={`Shuffle ${album.name}`} disabled={album.tracks.length < 2} onShuffle={() => player.playCollection(album.tracks, { source, shuffle: true })} />
            <FavoriteButton kind="album" id={album.id} fromServer={album.favorite} label={album.name} className="icon-button--large" />
            {isNative() && (
              <button type="button" className="icon-button icon-button--large" aria-label="Download for offline listening" onClick={() => openDialog({ type: 'download', target: { kind: 'album', id: album.id, name: album.name } })}>
                <Icon name={downloaded ? 'downloaded' : 'download'} />
              </button>
            )}
            <MenuButton label={`More options for ${album.name}`} className="icon-button--large">
              {(close) => (
                <>
                  <MenuItem icon="playNext" label="Play next" onSelect={() => { close(); player.playNext(album.tracks); toast(`${album.name} will play next`) }} />
                  <MenuItem icon="queue" label="Add to queue" onSelect={() => { close(); player.addToQueue(album.tracks); toast(`Added ${album.name} to the queue`) }} />
                  <MenuItem icon="playlist" label="Add album to playlist" onSelect={() => { close(); openDialog({ type: 'add-to-playlist', tracks: album.tracks }) }} />
                  <MenuItem icon="radio" label="Start Panda Radio" onSelect={() => { close(); void startRadio('panda', { kind: 'album', id: album.id, name: album.name }) }} />
                </>
              )}
            </MenuButton>
          </>
        }
      />
      <TrackList tracks={album.tracks} variant="album" albumArtist={album.artist} onPlay={(i) => player.playCollection(album.tracks, { startIndex: i, source })} />
      {album.artist_id && <MoreByArtist album={album} artistId={album.artist_id} />}
    </div>
  )
}

function MoreByArtist({ album, artistId }: { album: Album; artistId: string }) {
  const [resource] = useApi(`artist:${artistId}`, (signal) => getArtist(artistId, signal))
  if (resource.state !== 'ready') return null
  const others = resource.data.albums.filter((a) => a.id !== album.id)
  if (others.length === 0) return null
  return (
    <Shelf title={`More by ${album.artist}`} to={`/artists/${encodeURIComponent(artistId)}`}>
      {others.map((other) => (
        <AlbumCard key={other.id} album={other} subtitle="year" />
      ))}
    </Shelf>
  )
}
