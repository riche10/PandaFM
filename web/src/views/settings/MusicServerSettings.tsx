import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../api/auth'
import { checkConnection } from '../../api/connection'
import { getMusicServer, type MusicServerInfo, resyncLibrary } from '../../api/musicServer'
import { MusicServerForm } from '../../components/MusicServerForm'
import { toast } from '../../library'

const when = (iso: unknown) => (typeof iso === 'string' ? new Date(iso).toLocaleString() : '—')

/** Settings › Music server (the owner): where PandaFM's music comes from. */
export function MusicServerSettings() {
  const { state } = useAuth()
  const [info, setInfo] = useState<MusicServerInfo | null>(null)
  const [editing, setEditing] = useState(false)
  const load = useCallback(() => void getMusicServer().then(setInfo, () => setInfo(null)), [])
  useEffect(() => {
    if (state === 'signed-in') load()
  }, [state, load])
  if (state !== 'signed-in' || !info) return null
  const sync = info.sync ?? {}
  const last = (sync.last ?? sync.last_run ?? null) as Record<string, unknown> | null
  const rows: [string, string][] = [
    ['Address', info.url ?? 'Not connected'],
    ['Server', info.server_type ? `${info.server_type.replace('navidrome', 'Navidrome')} ${info.server_version ?? ''}`.trim() : '—'],
    ['Signed in as', info.username ?? '—'],
    ['Status', info.problem ?? (info.configured ? 'Connected' : 'Not connected')],
    ['Last library import', sync.running ? 'Importing now…' : when(last?.finished_at ?? last?.completed_at ?? sync.last_success_at)],
  ]
  return (
    <section className="settings-block" id="music-server">
      <h2 className="section-title">Music server</h2>
      <dl className="download-facts">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {editing ? (
        <MusicServerForm initial={info} editing={info.configured} onSaved={() => { setEditing(false); toast('Music server saved'); load(); void checkConnection() }} />
      ) : (
        <div className="setup-actions">
          <button type="button" className="button button--quiet" onClick={() => setEditing(true)}>{info.configured ? 'Change' : 'Connect'}</button>
          {info.configured && (
            <button type="button" className="button button--quiet" disabled={!!sync.running} onClick={() => void resyncLibrary().then(() => { toast('Re-importing your library'); load() }, () => toast('Couldn’t start the import', 'error'))}>Re-sync library</button>
          )}
        </div>
      )}
    </section>
  )
}
