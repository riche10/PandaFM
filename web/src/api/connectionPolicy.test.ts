import assert from 'node:assert/strict'
import { afterEach, beforeEach, it, mock, suite } from 'node:test'
import { isUsableState } from '../platform/connection.ts'
import { configurePlatform, platform } from '../platform/state.ts'
import { authStore } from './auth.ts'
import { checkConnection, connectionStore, noteConnectionEvent, resetConnectionForTests } from './connection.ts'

// 5.5.1: a usable app is never torn down by one failed probe; stale results never win.
type Mode = 'ok' | 'down' | 'auth-down'
let mode: Mode = 'ok'
let calls = 0
const HEALTH = { service: 'pandafm', version: '5.5.1', status: 'ok', database: { ok: true }, navidrome: { ok: true } }
const SETUP = { owner_configured: true, music_server_configured: true, ready: true, setup_token_required: false }
const STATUS = { signed_in: true, setup_required: false, username: 'panda', https: false }
const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

function serve(url: string) {
  calls++
  if (mode === 'down') throw new TypeError('Failed to fetch')
  if (url.endsWith('/health')) return reply(HEALTH)
  if (url.endsWith('/setup/state')) return reply(SETUP)
  if (url.endsWith('/auth/status')) {
    if (mode === 'auth-down') throw new TypeError('Failed to fetch')
    return reply(STATUS)
  }
  return reply({})
}

const state = () => connectionStore.getState()

suite('5.5.1 connection policy', () => {
  beforeEach(() => {
    resetConnectionForTests()
    authStore.setState({ state: 'unknown' })
    configurePlatform({ kind: 'web', server: '', player: null, auth: null } as never)
    mode = 'ok'
    calls = 0
    globalThis.fetch = (async (input: string) => serve(String(input))) as never
  })
  afterEach(() => {
    resetConnectionForTests()
    mock.timers.reset()
  })

  it('a cold start that can\'t reach the server shows the full unreachable screen', async () => {
    mode = 'down'
    await checkConnection({ trigger: 'launch' })
    assert.equal(state().state, 'server-unreachable')
  })

  it('once usable, one failed probe keeps the app (interrupted) with a quiet banner', async () => {
    await checkConnection()
    assert.equal(state().state, 'ready')
    mode = 'down'
    await checkConnection({ trigger: 'back online' })
    assert.equal(state().state, 'interrupted')
    assert.ok(isUsableState(state().state)) // the gate keeps the app (Now Playing, the queue) mounted
    assert.equal(state().failures, 1)
  })

  it('repeated failures stay non-destructive; the first success is ready at once', async () => {
    await checkConnection()
    mode = 'down'
    for (let k = 0; k < 3; k++) await checkConnection({ fresh: true })
    assert.equal(state().state, 'interrupted')
    assert.equal(state().failures, 3)
    mode = 'ok'
    await checkConnection({ fresh: true, trigger: 'try again' })
    assert.equal(state().state, 'ready')
    assert.equal(state().failures, 0)
  })

  it('a failed probe never touches native playback', async () => {
    const touched: string[] = []
    const player = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { touched.push(String(name)); void args; return Promise.resolve() } })
    configurePlatform({ player: player as never })
    await checkConnection()
    mode = 'down'
    await checkConnection({ fresh: true })
    assert.equal(state().state, 'interrupted')
    assert.deepEqual(touched, []) // no pause, stop, clear or replace: Media3 keeps playing
    assert.equal(platform.player, player)
  })

  it('a stale failure that lands after a newer success is ignored', async () => {
    await checkConnection()
    let release: () => void = () => undefined
    globalThis.fetch = (async (input: string) => {
      if (String(input).endsWith('/health')) {
        await new Promise<void>((r) => { release = r })
        throw new TypeError('Failed to fetch') // the old probe fails... late
      }
      return serve(String(input))
    }) as never
    const stale = checkConnection({ trigger: 'back online' })
    globalThis.fetch = (async (input: string) => serve(String(input))) as never
    await checkConnection({ fresh: true, trigger: 'try again' }) // a newer check succeeds first
    assert.equal(state().state, 'ready')
    release()
    await stale
    assert.equal(state().state, 'ready') // the late failure didn't win
    assert.equal(state().failures, 0)
  })

  it('a transient auth failure after use is not a sign-out', async () => {
    await checkConnection()
    authStore.setState({ state: 'signed-in' })
    mode = 'auth-down' // /health answers, /auth/status doesn't (offline auth state)
    await checkConnection({ fresh: true })
    assert.notEqual(state().state, 'sign-in-required')
    assert.ok(isUsableState(state().state))
  })

  it('a changed server address starts over: its failure shows the full screen', async () => {
    configurePlatform({ kind: 'android', server: 'https://one.example' } as never)
    await checkConnection()
    assert.ok(isUsableState(state().state))
    configurePlatform({ server: 'https://two.example' } as never)
    mode = 'down'
    await checkConnection({ fresh: true, trigger: 'server changed' })
    assert.equal(state().state, 'server-unreachable')
  })

  it('while interrupted it checks again by itself, and recovers', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    await checkConnection()
    mode = 'down'
    await checkConnection({ fresh: true })
    assert.equal(state().state, 'interrupted')
    mode = 'ok'
    const before = calls
    mock.timers.tick(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setImmediate(r))
    assert.ok(calls > before, 'a re-check ran')
    assert.equal(state().state, 'ready')
  })

  // ── 5.5.2: a UI restarted under live playback; Panda Mix edits ──
  it('a UI restarted under a live session is not a first launch: a failed probe is interrupted', async () => {
    const marks: string[] = []
    configurePlatform({ kind: 'android', server: 'https://one.example',
      player: { getSession: async () => ({ usableServer: 'https://one.example', serviceRunning: true }), markSessionUsable: async (o: { server: string }) => { marks.push(o.server) } } } as never)
    mode = 'down'
    await checkConnection({ trigger: 'launch' })
    assert.equal(state().state, 'interrupted') // the app, Now Playing and the queue stay
    assert.ok(state().events.some((e) => e.includes('app restarted under a live session')))
  })

  it('a different server in the native session marker is still a first launch', async () => {
    configurePlatform({ kind: 'android', server: 'https://two.example',
      player: { getSession: async () => ({ usableServer: 'https://one.example', serviceRunning: true }) } } as never)
    mode = 'down'
    await checkConnection({ trigger: 'launch' })
    assert.equal(state().state, 'server-unreachable')
  })

  it('once usable, the native session is marked (for a UI restart later)', async () => {
    const marks: string[] = []
    configurePlatform({ kind: 'android', server: 'https://one.example',
      player: { getSession: async () => ({ usableServer: null, serviceRunning: true }), markSessionUsable: async (o: { server: string }) => { marks.push(o.server) } } } as never)
    await checkConnection()
    assert.equal(state().state, 'ready')
    assert.deepEqual(marks, ['https://one.example'])
  })

  it('a health probe failing during a Panda Mix edit, after the app was usable, is interrupted', async () => {
    await checkConnection()
    noteConnectionEvent('Panda Mix edit while playing: mode flow')
    mode = 'down'
    await checkConnection({ fresh: true, trigger: 'back online' })
    assert.equal(state().state, 'interrupted')
    assert.ok(state().events.some((e) => e.includes('Panda Mix edit while playing')))
  })
})
