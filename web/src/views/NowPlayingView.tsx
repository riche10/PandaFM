import { Link, useLocation, useNavigate } from 'react-router'
import { Cover } from '../components/Cover'
import { FavoriteButton } from '../components/FavoriteButton'
import { Icon } from '../components/Icon'
import { QualityBadge } from '../components/QualityBadge'
import { RepeatToggle, ShuffleToggle } from '../components/PlaybackModes'
import { QueueButton } from '../components/QueueButton'
import { QueueList } from '../components/QueueList'
import { SeekBar } from '../components/SeekBar'
import { EmptyState, ErrorNotice } from '../components/States'
import { TrackMenu } from '../components/TrackMenu'
import { artVars, useArtworkColor } from '../hooks/useArtworkColor'
import { useCoverSrc } from '../hooks/useCoverSrc'
import { openDialog } from '../dialogs/store'
import { player, radio, useCurrentTrack, useHasNext, usePlayer, useRadio } from '../player'

const UP_NEXT = 5

export function NowPlayingView() {
  const navigate = useNavigate()
  const location = useLocation()
  const track = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const source = usePlayer((s) => s.source)
  const upcoming = usePlayer((s) => Math.max(0, s.items.length - s.index - 1))
  const hasNext = useHasNext()
  const activeRadio = useRadio()
  const why = usePlayer((s) => s.items[s.index]?.radio?.reasons ?? null)
  const color = useArtworkColor(track?.cover_art_id ?? null)
  const backdrop = useCoverSrc(track?.cover_art_id ?? null, 300)
  const close = () => (location.key === 'default' ? navigate('/') : navigate(-1))

  const header = (
    <div className="np-header">
      <button type="button" className="icon-button" onClick={close} aria-label="Close Now Playing">
        <Icon name="chevronDown" />
      </button>
      <div className="np-header-text">
        <span className="np-header-title">Now playing</span>
        {activeRadio ? (
          <span className="np-header-source np-radio">
            <Icon name="radio" />
            {activeRadio.autoplay ? 'Autoplay · ' : ''}
            {activeRadio.modeLabel}
            {activeRadio.seedName ? ` · based on ${activeRadio.seedName}` : ''}
          </span>
        ) : (
          source && <span className="np-header-source">from {source.name}</span>
        )}
      </div>
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
    <div className="now-playing" style={artVars(color)}>
      {backdrop && (
        // The artwork, blurred and dimmed, as a quiet backdrop.
        <div className="np-backdrop" aria-hidden="true" style={{ backgroundImage: `url(${backdrop})` }} />
      )}
      {header}
      <div className="np-body">
        <Cover coverArtId={track.cover_art_id} size={600} className="np-cover" />

        <div className="np-panel">
          <div className="np-meta">
            <div className="np-text">
              <h1 className="np-title">{track.title}</h1>
              <p className="np-artist">
                {track.artist_id ? <Link to={`/artists/${encodeURIComponent(track.artist_id)}`}>{track.artist}</Link> : track.artist}
              </p>
              <QualityBadge track={track} />
              {track.album && (
                <p className="np-album">
                  {track.album_id ? <Link to={`/albums/${encodeURIComponent(track.album_id)}`}>{track.album}</Link> : track.album}
                </p>
              )}
            </div>
            <FavoriteButton kind="track" id={track.id} fromServer={track.favorite} label={track.title} className="icon-button--large" />
          </div>
          {why && (
            <button type="button" className="why-button" onClick={() => openDialog({ type: 'why', track, reasons: why, modeLabel: activeRadio?.modeLabel ?? null })}>
              <Icon name="sparkle" />
              Why this song?
            </button>
          )}

          <SeekBar />

          <div className="np-controls">
            <ShuffleToggle />
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
            <RepeatToggle />
          </div>

          {status === 'error' && error && <ErrorNotice error={error} onRetry={player.play} />}
        </div>

        <section className="np-upnext" aria-label="Up next">
          <div className="queue-heading-row">
            <h2 className="np-upnext-title">Up next{upcoming > 0 && !activeRadio ? ` · ${upcoming}` : ''}</h2>
            {activeRadio && (
              <button type="button" className="text-button" onClick={() => void radio.end()}>
                End radio
              </button>
            )}
            <QueueButton />
          </div>
          <QueueList limit={UP_NEXT} showCurrent={false} />
        </section>
      </div>
    </div>
  )
}
