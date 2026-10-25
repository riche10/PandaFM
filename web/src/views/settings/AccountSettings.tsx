import { useEffect, useState } from 'react'
import { apiGet, apiSend } from '../../api/client'
import { signOut, useAuth } from '../../api/auth'
import { toast } from '../../library'
import { platform } from '../../platform/state'

interface Device {
  id: string
  device_name: string
  platform: string
  kind: string
  created_at: string
  last_seen_at: string
  current: boolean
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

/** Settings › Account & devices: who's signed in where, and how to end it. */
export function AccountSettings() {
  const { username, https } = useAuth()
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [pwError, setPwError] = useState<string | null>(null)
  const reload = () => apiGet<Device[]>('/auth/devices').then(setDevices, () => setDevices([]))
  useEffect(() => {
    void reload()
  }, [])

  const revoke = async (d: Device) => {
    if (!window.confirm(`Sign out “${d.device_name}”? It will need your password again.`)) return
    await apiSend('DELETE', `/auth/devices/${d.id}`).catch(() => undefined)
    toast(`Signed out ${d.device_name}`)
    void reload()
  }
  const revokeOthers = async () => {
    if (!window.confirm('Sign out every other device? Each will need your password again. Downloaded music stays on them.')) return
    const r = await apiSend<{ revoked: number }>('POST', '/auth/devices/revoke-others').catch(() => null)
    toast(r ? `Signed out ${r.revoked} other device${r.revoked === 1 ? '' : 's'}` : 'Couldn’t sign out the other devices', r ? 'info' : 'error')
    void reload()
  }
  const changePassword = async () => {
    setPwError(null)
    if (pw.next !== pw.confirm) return setPwError('The new passwords don’t match.')
    try {
      await apiSend('POST', '/auth/password', { current_password: pw.current, new_password: pw.next })
      setPw({ current: '', next: '', confirm: '' })
      toast('Password changed. Your other devices were signed out.')
      void reload()
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Couldn’t change the password.')
    }
  }
  const secure = https || platform.server.startsWith('https://') || (typeof location !== 'undefined' && location.protocol === 'https:')

  return (
    <section className="settings-block" id="account">
      <h2 className="settings-title">Account &amp; devices</h2>
      <p>Signed in as <strong>{username ?? 'the owner'}</strong>.</p>
      <p className={secure ? 'hint' : 'field-warning'}>
        {secure ? 'Connected through HTTPS.' : 'This connection isn’t HTTPS. That’s fine at home; use HTTPS (a reverse proxy) before reaching PandaFM from outside.'}
      </p>
      <h3 className="settings-subtitle">Signed-in devices</h3>
      {devices === null ? <p className="hint">Loading…</p> : (
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id} className="device-row">
              <span className="device-name">{d.device_name}{d.current && <span className="device-badge">This device</span>}</span>
              <span className="device-sub">{d.kind === 'device' ? 'App' : 'Browser'} · {d.platform} · active {ago(d.last_seen_at)}</span>
              {!d.current && <button type="button" className="text-button" onClick={() => void revoke(d)}>Sign out</button>}
            </li>
          ))}
        </ul>
      )}
      <div className="settings-actions">
        <button type="button" className="button button--quiet" disabled={!devices || devices.length < 2} onClick={() => void revokeOthers()}>Sign out all other devices</button>
        <button type="button" className="button button--quiet" onClick={() => void signOut()}>Sign out</button>
      </div>
      <h3 className="settings-subtitle">Change password</h3>
      <form className="password-form" onSubmit={(e) => { e.preventDefault(); void changePassword() }}>
        <label className="field"><span className="field-label">Current password</span>
          <input className="field-input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
        <label className="field"><span className="field-label">New password</span>
          <input className="field-input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
        <label className="field"><span className="field-label">Confirm new password</span>
          <input className="field-input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
        {pwError && <p className="field-error" role="alert">{pwError}</p>}
        <button type="submit" className="button" disabled={!pw.current || !pw.next}>Change password</button>
      </form>
    </section>
  )
}
