import { useCallback, useEffect, useState } from 'react'
import { resolveSource } from '../../offline'
import { useCurrentTrack } from '../../player'
import { bridgeErrors } from '../../player/nativeStore'
import { isNative, platform } from '../../platform/state'
import { toast } from '../../library'

const LABELS: Record<string, string> = {
  serviceRunning: 'Service running', controllerStatus: 'Queue status', engineState: 'Engine state', playbackState: 'ExoPlayer state',
  playWhenReady: 'playWhenReady', isPlaying: 'isPlaying', trackId: 'Current track id', queueIndex: 'Queue index', queueLength: 'Queue length',
  generation: 'Generation', source: 'Source', quality: 'Stream quality', streamQualitySetting: 'Quality setting', network: 'Network',
  positionMs: 'Position', durationMs: 'Duration', lastError: 'Last playback error',
}

const ms = (v: unknown) => (typeof v === 'number' ? `${Math.floor(v / 60000)}:${String(Math.floor((v % 60000) / 1000)).padStart(2, '0')}` : '—')

/** What's actually playing, and how: for troubleshooting without a computer. Never shows credentials. */
export function Diagnostics() {
  const track = useCurrentTrack()
  const [native, setNative] = useState<Record<string, unknown> | null>(null)
  const [failed, setFailed] = useState(false)
  const refresh = useCallback(() => {
    platform.player?.getDiagnostics().then((r) => { setNative(JSON.parse(r.diagnostics) as Record<string, unknown>); setFailed(false) }, () => setFailed(true))
  }, [])
  useEffect(() => {
    if (!platform.player) return
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [refresh])
  const source = track ? resolveSource(track.id) : null
  const rows: [string, string][] = [
    ['PandaFM version', __APP_VERSION__],
    ['Platform', isNative() ? 'Android' : 'Browser'],
    ['Playback engine', isNative() ? (failed ? 'Native player unavailable' : 'Media3 (native queue)') : 'HTML audio (browser), web queue'],
  ]
  if (!isNative()) {
    rows.push(['Source', !source ? 'Nothing playing' : 'Server stream'])
    rows.push(['Codec', track?.quality ? `${track.quality.codec}${track.quality.detail ? ` · ${track.quality.detail}` : ''}` : '—'])
  }
  if (native) {
    for (const [key, label] of Object.entries(LABELS)) {
      if (!(key in native)) continue
      const v = native[key]
      rows.push([label, key === 'positionMs' || key === 'durationMs' ? ms(v) : v === null || v === undefined ? '—' : String(v)])
    }
  }
  const events = (native?.events as string[] | undefined) ?? []
  const copy = () => {
    const text = [...rows.map(([k, v]) => `${k}: ${v}`), '', 'Recent playback events:', ...events, ...(bridgeErrors.length ? ['', 'App ↔ player errors:', ...bridgeErrors] : [])].join('\n')
    navigator.clipboard?.writeText(text).then(() => toast('Diagnostics copied'), () => toast('Couldn’t copy', 'error'))
  }
  return (
    <section className="settings-block" id="diagnostics">
      <h2 className="section-title">Diagnostics</h2>
      <dl className="download-facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {isNative() && (
        <>
          <h3 className="settings-subtitle">Recent playback events</h3>
          {events.length === 0 ? <p className="hint">None yet.</p> : (
            <ol className="diagnostic-events">
              {[...events].reverse().map((e, i) => <li key={i}>{e}</li>)}
            </ol>
          )}
          <button type="button" className="button button--quiet" onClick={copy}>Copy diagnostics</button>
        </>
      )}
    </section>
  )
}
