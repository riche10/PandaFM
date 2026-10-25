import { useState } from 'react'
import { authStore, checkAuth, setupOwner, signIn, useAuth } from '../api/auth'
import { Icon } from '../components/Icon'
import { isNative, platform } from '../platform/state'

/**
 * Sign in to PandaFM, or (first time) create its owner with the administrator's
 * setup token. Shown outside the app shell, in its own scroll area.
 */
export function SignInView() {
  const { state } = useAuth()
  const setup = state === 'setup'
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (state === 'unreachable') {
    return (
      <div className="setup sign-in">
        <h1 className="setup-title">Can’t reach PandaFM</h1>
        <p className="hint">The server at {platform.server || 'this address'} isn’t answering. Check your connection, then try again.</p>
        <button type="button" className="button" onClick={() => { authStore.setState({ state: 'unknown' }); void checkAuth() }}>Try again</button>
      </div>
    )
  }

  const submit = async () => {
    setError(null)
    if (setup && password !== confirm) return setError('The passwords don’t match.')
    setBusy(true)
    try {
      if (setup) await setupOwner(token.trim(), username.trim(), password)
      else await signIn(username.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t sign in.')
      setBusy(false)
    }
  }

  return (
    <form className="setup sign-in" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <span className="sign-in-mark" aria-hidden="true"><Icon name="paw" /></span>
      <h1 className="setup-title">{setup ? 'Set up PandaFM' : 'Sign in to PandaFM'}</h1>
      <p className="hint">
        {setup
          ? 'Create the owner account. You need the setup token your administrator set as PANDAFM_SETUP_TOKEN.'
          : platform.server ? `Server: ${platform.server}` : 'Use your PandaFM owner account.'}
      </p>
      {setup && (
        <label className="field">
          <span className="field-label">Setup token</span>
          <input className="field-input" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} required />
        </label>
      )}
      <label className="field">
        <span className="field-label">Username</span>
        <input className="field-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input className="field-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} required />
      </label>
      {setup && (
        <label className="field">
          <span className="field-label">Confirm password</span>
          <input className="field-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
      )}
      {setup && <p className="hint">At least 10 characters. PandaFM stores only an Argon2id hash of it.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="submit" className="button" disabled={busy || !username.trim() || !password || (setup && !token.trim())}>
          {busy ? 'Please wait…' : setup ? 'Create owner and sign in' : 'Sign in'}
        </button>
        {isNative() && !setup && (
          <button type="button" className="button button--quiet" onClick={() => authStore.setState({ state: 'offline' })}>Continue offline</button>
        )}
      </div>
    </form>
  )
}
