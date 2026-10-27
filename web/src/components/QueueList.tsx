import { Fragment } from 'react'
import { Link } from 'react-router'
import { openDialog } from '../dialogs/store'
import { player, radio, usePlayer, type QueueItem } from '../player'
import { Cover } from './Cover'
import { Equalizer } from './Equalizer'
import { Icon } from './Icon'
import { MarqueeText } from './MarqueeText'
import { MixBridge, useMixBridges } from './PandaMix'
import { MenuButton, MenuItem } from './Menu'

/** Very long queues (a whole library) render this many upcoming rows. */
const RENDER_LIMIT = 150

/**
 * The shared queue: what's playing, songs picked by hand ("Next in queue"),
 * then the rest of the collection ("Next from …"). Used by the desktop panel,
 * the Queue page and the Up next preview on Now Playing.
 */
export function QueueList({ limit, showCurrent = true }: { limit?: number; showCurrent?: boolean }) {
  const items = usePlayer((s) => s.items)
  const index = usePlayer((s) => s.index)
  const source = usePlayer((s) => s.source)
  const status = usePlayer((s) => s.status)

  const current = items[index]
  const upcoming = items.slice(index + 1)
  const manualCount = upcoming.findIndex((item) => item.origin !== 'manual')
  const manual = manualCount === -1 ? upcoming : upcoming.slice(0, manualCount)
  const context = upcoming.slice(manual.length)

  const cap = limit ?? RENDER_LIMIT
  const shownManual = manual.slice(0, cap)
  const shownContext = context.slice(0, Math.max(0, cap - shownManual.length))
  const hidden = upcoming.length - shownManual.length - shownContext.length

  if (!current) {
    return (
      <p className="queue-empty">
        The queue is empty. Play an album or playlist, or choose <strong>Add to queue</strong> from any song’s menu.
      </p>
    )
  }

  // Panda Mix (5.2): a compact bridge into each upcoming song, from the one before it in the queue.
  const mixPlans = useMixBridges()
  const queueItems = usePlayer((s) => s.items)
  const bridgeInto = (item: QueueItem) => {
    const at = queueItems.findIndex((i) => i.uid === item.uid)
    return at > 0 ? <MixBridge from={queueItems[at - 1].track} to={item.track} plans={mixPlans} /> : null
  }
  const nextFrom = source?.radio
    ? `${source.radio.autoplay ? 'Autoplay · ' : 'Next from '}${source.radio.modeLabel}${source.radio.seedName ? ` · based on ${source.radio.seedName}` : ''}`
    : `Next from: ${source?.name ?? 'your selection'}`
  return (
    <div className="queue">
      {showCurrent && (
        <section className="queue-section" aria-label="Now playing">
          <h3 className="queue-heading">Now playing</h3>
          <QueueRow item={current} current playing={status === 'playing'} />
        </section>
      )}
      {shownManual.length > 0 && (
        <section className="queue-section" aria-label="Next in queue">
          <div className="queue-heading-row">
            <h3 className="queue-heading">Next in queue</h3>
            <button type="button" className="text-button" onClick={() => player.clearQueue('manual')}>
              Clear
            </button>
          </div>
          <ol className="queue-rows">
            {shownManual.map((item) => (
              <Fragment key={item.uid}>
                {bridgeInto(item)}
                <QueueRow item={item} />
              </Fragment>
            ))}
          </ol>
        </section>
      )}
      {shownContext.length > 0 && (
        <section className="queue-section" aria-label="Next from the collection">
          <div className="queue-heading-row">
            <h3 className="queue-heading">
              <MarqueeText title={nextFrom}>{nextFrom}</MarqueeText>
            </h3>
            {limit === undefined &&
              (source?.radio ? (
                <button type="button" className="text-button" onClick={() => void radio.end()}>
                  End radio
                </button>
              ) : (
                <button type="button" className="text-button" onClick={() => player.clearQueue('all')}>
                  Clear
                </button>
              ))}
          </div>
          <ol className="queue-rows">
            {shownContext.map((item) => (
              <Fragment key={item.uid}>
                {bridgeInto(item)}
                <QueueRow item={item} />
              </Fragment>
            ))}
          </ol>
        </section>
      )}
      {upcoming.length === 0 && <p className="queue-empty">Nothing after this song. Add songs from any song’s menu.</p>}
      {hidden > 0 && limit === undefined && <p className="queue-more">and {hidden} more</p>}
    </div>
  )
}

function QueueRow({ item, current = false, playing = false }: { item: QueueItem; current?: boolean; playing?: boolean }) {
  const { track } = item
  const Tag = current ? 'div' : 'li'
  return (
    <Tag className="queue-row" data-current={current ? '' : undefined}>
      <Cover coverArtId={track.cover_art_id} size={96} className="queue-art" />
      <span className="queue-text">
        {current ? (
          <span className="queue-title">{track.title}</span>
        ) : (
          <button type="button" className="queue-play" onClick={() => player.jumpTo(item.uid)} aria-label={`Play ${track.title} now`}>
            <span className="queue-title">{track.title}</span>
          </button>
        )}
        <span className="queue-artist">
          {item.radio && (
            <span className="paw queue-radio-mark" title="Panda picked this" aria-label="Panda picked this">
              <Icon name="paw" />
            </span>
          )}
          {track.artist_id ? <Link to={`/artists/${encodeURIComponent(track.artist_id)}`}>{track.artist}</Link> : track.artist}
        </span>
      </span>
      {current ? (
        <Equalizer playing={playing} />
      ) : (
        <>
          <button type="button" className="icon-button icon-button--small queue-remove" aria-label={`Remove ${track.title} from the queue`} onClick={() => player.removeFromQueue(item.uid)}>
            <Icon name="close" />
          </button>
          <MenuButton label={`Queue options for ${track.title}`} className="icon-button--small queue-menu">
            {(close) => (
              <>
                <MenuItem icon="play" label="Play now" onSelect={() => { close(); player.jumpTo(item.uid) }} />
                <MenuItem icon="arrowUp" label="Move up" onSelect={() => { close(); player.moveInQueue(item.uid, -1) }} />
                <MenuItem icon="arrowDown" label="Move down" onSelect={() => { close(); player.moveInQueue(item.uid, 1) }} />
                <MenuItem icon="close" label="Remove from queue" onSelect={() => { close(); player.removeFromQueue(item.uid) }} />
                {item.radio && (
                  <MenuItem icon="sparkle" label="Why this song?" onSelect={() => { close(); openDialog({ type: 'why', track, reasons: item.radio!.reasons, modeLabel: null }) }} />
                )}
              </>
            )}
          </MenuButton>
        </>
      )}
    </Tag>
  )
}
