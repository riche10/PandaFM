import { player, usePlayer } from '../player'
import { Icon } from './Icon'

const REPEAT_LABEL = { off: 'Repeat', all: 'Repeat all (on)', one: 'Repeat this song (on)' } as const

/** Shuffle and repeat toggles, shared by the player bar and Now Playing. */
export function ShuffleToggle({ className = '' }: { className?: string }) {
  const shuffle = usePlayer((s) => s.shuffle)
  const empty = usePlayer((s) => s.index < 0)
  return (
    <button
      type="button"
      className={`icon-button toggle-button ${className}`.trim()}
      aria-label={shuffle ? 'Shuffle (on)' : 'Shuffle'}
      aria-pressed={shuffle}
      disabled={empty}
      onClick={player.toggleShuffle}
    >
      <Icon name="shuffle" />
    </button>
  )
}

export function RepeatToggle({ className = '' }: { className?: string }) {
  const repeat = usePlayer((s) => s.repeat)
  return (
    <button
      type="button"
      className={`icon-button toggle-button ${className}`.trim()}
      aria-label={REPEAT_LABEL[repeat]}
      aria-pressed={repeat !== 'off'}
      onClick={player.cycleRepeat}
    >
      <Icon name={repeat === 'one' ? 'repeatOne' : 'repeat'} />
    </button>
  )
}
