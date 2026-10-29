import assert from 'node:assert/strict'
import { describe as suite, it } from 'node:test'
import { AUTO_CHECK_EVERY_MS, describe, shouldAutoCheck, type UpdateState } from './updates.ts'

const base: UpdateState = { phase: 'idle', installed: { versionName: '5.4.1', versionCode: 50401 }, latest: null, received: 0, total: 0, error: null }

suite('5.4.1 self-hosted updates (JS)', () => {
  it('checks automatically at most every 12 hours', () => {
    const now = 1_800_000_000_000
    assert.equal(shouldAutoCheck(null, now), true)
    assert.equal(shouldAutoCheck(now - 60_000, now), false)
    assert.equal(shouldAutoCheck(now - AUTO_CHECK_EVERY_MS, now), true)
    assert.equal(shouldAutoCheck(now + 60_000, now), true) // a clock that moved back
    assert.equal(shouldAutoCheck(Number.NaN, now), true)
  })

  it('says plainly what is going on', () => {
    assert.equal(describe({ ...base, phase: 'current' }), 'PandaFM is up to date')
    assert.equal(describe({ ...base, phase: 'available', latest: { status: 'available', installedCode: 50401, versionName: '5.4.2', versionCode: 50402 } }), 'Update available: PandaFM 5.4.2')
    assert.equal(describe({ ...base, phase: 'downloading', received: 5, total: 10 }), 'Downloading… 50%')
    assert.equal(describe({ ...base, phase: 'needs-permission' }), 'Allow PandaFM to install apps (Android asks once), then come back')
    assert.equal(describe({ ...base, phase: 'newer-installed' }), 'This device has a newer PandaFM than the server offers')
    assert.equal(describe({ ...base, phase: 'error', error: null }), 'Couldn’t check for updates')
  })
})

// ── 5.4.1: the update flow against a fake updater plugin ──
import { platform } from './platform/state.ts'
import { checkForUpdates, downloadUpdate, installUpdate, updateStore } from './updates.ts'

const initial = { phase: 'idle', installed: null, latest: null, received: 0, total: 0, error: null } as const
function fakeUpdater(over: Record<string, unknown> = {}) {
  return {
    info: async () => ({ versionName: '5.4.0', versionCode: 50400 }),
    check: async () => ({ status: 'available', versionName: '5.4.1', versionCode: 50401, size: 1000, downloaded: false }),
    download: async () => undefined,
    cancel: async () => undefined,
    install: async () => ({ needsPermission: false }),
    addListener: async () => ({ remove: async () => undefined }),
    ...over,
  } as never
}

suite('5.4.1 update flow', () => {
  it('maps each check result to what Settings shows', async () => {
    for (const [status, phase] of [['available', 'available'], ['current', 'current'], ['newer-installed', 'newer-installed'], ['none', 'none']]) {
      updateStore.setState({ ...initial })
      platform.updater = fakeUpdater({ check: async () => ({ status, versionCode: 50401, downloaded: false }) })
      await checkForUpdates(true)
      assert.equal(updateStore.getState().phase, phase)
    }
  })

  it('a failed automatic check stays silent; a manual one says so', async () => {
    platform.updater = fakeUpdater({ check: async () => { throw new Error('network down') } })
    updateStore.setState({ ...initial })
    await checkForUpdates(false)
    assert.deepEqual([updateStore.getState().phase, updateStore.getState().error], ['idle', null]) // nothing scary, nothing shown
    await checkForUpdates(true)
    assert.equal(updateStore.getState().phase, 'error')
    assert.match(describe(updateStore.getState()), /network down|Couldn’t check/)
  })

  it('a failed download goes back to "available" and stops listening for progress', async () => {
    let removed = false
    platform.updater = fakeUpdater({ download: async () => { throw new Error('The download doesn’t match the release (SHA-256)') }, addListener: async () => ({ remove: async () => { removed = true } }) })
    updateStore.setState({ ...initial, phase: 'available' })
    await downloadUpdate()
    assert.equal(updateStore.getState().phase, 'available')
    assert.match(updateStore.getState().error ?? '', /SHA-256/)
    assert.equal(removed, true)
  })

  it('"Install unknown apps" off: Settings asks for it; no installer: explained, not a crash', async () => {
    platform.updater = fakeUpdater({ install: async () => ({ needsPermission: true }) })
    updateStore.setState({ ...initial, phase: 'ready' })
    await installUpdate()
    assert.equal(updateStore.getState().phase, 'needs-permission')
    platform.updater = fakeUpdater({ install: async () => { throw new Error('No app on this device can install updates') } })
    updateStore.setState({ ...initial, phase: 'ready' })
    await installUpdate()
    assert.equal(updateStore.getState().phase, 'ready')
    assert.match(updateStore.getState().error ?? '', /No app on this device/)
    platform.updater = null
  })
})
