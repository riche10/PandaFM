import { type CSSProperties, useState } from 'react'
import { formatTime, player, usePlayer } from '../player'

/**
 * Progress and seeking. While the thumb is being dragged the bar follows the
 * finger, not the audio; the seek is sent once, when it's released.
 */
export function SeekBar({ compact = false }: { compact?: boolean }) {
  const position = usePlayer((s) => s.position)
  const duration = usePlayer((s) => s.duration)
  const [scrub, setScrub] = useState<number | null>(null)

  const shown = Math.min(scrub ?? position, duration)
  const commit = () => {
    if (scrub === null) return
    player.seek(scrub)
    setScrub(null)
  }

  return (
    <div className={compact ? 'seek seek--compact' : 'seek'}>
      {compact && <span className="seek-time">{formatTime(shown)}</span>}
      <input
        type="range"
        className="range seek-input"
        min={0}
        max={Math.max(duration, 1)}
        step={1}
        value={shown}
        disabled={duration <= 0}
        aria-label="Seek"
        aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
        style={{ '--progress': duration > 0 ? shown / duration : 0 } as CSSProperties}
        onChange={(event) => setScrub(Number(event.currentTarget.value))}
        onPointerUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      {compact ? (
        <span className="seek-time">{formatTime(duration)}</span>
      ) : (
        <div className="seek-times">
          <span>{formatTime(shown)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      )}
    </div>
  )
}
