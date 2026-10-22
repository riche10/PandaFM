import type { CSSProperties } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Cover } from '../components/Cover'
import { FavoriteButton } from '../components/FavoriteButton'
import { Icon } from '../components/Icon'
import { SeekBar } from '../components/SeekBar'
import { EmptyState, ErrorNotice } from '../components/States'
import { TrackMenu } from '../components/TrackMenu'
import { useArtworkColor } from '../hooks/useArtworkColor'
import { player, useCurrentTrack, useHasNext, usePlayer } from '../player'

export function NowPlayingView() {
  const navigate = useNavigate()
  const location = useLocation()
  const track = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const hasNext = useHasNext()
  const color = useArtworkColor(track?.cover_art_id ?? null)
  const close = () => (location.key === 'default' ? navigate('/') : navigate(-1))

  const header = (
    <div className="np-header">
      <button type="button" className="icon-button" onClick={close} aria-label="Close Now Playing">
        <Icon name="chevronDown" />
      </button>
      <span className="np-header-title">Now playing</span>
      {track ? <TrackMenu track={track} onPlay={player.play} /> : <span className="icon-button" />}
    </div>
  )

  if (!track) {
    return (
      <div className="now-playing">
        {header}
        <EmptyState icon="music" title="Nothing is playing">
          <p>
            <Link to="/search">Search</Link> or browse your <Link to="/library">library</Link> to pick a song.
          </p>
        </EmptyState>
      </div>
    )
  }

  const active = status === 'playing' || status === 'loading'
  return (
    <div className="now-playing" style={color ? ({ '--art': color } as CSSProperties) : undefined}>
      {header}
      <div className="np-body">
        <Cover coverArtId={track.cover_art_id} size={600} className="np-cover" />
        <div className="np-meta">
          <div className="np-text">
            <h1 className="np-title">{track.title}</h1>
            <p className="np-artist">
              {track.artist_id ? <Link to={`/artists/${encodeURIComponent(track.artist_id)}`}>{track.artist}</Link> : track.artist}
            </p>
            {track.album && (
              <p className="np-album">
                {track.album_id ? <Link to={`/albums/${encodeURIComponent(track.album_id)}`}>{track.album}</Link> : track.album}
              </p>
            )}
          </div>
          <FavoriteButton kind="track" id={track.id} fromServer={track.favorite} label={track.title} className="icon-button--large" />
        </div>
        <SeekBar />
        <div className="np-controls">
          <button type="button" className="icon-button icon-button--large" onClick={player.previous} aria-label="Previous">
            <Icon name="previous" />
          </button>
          <button
            type="button"
            className="np-play"
            onClick={player.togglePlay}
            aria-label={active ? 'Pause' : 'Play'}
            data-loading={status === 'loading' ? '' : undefined}
          >
            <Icon name={active ? 'pause' : 'play'} />
          </button>
          <button type="button" className="icon-button icon-button--large" onClick={player.next} aria-label="Next" disabled={!hasNext}>
            <Icon name="next" />
          </button>
        </div>
        {status === 'error' && error && <ErrorNotice error={error} onRetry={player.play} />}
      </div>
    </div>
  )
}
