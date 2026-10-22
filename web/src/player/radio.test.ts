import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Track } from '../api/library'
import type { ListeningEvent } from './events'
import { createRadioController, type RadioApi, type RadioPickOut } from './radio.ts'
import { createPlayerStore, currentTrack } from './store.ts'
import type { EngineEvent, PlaybackEngine } from './types'

class QuietEngine implements PlaybackEngine {
  listeners = new Set<(e: EngineEvent) => void>()
  loaded: string[] = []
  load(src: string) { this.loaded.push(src) }
  play() { return Promise.resolve() }
  pause() {}
  seek() {}
  stop() {}
  setVolume() {}
  subscribe(l: (e: EngineEvent) => void) { this.listeners.add(l); return () => this.listeners.delete(l) }
  emit(e: EngineEvent) { for (const l of this.listeners) l(e) }
}

const track = (id: string): Track => ({
  id, title: id, artist: 'A', artist_id: null, album: null, album_id: null, cover_art_id: null, duration_seconds: 200,
  track_number: null, disc_number: null, year: null, genres: [], content_type: null, suffix: null, bitrate_kbps: null, favorite: false,
})

let nextSelection = 1
const pick = (id: string): RadioPickOut => ({ selection_id: nextSelection++, track: track(id), reasons: ['Similar genre'], score: 1, breakdown: {} })
const session = { id: 'rs1', mode: 'panda', mode_label: 'Panda Radio', status: 'active', seed_kind: 'track', seed_name: 'seed', skips: 0, completions: 0, exploration: 0 }
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(extend?: RadioApi['extend']) {
  const engine = new QuietEngine()
  const store = createPlayerStore({ engine, streamUrl: (id) => `/s/${id}`, explainError: async () => '' })
  const calls = { extend: [] as { upcoming: number[] }[], end: 0 }
  const listeners = new Set<(e: ListeningEvent) => void>()
  const reporter = { flush: async () => {}, subscribe: (l: (e: ListeningEvent) => void) => { listeners.add(l); return () => listeners.delete(l) } }
  const api: RadioApi = {
    start: async () => ({ session, seed_track: track('seed'), picks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(pick) }),
    extend: extend ?? (async (_id, upcoming) => {
      calls.extend.push({ upcoming })
      return { session, replaced: [], picks: [pick(`more${calls.extend.length}`), pick(`more${calls.extend.length}b`)] }
    }),
    end: async () => { calls.end++ },
  }
  let clock = 0
  const timers: (() => void)[] = []
  const controller = createRadioController({ api, store, reporter, now: () => clock, setTimer: (fn) => timers.push(fn) })
  const skipEvent = (selectionId: number) => {
    for (const l of listeners) l({ type: 'skip', radio_session_id: 'rs1', radio_selection_id: selectionId } as ListeningEvent)
  }
  return { engine, store, controller, calls, skipEvent, advance: (ms: number) => { clock += ms }, timers }
}

const ids = (store: ReturnType<typeof setup>['store']) => store.getState().items.map((i) => i.track.id)

describe('Panda Radio controller', () => {
  it('starts with the seed song, then the radio picks, in the shared queue', async () => {
    const { store, controller, engine } = setup()
    await controller.start('panda', { kind: 'track', id: 'seed' })
    assert.deepEqual(ids(store).slice(0, 3), ['seed', 'r1', 'r2'])
    assert.equal(currentTrack(store.getState())?.id, 'seed')
    assert.equal(store.getState().source?.radio?.modeLabel, 'Panda Radio')
    assert.deepEqual(engine.loaded, ['/s/seed'])
  })

  it('tops up once when fewer than five radio songs are queued, never twice at once', async () => {
    const { store, controller, calls } = setup()
    await controller.start('panda', null)
    for (let i = 0; i < 3; i++) store.getState().next() // 6 picks queued after the seed -> 3 left
    await flush()
    assert.equal(calls.extend.length, 1)
    assert.equal(calls.extend[0].upcoming.length, 4) // still ahead when it asked (the threshold crossing)
    await flush()
    assert.equal(calls.extend.length, 1)
  })

  it('a radio skip re-plans the queued radio songs but keeps Play next songs', async () => {
    let replaced: number[] = []
    const { store, controller, skipEvent } = setup(async (_id, upcoming) => {
      replaced = upcoming.slice(1)
      return { session, replaced, picks: [pick('new1'), pick('new2')] }
    })
    await controller.start('panda', null)
    store.getState().playNext([track('mine')])
    skipEvent(1)
    await flush()
    await flush()
    const queue = ids(store)
    assert.ok(queue.includes('mine'), 'the listener’s own pick survives steering')
    assert.equal(queue[1], 'mine')
    assert.ok(queue.includes('new1') && queue.includes('new2'))
    for (const gone of replaced) assert.ok(!store.getState().items.some((i) => i.radio?.selectionId === gone))
  })

  it('keeps playing and retries later when the server is unreachable', async () => {
    let fail = true
    const { store, controller, advance, timers } = setup(async () => {
      if (fail) throw new Error('offline')
      return { session, replaced: [], picks: [pick('late')] }
    })
    await controller.start('panda', null)
    for (let i = 0; i < 3; i++) store.getState().next()
    await flush()
    const playing = currentTrack(store.getState())?.id
    assert.equal(timers.length, 1) // a retry is scheduled
    fail = false
    advance(20_000)
    timers.shift()!()
    await flush()
    assert.equal(currentTrack(store.getState())?.id, playing)
    assert.ok(ids(store).includes('late'))
  })

  it('ending radio stops top-ups and leaves the queue playable', async () => {
    const { store, controller, calls } = setup()
    await controller.start('panda', null)
    await controller.end()
    for (let i = 0; i < 4; i++) store.getState().next()
    await flush()
    assert.equal(calls.end, 1)
    assert.equal(calls.extend.length, 0)
    assert.equal(store.getState().source?.kind, 'tracks')
    assert.equal(currentTrack(store.getState())?.id, 'r4')
  })
})
