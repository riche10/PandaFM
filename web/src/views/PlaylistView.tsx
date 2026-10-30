import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { getPlaylist } from '../api/library'
import { PlayCircle, ShuffleButton } from '../components/Cards'
import { FactsLine, inMixOrder, mixEntries, PandaMixControls, PandaMixStatus, PlaylistBridge, useMixPlaylist, usePlaylistBridges } from '../components/PandaMix'
import { Cover } from '../components/Cover'
import { DetailHero } from '../components/DetailHero'
import { Icon } from '../components/Icon'
import { EmptyState, ErrorNotice, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { openDialog } from '../dialogs/store'
import { useOffline } from '../offline'
import { isNative } from '../platform/state'
import { useApi } from '../hooks/useApi'
import { useArtworkColor } from '../hooks/useArtworkColor'
import { usePlaylistsVersion } from '../library'
import { countOf, formatLength, player, type QueueSource } from '../player'

export function PlaylistView() {
  const { playlistId = '' } = useParams()
  const navigate = useNavigate()
  const version = usePlaylistsVersion() // reload after renames, additions, removals
  const [resource, retry] = useApi(`playlist:${playlistId}:${version}`, (signal) => getPlaylist(playlistId, signal))
  const playlist = resource.state === 'ready' ? resource.data : resource.state === 'loading' ? resource.previous : undefined
  const color = useArtworkColor(playlist?.cover_art_id ?? null)
  const downloaded = useOffline((s) => !!s.collections[`playlist:${playlistId}`])
  const mix = useMixPlaylist(playlistId) // 5.3: Panda Mix as a lasting setting of this playlist
  const [mixView, setMixView] = useState<'mixed' | 'original'>('mixed')
  const bridgeOrder = playlist && mix.state?.enabled ? inMixOrder(playlist.tracks, mix.state.order) : []
  const bridges = usePlaylistBridges(bridgeOrder, mix.state?.mode, playlistId, !!mix.state?.enabled && mixView === 'mixed', mix.state?.analysed ?? 0)

  if (resource.state === 'error') {
    return (
      <div className="page">
        <ErrorNotice error={resource.error} onRetry={resource.error.status === 404 ? undefined : retry} />
      </div>
    )
  }
  if (!playlist || playlist.id !== playlistId) return <div className="page"><Loading label="Loading playlist…" /></div>

  const source: QueueSource = { kind: 'playlist', id: playlist.id, name: playlist.name }
  const mixed = !!mix.state?.enabled && mixView === 'mixed'
  // 5.5.2: each mixed row keeps its position in the playlist itself, so it can be removed from there
  const entries = mixed ? mixEntries(playlist.tracks, mix.state?.order) : null
  const shown = entries ? entries.map((e) => e.track) : playlist.tracks
  const mixOn = !!mix.state?.enabled
  const factsFor = mixOn ? (t: { id: string }) => <FactsLine facts={mix.state?.facts?.[t.id]} /> : undefined
  const whyFor = new Map((mix.state?.why ?? []).map((w) => [`${w.from}|${w.to}`, w.reasons]))
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
            <PlayCircle
              label={mix.state?.enabled ? `Play Panda Mix ${playlist.name}` : `Play ${playlist.name}`}
              disabled={!playlist.tracks.length}
              onPlay={() => {
                if (mix.state?.enabled) {
                  player.playCollection(inMixOrder(playlist.tracks, mix.state.order), {
                    source: { ...source, mix: { mode: mix.state.mode ?? 'auto', playlistId: playlist.id } },
                  })
                } else {
                  player.playCollection(playlist.tracks, { source })
                }
              }}
            />
            {isNative() && (
              <button type="button" className="icon-button icon-button--large" aria-label="Download for offline listening" onClick={() => openDialog({ type: 'download', target: { kind: 'playlist', id: playlist.id, name: playlist.name } })}>
                <Icon name={downloaded ? 'downloaded' : 'download'} />
              </button>
            )}
            <ShuffleButton label={`Shuffle ${playlist.name}`} disabled={playlist.tracks.length < 2} onShuffle={() => player.playCollection(playlist.tracks, { source, shuffle: true })} />
            <PandaMixControls playlist={playlist} source={source} mix={mix} view={mixView} onView={setMixView} />
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
      <PandaMixStatus mix={mix} view={mixView} />
      {playlist.tracks.length === 0 ? (
        <EmptyState icon="playlist" title="This playlist is empty">
          <p>Find a song, open its ⋯ menu and choose Add to playlist.</p>
        </EmptyState>
      ) : (
        mixed ? (
          // Mixed order: play from here as a Panda Mix; removing a row removes that exact occurrence (5.5.2)
          <TrackList
            tracks={shown}
            playlist={playlist}
            playlistIndexes={entries?.map((e) => e.index)}
            mixed
            onRemoved={() => void mix.reload()}
            onPlay={(i) => player.playCollection(shown, { startIndex: i, source: { ...source, mix: { mode: mix.state?.mode ?? 'auto', playlistId: playlist.id } } })}
            facts={factsFor}
            between={(i) => (
              <PlaylistBridge from={shown[i - 1]} to={shown[i]} plan={bridges.get(`${shown[i - 1].id}|${shown[i].id}`)} why={whyFor.get(`${shown[i - 1].id}|${shown[i].id}`)}
                mode={mix.state?.mode ?? 'auto'} playlistId={playlist.id} />
            )}
          />
        ) : (
          <TrackList tracks={playlist.tracks} onPlay={(i) => player.playCollection(playlist.tracks, { startIndex: i, source })} playlist={playlist} facts={factsFor} />
        )
      )}
    </div>
  )
}
