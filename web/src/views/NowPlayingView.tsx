import { Link } from 'react-router'
import { Cover } from '../components/Cover'
import { ErrorNotice } from '../components/ErrorNotice'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/PageHeader'
import { SeekBar } from '../components/SeekBar'
import { player, useCurrentTrack, usePlayer } from '../player'

export function NowPlayingView() {
  const track = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const hasNext = usePlayer((s) => s.index + 1 < s.queue.length)

  if (!track) {
    return (
      <main className="page">
        <PageHeader title="Now playing" />
        <div className="empty">
          <p>Nothing is playing yet.</p>
          <Link to="/" className="button">
            Find something to play
          </Link>
        </div>
      </main>
    )
  }

  const active = status === 'playing' || status === 'loading'
  return (
    <main className="page now-playing">
      <PageHeader title="Now playing" />
      <Cover coverArtId={track.cover_art_id} size={600} className="np-cover" />

      <div className="np-text">
        <h1 className="np-title">{track.title}</h1>
        <p className="np-artist">
          {track.artist_id ? (
            <Link to={`/artists/${encodeURIComponent(track.artist_id)}`}>{track.artist}</Link>
          ) : (
            track.artist
          )}
        </p>
        {track.album && (
          <p className="np-album">
            {track.album_id ? (
              <Link to={`/albums/${encodeURIComponent(track.album_id)}`}>{track.album}</Link>
            ) : (
              track.album
            )}
          </p>
        )}
      </div>

      <SeekBar />

      <div className="np-controls">
        <button type="button" className="icon-button icon-button--large" onClick={player.previous} aria-label="Previous">
          <Icon name="previous" />
        </button>
        <button
          type="button"
          className="play-button"
          onClick={player.togglePlay}
          aria-label={active ? 'Pause' : 'Play'}
          data-loading={status === 'loading' ? '' : undefined}
        >
          <Icon name={active ? 'pause' : 'play'} />
        </button>
        <button
          type="button"
          className="icon-button icon-button--large"
          onClick={player.next}
          aria-label="Next"
          disabled={!hasNext}
        >
          <Icon name="next" />
        </button>
      </div>

      {status === 'error' && error && <ErrorNotice error={error} onRetry={player.play} />}
    </main>
  )
}
