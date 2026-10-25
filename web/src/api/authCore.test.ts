import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { authHeaders, csrfFromCookie, isUnsafe, onUnauthorized } from './authCore.ts'

describe('auth headers', () => {
  it('browser writes carry the CSRF token from the readable cookie; reads don’t', () => {
    const cookie = 'theme=dark; pandafm_csrf=abc%2D123; other=1'
    assert.equal(csrfFromCookie(cookie), 'abc-123')
    assert.deepEqual(authHeaders('POST', cookie, null), { 'X-PandaFM-CSRF': 'abc-123' })
    assert.deepEqual(authHeaders('delete', cookie, null), { 'X-PandaFM-CSRF': 'abc-123' })
    assert.deepEqual(authHeaders('GET', cookie, null), {})
    assert.deepEqual(authHeaders(undefined, cookie, null), {})
    assert.equal(csrfFromCookie('pandafm_session=never-readable'), null)
  })

  it('the Android app sends its access token as a header, never in a URL', () => {
    assert.deepEqual(authHeaders('GET', '', 'tok'), { Authorization: 'Bearer tok' })
    assert.deepEqual(authHeaders('POST', 'pandafm_csrf=x', 'tok'), { Authorization: 'Bearer tok' })
    assert.equal(isUnsafe('PATCH'), true)
    assert.equal(isUnsafe('HEAD'), false)
  })

  it('a 401 refreshes an expired token, otherwise shows sign-in or setup', () => {
    assert.equal(onUnauthorized('token_expired'), 'refresh')
    assert.equal(onUnauthorized('setup_required'), 'setup')
    assert.equal(onUnauthorized('session_expired'), 'signed-out')
    assert.equal(onUnauthorized(null), 'signed-out')
  })
})
