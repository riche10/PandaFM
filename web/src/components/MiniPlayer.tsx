import type { CSSProperties } from 'react'
import { Link } from 'react-router'
import { player, useCurrentTrack, usePlayer } from '../player'
import { Cover } from './Cover'
import { Icon } from './Icon'

export function MiniPlayer() {
  const track = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  const progress = usePlayer((s) => (s.duration > 0 ? s.position / s.duration : 0))
  if (!track) return null

  const active = status === 'playing' || status === 'loading'
  return (
    <div className="mini-player" role="region" aria-label="Player">
      <div className="mini-inner">
        <span className="mini-progress" style={{ '--progress': progress } as CSSProperties} />
        <Link to="/now-playing" className="mini-info" aria-label={`Open player: ${track.title} by ${track.artist}`}>
          <Cover coverArtId={track.cover_art_id} size={96} className="mini-cover" />
          <span className="mini-text">
            <span className="mini-title">{track.title}</span>
            <span className="mini-artist">{status === 'error' ? 'Couldn’t play this song' : track.artist}</span>
          </span>
        </Link>
        <button type="button" className="icon-button" onClick={player.togglePlay} aria-label={active ? 'Pause' : 'Play'}>
          <Icon name={active ? 'pause' : 'play'} />
        </button>
      </div>
    </div>
  )
}
