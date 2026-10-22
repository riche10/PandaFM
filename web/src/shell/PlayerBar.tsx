import { type CSSProperties } from 'react'
import { Link } from 'react-router'
import { Cover } from '../components/Cover'
import { FavoriteButton } from '../components/FavoriteButton'
import { Icon } from '../components/Icon'
import { SeekBar } from '../components/SeekBar'
import { player, useCurrentTrack, useHasNext, usePlayer } from '../player'

/** Desktop: the full-width bar along the bottom of the window. */
export function PlayerBar() {
  const track = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  const hasNext = useHasNext()
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const active = status === 'playing' || status === 'loading'

  return (
    <footer className="player-bar" aria-label="Player">
      <div className="player-bar-track">
        {track ? (
          <>
            <Link to="/now-playing" className="player-bar-art" aria-label="Open Now Playing">
              <Cover coverArtId={track.cover_art_id} size={96} />
            </Link>
            <span className="player-bar-text">
              <Link to="/now-playing" className="player-bar-title">
                {track.title}
              </Link>
              <span className="player-bar-artist">
                {track.artist_id ? <Link to={`/artists/${encodeURIComponent(track.artist_id)}`}>{track.artist}</Link> : track.artist}
              </span>
            </span>
            <FavoriteButton kind="track" id={track.id} fromServer={track.favorite} label={track.title} />
          </>
        ) : (
          <span className="player-bar-idle">Pick a song to start listening.</span>
        )}
      </div>

      <div className="player-bar-center">
        <div className="transport">
          <button type="button" className="icon-button" onClick={player.previous} aria-label="Previous" disabled={!track}>
            <Icon name="previous" />
          </button>
          <button
            type="button"
            className="transport-play"
            onClick={player.togglePlay}
            aria-label={active ? 'Pause' : 'Play'}
            disabled={!track}
            data-loading={status === 'loading' ? '' : undefined}
          >
            <Icon name={active ? 'pause' : 'play'} />
          </button>
          <button type="button" className="icon-button" onClick={player.next} aria-label="Next" disabled={!hasNext}>
            <Icon name="next" />
          </button>
        </div>
        <SeekBar compact />
      </div>

      <div className="player-bar-extras">
        <Link to="/now-playing" className="icon-button" aria-label="Open Now Playing">
          <Icon name="expand" />
        </Link>
        <button type="button" className="icon-button" onClick={player.toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted || volume === 0 ? 'volumeOff' : 'volume'} />
        </button>
        <input
          type="range"
          className="range volume"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          aria-label="Volume"
          aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
          style={{ '--progress': muted ? 0 : volume } as CSSProperties}
          onChange={(event) => player.setVolume(Number(event.currentTarget.value))}
        />
      </div>
    </footer>
  )
}
