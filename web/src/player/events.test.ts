import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createReporter, type ListeningEvent } from './events.ts'

const event = (n: number, type: ListeningEvent['type'] = 'play_started'): ListeningEvent => ({
  event_id: `e${n}`, type, play_id: 'p1', occurred_at: '2026-10-22T12:00:00Z', position_s: 0, duration_s: 200,
  source: 'album', mode: null, radio_session_id: null, radio_selection_id: null, details: {},
  track: { id: 't1', title: 'Night Run', artist: 'Neon Panda', artist_id: null, album: null, album_id: null, genres: [], year: null, duration_seconds: 200, cover_art_id: null },
})

/** Timers run only when the test says so. */
function manualTimers() {
  const pending: (() => void)[] = []
  return {
    setTimer: (fn: () => void) => pending.push(fn),
    clearTimer: () => {},
    runAll: async () => {
      while (pending.length) pending.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

describe('event reporter', () => {
  it('sends buffered events together and empties the buffer', async () => {
    const sent: string[][] = []
    const timers = manualTimers()
    const reporter = createReporter({ send: async (events) => void sent.push(events.map((e) => e.event_id)), ...timers })
    reporter.report(event(1))
    reporter.report(event(2, 'skip'))
    await timers.runAll()
    assert.deepEqual(sent, [['e1', 'e2']])
    assert.equal(reporter.pending(), 0)
  })

  it('retries a failed batch later with the same event ids', async () => {
    const attempts: string[][] = []
    let online = false
    const timers = manualTimers()
    const reporter = createReporter({
      send: async (events) => {
        attempts.push(events.map((e) => e.event_id))
        if (!online) throw new Error('offline')
      },
      ...timers,
    })
    reporter.report(event(1, 'play_completed'))
    await timers.runAll()
    assert.equal(reporter.pending(), 1)
    online = true
    await timers.runAll()
    assert.deepEqual(attempts, [['e1'], ['e1']]) // same id: the server stores it once
    assert.equal(reporter.pending(), 0)
  })

  it('keeps unsent events across a restart', async () => {
    let saved: string | null = null
    const storage = { load: () => saved, save: (v: string) => void (saved = v) }
    const first = createReporter({ send: async () => { throw new Error('offline') }, storage, ...manualTimers() })
    first.report(event(7))
    const sent: string[] = []
    const timers = manualTimers()
    createReporter({ send: async (events) => void sent.push(...events.map((e) => e.event_id)), storage, ...timers })
    await timers.runAll()
    assert.deepEqual(sent, ['e7'])
  })

  it('tells subscribers about every event', () => {
    const seen: string[] = []
    const reporter = createReporter({ send: async () => {}, ...manualTimers() })
    reporter.subscribe((e) => void seen.push(e.type))
    reporter.report(event(1, 'skip'))
    assert.deepEqual(seen, ['skip'])
  })

  it('keeps a long offline session and sends all of it, once, when back online', async () => {
    const sent: string[] = []
    let online = false
    const timers = manualTimers()
    const reporter = createReporter({
      send: async (events) => {
        if (!online) throw new Error('offline')
        sent.push(...events.map((e) => e.event_id))
      },
      ...timers,
    })
    for (let i = 0; i < 250; i++) reporter.report(event(i, i % 2 ? 'skip' : 'play_started'))
    await timers.runAll()
    assert.equal(reporter.pending(), 250)
    online = true
    while (reporter.pending()) await reporter.flush() // the reconnect hook drains the buffer
    assert.equal(sent.length, 250)
    assert.equal(new Set(sent).size, 250)
    assert.equal(reporter.pending(), 0)
  })
})
