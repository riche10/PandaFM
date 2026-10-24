import { useOfflineTrack } from '../offline'
import { isNative } from '../platform/state'
import { Icon } from './Icon'

/** A small ✓ / ↓ / ! beside a song in the Android app. Nothing for online-only songs. */
export function OfflineMark({ trackId }: { trackId: string }) {
  const entry = useOfflineTrack(trackId)
  if (!isNative() || !entry) return null
  if (entry.status === 'downloaded') return <span className="offline-mark" title="Downloaded"><Icon name="downloaded" /></span>
  if (entry.status === 'failed' || entry.status === 'outdated')
    return <span className="offline-mark offline-mark--warn" title={entry.status === 'failed' ? 'Download failed' : 'Update waiting'}><Icon name="alert" /></span>
  return <span className="offline-mark offline-mark--busy" title="Downloading"><Icon name="download" /></span>
}
