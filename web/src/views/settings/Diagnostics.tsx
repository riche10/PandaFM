import { useEffect, useState } from 'react'
import { resolveSource } from '../../offline'
import { useCurrentTrack } from '../../player'
import { isNative, platform } from '../../platform/state'

/** What's actually playing, and how: for troubleshooting. Never shows credentials. */
export function Diagnostics() {
  const track = useCurrentTrack()
  const [engine, setEngine] = useState(isNative() && platform.player ? 'Checking…' : 'HTML audio (browser)')
  useEffect(() => {
    platform.player?.getState().then((s) => setEngine(s.engine), () => setEngine('Native player unavailable'))
  }, [])
  const source = track ? resolveSource(track.id) : null
  const scheme = source ? (source.match(/^([a-z]+):/i)?.[1] ?? 'relative') : null
  const rows: [string, string][] = [
    ['Platform', isNative() ? 'Android' : 'Browser'],
    ['Playback engine', engine],
    ['Source', !source ? 'Nothing playing' : source.startsWith('content:') || source.includes('_capacitor_content_') ? 'Downloaded' : 'Server stream'],
    ['Source URI type', scheme ? (scheme === 'content' ? 'content' : scheme.toUpperCase()) : '—'],
    ['Codec', track?.quality ? `${track.quality.codec}${track.quality.detail ? ` · ${track.quality.detail}` : ''}` : '—'],
    ['Artwork', isNative() ? 'Fetched through the PandaFM API' : 'Direct from the PandaFM server'],
  ]
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
    </section>
  )
}
