import { Link } from 'react-router'
import type { PlaylistSummary, Track } from '../api/library'
import { formatTime, useCurrentTrack, usePlayer } from '../player'
import { Cover } from './Cover'
import { Equalizer } from './Equalizer'
import { FavoriteButton } from './FavoriteButton'
import { Icon } from './Icon'
import { OfflineMark } from './OfflineMark'
import { TrackMenu } from './TrackMenu'

interface TrackListProps {
  tracks: Track[]
  onPlay: (index: number) => void
  /** Album pages number by track and hide artwork; other lists show covers. */
  variant?: 'default' | 'album'
  /** Hide the artist on rows where it matches (album pages). */
  albumArtist?: string
  /** Show the album column on wide screens. */
  showAlbum?: boolean
  /** Enables "Remove from this playlist" in the row menus. */
  playlist?: PlaylistSummary
  header?: boolean
}

export function TrackList({
  tracks,
  onPlay,
  variant = 'default',
  albumArtist,
  showAlbum = variant !== 'album',
  playlist,
  header = true,
}: TrackListProps) {
  const current = useCurrentTrack()
  const status = usePlayer((s) => s.status)

  return (
    <div className={`tracks tracks--${variant}`} data-album-column={showAlbum ? '' : undefined}>
      {header && (
        <div className="tracks-head" aria-hidden="true">
          <span className="tracks-head-index">#</span>
          <span>Title</span>
          {showAlbum && <span className="tracks-head-album">Album</span>}
          <span />
          <span className="tracks-head-time">
            <Icon name="clock" />
          </span>
          <span />
        </div>
      )}
      <ol className="track-rows">
        {tracks.map((track, index) => {
          const isCurrent = current?.id === track.id
          const showArtist = variant !== 'album' || track.artist !== albumArtist
          return (
            <li key={`${track.id}-${index}`} className="track-row" data-current={isCurrent ? '' : undefined}>
              <span className="track-index">
                {isCurrent ? (
                  <Equalizer playing={status === 'playing'} />
                ) : (
                  <span className="track-number">{variant === 'album' ? (track.track_number ?? index + 1) : index + 1}</span>
                )}
                <Icon name="play" className="icon track-hover-play" />
              </span>
              {variant !== 'album' && <Cover coverArtId={track.cover_art_id} size={96} className="track-cover" />}
              <span className="track-main">
                <button
                  type="button"
                  className="track-play"
                  onClick={() => onPlay(index)}
                  aria-label={`Play ${track.title} by ${track.artist}`}
                >
                  <span className="track-title">{track.title}</span>
                </button>
                <OfflineMark trackId={track.id} />
                {showArtist && (
                  <span className="track-sub">
                    {track.artist_id ? (
                      <Link to={`/artists/${encodeURIComponent(track.artist_id)}`}>{track.artist}</Link>
                    ) : (
                      track.artist
                    )}
                  </span>
                )}
              </span>
              {showAlbum && (
                <span className="track-album">
                  {track.album_id && track.album ? (
                    <Link to={`/albums/${encodeURIComponent(track.album_id)}`}>{track.album}</Link>
                  ) : (
                    track.album
                  )}
                </span>
              )}
              <FavoriteButton kind="track" id={track.id} fromServer={track.favorite} label={track.title} className="track-favorite" />
              <span className="track-duration">{formatTime(track.duration_seconds)}</span>
              <TrackMenu
                track={track}
                onPlay={() => onPlay(index)}
                inPlaylist={playlist ? { playlist, index } : undefined}
              />
            </li>
          )
        })}
      </ol>
    </div>
  )
}
