import { useSyncExternalStore } from 'react'
import { aacPlayable, currentStreamQuality, onStreamQualityChange, setStreamQuality, streamQualitySetting } from '../../platform/network'
import { isNative } from '../../platform/state'
import type { StreamQuality } from '../../player/streamQuality'

const OPTIONS: { id: StreamQuality; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'original', label: 'Original' },
  { id: 'high', label: 'High — AAC ~256 kbps' },
  { id: 'low', label: 'Data Saver — AAC ~128 kbps' },
]
const NOW: Record<string, string> = { original: 'original files', high: 'AAC ~256 kbps', low: 'AAC ~128 kbps' }

/** Streaming quality for this device. Not the same as offline download quality (Settings › Offline). */
export function StreamingQuality() {
  const setting = useSyncExternalStore(onStreamQualityChange, streamQualitySetting)
  const now = useSyncExternalStore(onStreamQualityChange, currentStreamQuality)
  return (
    <fieldset className="radio-group">
      <legend className="field-label">Streaming quality</legend>
      <div className="segmented">
        {OPTIONS.map((o) => (
          <button key={o.id} type="button" className="chip" aria-pressed={setting === o.id} onClick={() => setStreamQuality(o.id)}>{o.label}</button>
        ))}
      </div>
      <p className="hint">
        {setting === 'auto'
          ? isNative() ? `Auto: original files on Wi-Fi, AAC ~256 kbps on mobile data. Now: ${NOW[now]}.` : 'Auto: original files (a browser can’t tell Wi-Fi from mobile data).'
          : `Streaming ${NOW[now]} on this device.`}
        {!aacPlayable && setting !== 'original' ? ' This browser can’t play AAC, so it streams original files.' : ''}
        {' '}Downloaded songs always play from the device. This is separate from offline download quality.
      </p>
    </fieldset>
  )
}
