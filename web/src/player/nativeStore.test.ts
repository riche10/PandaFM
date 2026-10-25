import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNativeQueueStore, fromSnapshot } from './nativeStore.ts'

function fakePlugin() {
  const calls: [string, unknown][] = []
  const listeners: Record<string, (e: never) => void> = {}
  const snapshot = JSON.stringify({ items: [{ uid: 'u1', track: { id: 'a', title: 'A' }, origin: 'context' }], index: 0, source: { kind: 'album', name: 'X' }, shuffle: false, repeat: 'off', status: 'paused', error: null, positionMs: 42000, durationMs: 200000 })
  const plugin = new Proxy({}, {
    get: (_t, name: string) => {
      if (name === 'addListener') return (event: string, l: (e: never) => void) => { listeners[event] = l; return Promise.resolve({ remove: async () => {} }) }
      if (name === 'getSnapshot') return () => Promise.resolve({ snapshot })
      return (options: unknown) => { calls.push([name, options]); return Promise.resolve({}) }
    },
  })
  return { plugin: plugin as never, calls, emit: (event: string, e: unknown) => listeners[event](e as never) }
}

describe('Android: the player store mirrors the native queue', () => {
  it('actions are commands to the playback service and change nothing locally', () => {
    const f = fakePlugin()
    const store = createNativeQueueStore(f.plugin)
    const s = store.getState()
    s.playCollection([{ id: 'a' }, { id: 'b' }] as never, { startIndex: 1, source: { kind: 'playlist', name: 'Mix' } })
    s.playNext([{ id: 'c' }] as never)
    s.moveInQueue('u1', -1)
    s.jumpTo('u1')
    s.next()
    s.seek(30)
    assert.deepEqual(f.calls.map(([n]) => n), ['replaceQueue', 'playNext', 'move', 'jumpTo', 'next', 'seek'])
    assert.equal((f.calls[0][1] as { startIndex: number }).startIndex, 1)
    assert.equal(JSON.parse((f.calls[0][1] as { tracks: string }).tracks).length, 2)
    assert.equal(store.getState().items.length, 0) // nothing changes until the service says so
  })

  it('snapshots and state events update the mirror', () => {
    const f = fakePlugin()
    const store = createNativeQueueStore(f.plugin)
    f.emit('queue', { reason: 'queue', snapshot: JSON.stringify({ items: [{ uid: 'u9', track: { id: 'z' }, origin: 'manual' }], index: 0, source: null, shuffle: true, repeat: 'one', status: 'playing', error: null, positionMs: 5000, durationMs: 100000 }) })
    assert.deepEqual([store.getState().items[0].uid, store.getState().shuffle, store.getState().repeat, store.getState().status], ['u9', true, 'one', 'playing'])
    f.emit('state', { status: 'paused', positionMs: 61500, durationMs: 100000, error: null, gen: 3 })
    assert.deepEqual([store.getState().status, store.getState().position], ['paused', 61.5])
  })

  it('radio picks go to the service, which refills radio itself', () => {
    const f = fakePlugin()
    const s = createNativeQueueStore(f.plugin).getState()
    s.startRadio([{ track: { id: 'r1' } as never, radio: { sessionId: 'S', selectionId: 7, reasons: [] } }], { kind: 'radio', name: 'Rock Radio', radio: { sessionId: 'S', mode: 'panda', modeLabel: 'Rock Radio', seedName: null } })
    s.addRadio([1], [])
    const [name, options] = f.calls[0] as [string, { picks: string }]
    assert.equal(name, 'applyRadio')
    assert.deepEqual(JSON.parse(options.picks), [{ selection_id: 7, track: { id: 'r1' }, reasons: [] }])
    assert.equal(f.calls.length, 1) // addRadio is the service's job on Android
  })

  it('ignores malformed snapshots', () => {
    assert.equal(fromSnapshot('{nope'), null)
    assert.equal(fromSnapshot('{"items":"x"}'), null)
  })
})
