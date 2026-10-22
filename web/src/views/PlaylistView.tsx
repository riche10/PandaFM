import { useNavigate, useParams } from 'react-router'
import { getPlaylist } from '../api/library'
import { PlayCircle } from '../components/Cards'
import { Cover } from '../components/Cover'
import { DetailHero } from '../components/DetailHero'
import { Icon } from '../components/Icon'
import { EmptyState, ErrorNotice, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { openDialog } from '../dialogs/store'
import { useApi } from '../hooks/useApi'
import { useArtworkColor } from '../hooks/useArtworkColor'
import { usePlaylistsVersion } from '../library'
import { countOf, formatLength, player } from '../player'

export function PlaylistView() {
  const { playlistId = '' } = useParams()
  const navigate = useNavigate()
  const version = usePlaylistsVersion() // reload after renames, additions, removals
  const [resource, retry] = useApi(`playlist:${playlistId}:${version}`, (signal) => getPlaylist(playlistId, signal))
  const playlist = resource.state === 'ready' ? resource.data : resource.state === 'loading' ? resource.previous : undefined
  const color = useArtworkColor(playlist?.cover_art_id ?? null)

  if (resource.state === 'error') {
    return (
      <div className="page">
        <ErrorNotice error={resource.error} onRetry={resource.error.status === 404 ? undefined : retry} />
      </div>
    )
  }
  if (!playlist || playlist.id !== playlistId) return <div className="page"><Loading label="Loading playlist…" /></div>

  return (
    <div className="page page--detail">
      <DetailHero
        color={color}
        art={<Cover coverArtId={playlist.cover_art_id} size={600} />}
        kind={playlist.readonly ? 'Playlist (read-only)' : 'Playlist'}
        title={playlist.name}
        meta={[playlist.owner, countOf(playlist.track_count, 'song', 'songs'), formatLength(playlist.duration_seconds)].filter(Boolean).join(' · ')}
        actions={
          <>
            <PlayCircle label={`Play ${playlist.name}`} disabled={!playlist.tracks.length} onPlay={() => player.playTracks(playlist.tracks, 0)} />
            {!playlist.readonly && (
              <>
                <button type="button" className="icon-button icon-button--large" aria-label="Rename playlist" onClick={() => openDialog({ type: 'rename-playlist', playlist })}>
                  <Icon name="edit" />
                </button>
                <button
                  type="button"
                  className="icon-button icon-button--large"
                  aria-label="Delete playlist"
                  onClick={() => openDialog({ type: 'delete-playlist', playlist, onDeleted: () => navigate('/library/playlists', { replace: true }) })}
                >
                  <Icon name="trash" />
                </button>
              </>
            )}
          </>
        }
      />
      {playlist.tracks.length === 0 ? (
        <EmptyState icon="playlist" title="This playlist is empty">
          <p>Find a song, open its ⋯ menu and choose Add to playlist.</p>
        </EmptyState>
      ) : (
        <TrackList tracks={playlist.tracks} onPlay={(i) => player.playTracks(playlist.tracks, i)} playlist={playlist} />
      )}
    </div>
  )
}
