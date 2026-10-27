import { type FormEvent, useState } from 'react'
import { type ConnectionTest, saveMusicServer, testMusicServer } from '../api/musicServer'

/** Address, username, password; Test connection, then Save. Shared by setup and Settings › Music server. */
export function MusicServerForm({ initial, editing = false, onSaved, saveLabel = 'Save' }: {
  initial?: { url?: string | null; username?: string | null }
  editing?: boolean
  onSaved: () => void
  saveLabel?: string
}) {
  const [url, setUrl] = useState(initial?.url ?? '')
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState('')
  const [result, setResult] = useState<ConnectionTest | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const changed = () => setResult(null)

  const test = async (event?: FormEvent) => {
    event?.preventDefault()
    setBusy('test')
    setError(null)
    try {
      setResult(await testMusicServer(url, username, password))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t test the connection.')
    }
    setBusy(null)
  }
  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      await saveMusicServer(url, username, password)
      setPassword('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the music server.')
    }
    setBusy(null)
  }
  return (
    <form className="music-server-form" onSubmit={(e) => void test(e)}>
      <label className="field">
        <span className="field-label">Music server address</span>
        <input className="field-input" type="url" inputMode="url" autoComplete="url" placeholder="https://navidrome.example.com" required value={url}
          onChange={(e) => { setUrl(e.target.value); changed() }} />
      </label>
      <label className="field">
        <span className="field-label">Username</span>
        <input className="field-input" autoComplete="username" autoCapitalize="none" required value={username} onChange={(e) => { setUsername(e.target.value); changed() }} />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input className="field-input" type="password" autoComplete="current-password" required={!editing} value={password}
          placeholder={editing ? 'Leave blank to keep the saved password' : undefined} onChange={(e) => { setPassword(e.target.value); changed() }} />
      </label>
      {result && <p className={result.ok ? 'form-note form-note--ok' : 'form-note form-note--error'} role="status">{result.message}</p>}
      {error && <p className="form-note form-note--error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="submit" className="button button--quiet" disabled={busy !== null}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        <button type="button" className="button" disabled={busy !== null || !result?.ok} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : saveLabel}</button>
      </div>
      <p className="hint">PandaFM keeps the password encrypted and never shows it again.</p>
    </form>
  )
}
