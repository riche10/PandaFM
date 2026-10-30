import assert from 'node:assert/strict'
import { afterEach, it, mock, suite } from 'node:test'
import { resetQualityForTests, setStreamQuality, startNetworkWatch, streamQualitySetting } from './network.ts'
import { configurePlatform } from './state.ts'

// 5.5: start-up and re-renders must never change a fixed quality; only a real choice is sent; and the
// native setting is adopted even when the first read comes before the player is up.
type Read = 'original' | 'high' | 'fail' | 'missing'

function fakePlayer(reads: Read[]) {
  const sent: string[] = []
  const handlers: Record<string, ((e: unknown) => void)[]> = {}
  let n = 0
  const player = {
    setPreferences: async (o: { streamQuality?: string }) => { sent.push(o.streamQuality ?? '') },
    getDiagnostics: async () => {
      const r = reads[Math.min(n++, reads.length - 1)]
      if (r === 'fail') throw new Error('not ready')
      return { diagnostics: JSON.stringify(r === 'missing' ? {} : { streamQualitySetting: r }) }
    },
    addListener: async (event: string, fn: (e: unknown) => void) => {
      (handlers[event] ??= []).push(fn)
      return { remove: async () => { handlers[event] = (handlers[event] ?? []).filter((f) => f !== fn) } }
    },
  }
  return {
    player: player as never, sent, handlers,
    reads: () => n,
    emit: (event: string) => [...(handlers[event] ?? [])].forEach((f) => f({})),
  }
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

suite('5.5 streaming quality hydration', () => {
  afterEach(() => {
    resetQualityForTests('auto')
    configurePlatform({ player: null })
    mock.timers.reset()
  })

  it('with nothing saved, start-up sends nothing and adopts the native setting', async () => {
    const p = fakePlayer(['original'])
    configurePlatform({ player: p.player })
    startNetworkWatch() // no localStorage here: nothing was saved on this device
    await settle()
    assert.deepEqual(p.sent, []) // the default "auto" never overwrites the phone's "original"
    assert.equal(streamQualitySetting(), 'original')
    setStreamQuality('original') // the same choice again
    assert.deepEqual(p.sent, [])
    setStreamQuality('high')
    setStreamQuality('high')
    assert.deepEqual(p.sent, ['high']) // one real change, sent once
  })

  it('a player that arrives late is still asked, once it is available', async () => {
    startNetworkWatch() // too early: no player yet
    await settle()
    assert.equal(streamQualitySetting(), 'auto')
    const p = fakePlayer(['original'])
    configurePlatform({ player: p.player })
    await settle()
    assert.equal(streamQualitySetting(), 'original')
    assert.deepEqual(p.sent, [])
  })

  it('a read rejected too early is retried when the player says something', async () => {
    const p = fakePlayer(['fail', 'original'])
    configurePlatform({ player: p.player })
    startNetworkWatch()
    await settle()
    assert.equal(streamQualitySetting(), 'auto')
    p.emit('state') // the service is up
    await settle()
    assert.equal(streamQualitySetting(), 'original')
    p.emit('queue')
    p.emit('state')
    await settle()
    assert.equal(p.reads(), 2) // retried exactly once, then done
    assert.deepEqual(p.handlers.state ?? [], []) // and stopped listening
  })

  it('a choice made meanwhile cancels the pending adoption', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const p = fakePlayer(['fail', 'original'])
    configurePlatform({ player: p.player })
    startNetworkWatch()
    await settle()
    setStreamQuality('high') // the user picks before the player answers
    p.emit('state')
    mock.timers.tick(5000)
    await settle()
    assert.equal(streamQualitySetting(), 'high')
    assert.deepEqual(p.sent, ['high'])
    assert.equal(p.reads(), 1) // no late read at all
  })

  it('a player that never answers is asked at most 4 times', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const p = fakePlayer(['fail'])
    configurePlatform({ player: p.player })
    startNetworkWatch()
    await settle()
    p.emit('state')
    await settle()
    configurePlatform({ player: p.player })
    await settle()
    for (const ms of [1000, 3000, 5000]) {
      mock.timers.tick(ms)
      await settle()
    }
    assert.ok(p.reads() <= 4, `asked ${p.reads()} times`)
    assert.equal(streamQualitySetting(), 'auto')
    assert.deepEqual(p.handlers.state ?? [], [])
    assert.deepEqual(p.handlers.queue ?? [], [])
  })
})
