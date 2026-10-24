import type { CSSProperties } from 'react'
import { Link } from 'react-router'
import { Cover } from '../components/Cover'
import { FavoriteButton } from '../components/FavoriteButton'
import { Icon } from '../components/Icon'
import { artVars, useArtworkColor } from '../hooks/useArtworkColor'
import { player, useCurrentTrack, usePlayer } from '../player'

/** Phones: a compact card above the bottom navigation. Tapping it opens Now Playing. */
export function MiniPlayer() {
  const track = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  const progress = usePlayer((s) => (s.duration > 0 ? s.position / s.duration : 0))
  const color = useArtworkColor(track?.cover_art_id ?? null)
  if (!track) return null

  const active = status === 'playing' || status === 'loading'
  return (
    <div className="mini-player" style={artVars(color)}>
      <Link to="/now-playing" className="mini-info" aria-label={`Open Now Playing: ${track.title} by ${track.artist}`}>
        <Cover coverArtId={track.cover_art_id} size={96} className="mini-cover" />
        <span className="mini-text">
          <span className="mini-title">{track.title}</span>
          <span className="mini-artist">{status === 'error' ? 'Couldn’t play this song' : track.artist}</span>
        </span>
      </Link>
      <FavoriteButton kind="track" id={track.id} fromServer={track.favorite} label={track.title} />
      <button type="button" className="icon-button" onClick={player.togglePlay} aria-label={active ? 'Pause' : 'Play'}>
        <Icon name={active ? 'pause' : 'play'} />
      </button>
      <span className="mini-progress" style={{ '--progress': progress } as CSSProperties} />
    </div>
  )
}
