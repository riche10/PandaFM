import { type FormEvent, useEffect, useState } from 'react'
import { apiGet, apiSend } from '../../api/client'

export interface MusicServerInfo {
  configured: boolean
  url: string | null
  username: string | null
  managed_by_env: boolean
}

export const getMusicServer = () => apiGet<MusicServerInfo>('/settings/music-server')

/**
 * The external Navidrome / OpenSubsonic server PandaFM plays from (5.3). PandaFM tests the
 * connection before saving; the password is sent once and never shown again.
 */
export function MusicServerForm({ info, onSaved, firstRun = false }: { info: MusicServerInfo | null; onSaved: (info: MusicServerInfo) => void; firstRun?: boolean }) {
  const [url, setUrl] = useState(info?.url ?? 'http://')
  const [username, setUsername] = useState(info?.username ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (info?.managed_by_env) {
    return (
      <p className="hint">
        This server ({info.url}, as {info.username}) is set by the <code>PANDAFM_NAVIDROME_*</code> environment variables. PandaFM has copied it
        (password encrypted); remove those variables and restart to manage it here.
      </p>
    )
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      onSaved(await apiSend<MusicServerInfo>('PUT', '/settings/music-server', { url: url.trim(), username: username.trim(), password: password || undefined }))
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'PandaFM couldn’t connect to that server.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="setup-form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span className="field-label">Server address</span>
        <input className="field-input" type="url" inputMode="url" autoComplete="url" required placeholder="http://192.168.1.20:4533" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Username</span>
        <input className="field-input" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input className="field-input" type="password" autoComplete="current-password" required={!info?.configured} placeholder={info?.configured ? 'Unchanged' : ''} value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button" disabled={busy}>{busy ? 'Testing the connection…' : firstRun ? 'Connect' : 'Test & save'}</button>
    </form>
  )
}

/** Settings › Music server. */
export function MusicServerSettings() {
  const [info, setInfo] = useState<MusicServerInfo | null>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    getMusicServer().then(setInfo, () => setInfo(null))
  }, [])
  return (
    <section className="settings-block" id="music-server">
      <h2 className="section-title">Music server</h2>
      {info?.configured && !editing ? (
        <>
          <p>PandaFM plays from <strong>{info.url}</strong> as {info.username}.</p>
          {!info.managed_by_env && <button type="button" className="button button--quiet" onClick={() => setEditing(true)}>Change music server</button>}
          {info.managed_by_env && <MusicServerForm info={info} onSaved={setInfo} />}
        </>
      ) : (
        <MusicServerForm info={info} onSaved={(i) => { setInfo(i); setEditing(false) }} />
      )}
    </section>
  )
}

/** First run: right after the owner signs in, before any library shows. */
export function MusicServerSetup({ onDone }: { onDone: () => void }) {
  return (
    <div className="setup">
      <h1 className="setup-title">Connect your music server</h1>
      <p className="hint">
        PandaFM plays your library from your own Navidrome (or another OpenSubsonic) server. Enter its address and a user PandaFM can sign in as.
      </p>
      <MusicServerForm info={null} onSaved={onDone} firstRun />
    </div>
  )
}
