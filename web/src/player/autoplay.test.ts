import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Track } from '../api/library'
import { createAutoplay, DEFAULT_AUTOPLAY, seedFor } from './autoplay.ts'
import { createRadioController, type RadioApi, type RadioPickOut } from './radio.ts'
import { createPlayerStore, hasNext, type PlaybackReport } from './store.ts'
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
  id, title: `Song ${id}`, artist: 'Nelly Furtado', artist_id: 'ar1', album: 'Loose', album_id: 'al1', cover_art_id: null, duration_seconds: 200,
  track_number: null, disc_number: null, year: null, genres: [], content_type: null, suffix: null, bitrate_kbps: null, favorite: false,
})

let selection = 1
const pick = (id: string): RadioPickOut => ({ selection_id: selection++, track: track(id), reasons: ['Similar genre'], score: 1, breakdown: {} })
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(options: { enabled?: boolean; online?: boolean; fail?: boolean; slow?: boolean } = {}) {
  const engine = new QuietEngine()
  const reports: PlaybackReport[] = []
  let autoplayRef: ReturnType<typeof createAutoplay> | null = null
  const store = createPlayerStore({
    engine, streamUrl: (id) => `/s/${id}`, explainError: async () => '', report: (e) => reports.push(e),
    onQueueEnd: () => void autoplayRef?.onQueueEnd(),
  })
  const calls = { start: [] as { preset: string; seed: unknown }[], end: [] as string[] }
  let release: (() => void) | null = null
  const api: RadioApi = {
    start: async (preset, seed) => {
      calls.start.push({ preset, seed })
      if (options.slow) await new Promise<void>((r) => { release = r })
      if (options.fail) throw new Error('server down')
      return {
        session: { id: `rs${calls.start.length}`, mode: 'panda', mode_label: 'Panda Radio', preset_id: preset, status: 'active', seed_kind: 'track', seed_name: 'Promiscuous', skips: 0, completions: 0, exploration: 0 },
        seed_track: null,
        picks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(pick),
      }
    },
    extend: async () => ({ session: {} as never, replaced: [], picks: [] }),
    end: async (id) => { calls.end.push(id) },
  }
  const reporter = { flush: async () => {}, subscribe: () => () => {} }
  const radio = createRadioController({ api, store, reporter, setTimer: () => 0, onEnd: () => autoplayRef?.suppress() })
  const notices: string[] = []
  const settings = { ...DEFAULT_AUTOPLAY, enabled: options.enabled ?? true }
  const autoplay = createAutoplay({ store, radio, settings: () => settings, online: () => options.online ?? true, notify: (m) => notices.push(m) })
  autoplayRef = autoplay
  const finish = async () => {
    engine.emit({ type: 'playing' })
    engine.emit({ type: 'ended' })
    await flush()
  }
  return { engine, store, radio, autoplay, calls, reports, notices, finish, settings, release: () => release?.() }
}

const ids = (s: ReturnType<typeof setup>['store']) => s.getState().items.map((i) => i.track.id)

describe('Autoplay', () => {
  it('continues a single song with Panda Radio seeded from it, without calling it a skip', async () => {
    const t = setup()
    t.store.getState().playCollection([track('promiscuous')], { source: { kind: 'tracks', name: 'Search' } })
    await t.finish()
    assert.deepEqual(t.calls.start, [{ preset: 'panda', seed: { kind: 'track', id: 'promiscuous' } }])
    const s = t.store.getState()
    assert.deepEqual(ids(t.store).slice(0, 2), ['promiscuous', 'r1'])
    assert.equal(s.index, 1)
    assert.equal(s.source?.kind, 'radio')
    assert.equal(s.source?.radio?.autoplay, true)
    assert.equal(s.source?.radio?.modeLabel, 'Panda Radio')
    const first = t.reports.filter((r) => r.item.track.id === 'promiscuous').map((r) => r.type)
    assert.deepEqual(first, ['play_started', 'play_completed']) // no skip
    assert.deepEqual(t.notices, ['Panda Radio · Based on Promiscuous'])
  })

  it('an album keeps its songs in the queue and seeds radio from the album', async () => {
    const t = setup()
    t.store.getState().playCollection([track('a1'), track('a2')], { source: { kind: 'album', id: 'al9', name: 'Loose' } })
    await t.finish()
    assert.equal(t.calls.start.length, 0) // track 2 next, not radio
    await t.finish()
    assert.deepEqual(t.calls.start[0].seed, { kind: 'album', id: 'al9' })
    assert.deepEqual(ids(t.store).slice(0, 3), ['a1', 'a2', 'r1'])
    assert.equal(t.store.getState().index, 2)
  })

  it('seeds from the artist for artist playback and from the last song otherwise', () => {
    const items = [{ uid: 'u', track: track('last'), origin: 'context' as const }]
    assert.deepEqual(seedFor({ items, index: 0, source: { kind: 'artist', id: 'ar7', name: 'X' } }), { kind: 'artist', id: 'ar7' })
    for (const kind of ['playlist', 'favorites', 'search', 'songs'] as const) {
      assert.deepEqual(seedFor({ items, index: 0, source: { kind, id: 'p', name: 'X' } }), { kind: 'track', id: 'last' })
    }
  })

  it('Repeat One and Repeat All keep the music you chose', async () => {
    for (const presses of [1, 2]) {
      const t = setup()
      t.store.getState().playCollection([track('x')], { source: { kind: 'tracks', name: 'x' } })
      for (let i = 0; i < presses; i++) t.store.getState().cycleRepeat()
      assert.notEqual(t.store.getState().repeat, 'off')
      await t.finish()
      assert.equal(t.calls.start.length, 0)
    }
  })

  it('Play Next and Add to Queue songs come before Autoplay', async () => {
    const t = setup()
    t.store.getState().playCollection([track('x')], { source: { kind: 'tracks', name: 'x' } })
    t.store.getState().playNext([track('next')])
    t.store.getState().addToQueue([track('later')])
    await t.finish()
    await t.finish()
    assert.equal(t.calls.start.length, 0)
    assert.equal(t.store.getState().items[t.store.getState().index].track.id, 'later')
    await t.finish()
    assert.deepEqual(t.calls.start[0].seed, { kind: 'track', id: 'later' })
  })

  it('never starts a second session while radio is already playing', async () => {
    const t = setup()
    await t.radio.start('panda', { kind: 'track', id: 's' })
    t.store.getState().jumpTo(t.store.getState().items.at(-1)!.uid)
    await t.finish()
    assert.equal(t.calls.start.length, 1)
  })

  it('after End Radio, the end of the queue stays the end; new music allows it again', async () => {
    const t = setup()
    await t.radio.start('panda', { kind: 'track', id: 's' })
    await t.radio.end()
    t.store.getState().jumpTo(t.store.getState().items.at(-1)!.uid)
    await t.finish()
    assert.equal(t.calls.start.length, 1) // only the one you started
    assert.equal(t.store.getState().status, 'ended')
    t.store.getState().playCollection([track('fresh')], { source: { kind: 'tracks', name: 'x' } })
    await t.finish()
    assert.equal(t.calls.start.length, 2)
  })

  it('stays off when disabled or offline, and the queue simply ends', async () => {
    for (const opts of [{ enabled: false }, { online: false }]) {
      const t = setup(opts)
      t.store.getState().playCollection([track('x')], { source: { kind: 'tracks', name: 'x' } })
      await t.finish()
      assert.equal(t.calls.start.length, 0)
      assert.equal(t.store.getState().status, 'ended')
      assert.deepEqual(ids(t.store), ['x'])
    }
  })

  it('a failed start leaves the finished queue intact, says so once and does not retry', async () => {
    const t = setup({ fail: true })
    t.store.getState().playCollection([track('x')], { source: { kind: 'tracks', name: 'x' } })
    await t.finish()
    await t.autoplay.onQueueEnd() // a second signal for the same ending
    assert.equal(t.calls.start.length, 1)
    assert.deepEqual(ids(t.store), ['x'])
    assert.equal(t.store.getState().status, 'ended')
    assert.deepEqual(t.notices, ['Couldn’t continue with Panda Radio'])
  })

  it('duplicate end signals create one session', async () => {
    const t = setup({ slow: true })
    t.store.getState().playCollection([track('x')], { source: { kind: 'tracks', name: 'x' } })
    t.engine.emit({ type: 'playing' })
    t.engine.emit({ type: 'ended' })
    void t.autoplay.onQueueEnd()
    void t.autoplay.onQueueEnd()
    t.release()
    await flush()
    assert.equal(t.calls.start.length, 1)
  })

  it('if you pick something else while it asks, your choice wins and the session is ended', async () => {
    const t = setup({ slow: true })
    t.store.getState().playCollection([track('x')], { source: { kind: 'tracks', name: 'x' } })
    t.engine.emit({ type: 'playing' })
    t.engine.emit({ type: 'ended' })
    t.store.getState().playCollection([track('mine')], { source: { kind: 'tracks', name: 'mine' } })
    t.release()
    await flush()
    assert.deepEqual(ids(t.store), ['mine'])
    assert.deepEqual(t.calls.end, ['rs1'])
  })

  it('Next becomes available for the lock screen once radio picks arrive', async () => {
    const t = setup({ slow: true })
    t.store.getState().playCollection([track('x')], { source: { kind: 'tracks', name: 'x' } })
    t.engine.emit({ type: 'playing' })
    t.engine.emit({ type: 'ended' })
    assert.equal(hasNext(t.store.getState()), false)
    t.release()
    await flush()
    t.store.getState().pause()
    assert.equal(hasNext(t.store.getState()), true)
  })
})
