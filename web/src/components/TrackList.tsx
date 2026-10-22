import type { Track } from '../api/library'
import { formatTime, useCurrentTrack, usePlayer } from '../player'
import { Cover } from './Cover'
import { Icon } from './Icon'

interface TrackListProps {
  tracks: Track[]
  /** search rows show artwork and the album; album rows show track numbers. */
  variant: 'search' | 'album'
  onPlay: (index: number) => void
  albumArtist?: string
}

export function TrackList({ tracks, variant, onPlay, albumArtist }: TrackListProps) {
  const current = useCurrentTrack()
  const status = usePlayer((s) => s.status)

  return (
    <ol className={`track-list track-list--${variant}`}>
      {tracks.map((track, index) => {
        const isCurrent = current?.id === track.id
        const meta =
          variant === 'search'
            ? [track.artist, track.album].filter(Boolean).join(' · ')
            : track.artist !== albumArtist
              ? track.artist
              : ''
        return (
          <li key={`${track.id}-${index}`}>
            <button
              type="button"
              className="track-row"
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={`Play ${track.title} by ${track.artist}`}
              onClick={() => onPlay(index)}
            >
              {variant === 'album' ? (
                <span className="track-number">
                  {isCurrent && status !== 'error' ? <Icon name="play" /> : (track.track_number ?? index + 1)}
                </span>
              ) : (
                <Cover coverArtId={track.cover_art_id} size={96} className="track-cover" />
              )}
              <span className="track-text">
                <span className="track-title">{track.title}</span>
                {meta && <span className="track-meta">{meta}</span>}
              </span>
              <span className="track-duration">{formatTime(track.duration_seconds)}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
