import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type ConnectionFacts, deriveConnection, displayHost, isPandaHealth } from './connection.ts'
import { normalizeServerUrl } from './server.ts'

const ready: ConnectionFacts = { native: true, hasServer: true, probe: 'pandafm', ownerConfigured: true, signedIn: true, musicServerConfigured: true, musicServerOk: true }

describe('the connection state machine (5.3)', () => {
  it('Android with no saved server asks for one; a browser never does', () => {
    assert.equal(deriveConnection({ native: true, hasServer: false, probe: 'pending' }), 'no-server')
    assert.equal(deriveConnection({ native: false, hasServer: true, probe: 'pending' }), 'checking')
  })

  it('a saved server that does not answer is a recovery screen, not a lost configuration', () => {
    assert.equal(deriveConnection({ ...ready, probe: 'unreachable' }), 'server-unreachable')
    assert.equal(deriveConnection({ ...ready, probe: 'not-pandafm' }), 'server-unreachable')
  })

  it('Continue offline plays downloads while the server is away, and steps aside when it is back', () => {
    assert.equal(deriveConnection({ ...ready, probe: 'unreachable', offlineChosen: true }), 'offline')
    assert.equal(deriveConnection({ ...ready, offlineChosen: true }), 'ready')
  })

  it('an unfinished installation goes to the right setup step', () => {
    assert.equal(deriveConnection({ ...ready, ownerConfigured: false, signedIn: false }), 'setup-required')
    assert.equal(deriveConnection({ ...ready, musicServerConfigured: false }), 'music-server-required')
  })

  it('a reachable server without a session is sign-in, never "unavailable"', () => {
    assert.equal(deriveConnection({ ...ready, signedIn: false }), 'sign-in-required')
    assert.equal(deriveConnection({ ...ready, signedIn: false, musicServerOk: false }), 'sign-in-required')
  })

  it('a music server that is down is degraded PandaFM, not an address problem', () => {
    assert.equal(deriveConnection({ ...ready, musicServerOk: false }), 'degraded')
  })

  it('everything fine is ready; unknown auth is still checking', () => {
    assert.equal(deriveConnection(ready), 'ready')
    assert.equal(deriveConnection({ ...ready, signedIn: undefined }), 'checking')
  })
})

describe('recognising a PandaFM server', () => {
  const health = { service: 'pandafm', status: 'degraded', version: '5.3.0', database: { ok: true }, navidrome: { ok: false, configured: false } }
  it('accepts PandaFM (and older PandaFM without the service marker)', () => {
    assert.equal(isPandaHealth(health), true)
    const { service: _, ...older } = health
    assert.equal(isPandaHealth(older), true)
  })
  it('rejects other web servers and other JSON', () => {
    for (const body of [null, 'hello', { status: 'ok' }, { ...health, service: 'something-else' }, { version: '1', status: 'ok' }, { ok: true, version: 'x', status: 'y', database: null, navidrome: {} }]) {
      assert.equal(isPandaHealth(body), false, JSON.stringify(body))
    }
  })
  it('shows only the host of a saved server', () => {
    assert.equal(displayHost('https://music.example.com/pandafm'), 'music.example.com')
    assert.equal(displayHost('http://192.168.1.20:8085'), '192.168.1.20:8085')
  })
})

describe('server address normalisation', () => {
  it('prefers https and trims trailing slashes', () => {
    assert.equal(normalizeServerUrl('music.example.com'), 'https://music.example.com')
    assert.equal(normalizeServerUrl('https://music.example.com/'), 'https://music.example.com')
    assert.equal(normalizeServerUrl('  https://music.example.com// '), 'https://music.example.com')
    assert.equal(normalizeServerUrl('https://music.example.com/api'), 'https://music.example.com')
  })
  it('refuses non-web addresses and embedded credentials', () => {
    assert.throws(() => normalizeServerUrl(''))
    assert.throws(() => normalizeServerUrl('ftp://music.example.com'))
    assert.throws(() => normalizeServerUrl('https://me:pw@music.example.com'))
  })
})
