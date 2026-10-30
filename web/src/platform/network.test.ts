import assert from 'node:assert/strict'
import { it, suite } from 'node:test'
import { setStreamQuality, startNetworkWatch, streamQualitySetting } from './network.ts'
import { platform } from './state.ts'

// 5.5: start-up and re-renders must never change a fixed quality; only a real choice is sent.
suite('5.5 streaming quality hydration', () => {
  it('with nothing saved, start-up sends nothing and adopts the native setting', async () => {
    const sent: string[] = []
    platform.player = {
      setPreferences: async (o: { streamQuality?: string }) => { sent.push(o.streamQuality ?? '') },
      getDiagnostics: async () => ({ diagnostics: JSON.stringify({ streamQualitySetting: 'original' }) }),
    } as never
    startNetworkWatch() // no localStorage here: nothing was saved on this device
    await new Promise((r) => setTimeout(r, 0))
    assert.deepEqual(sent, []) // the default "auto" never overwrites the phone's "original"
    assert.equal(streamQualitySetting(), 'original')
    setStreamQuality('original') // the same choice again
    assert.deepEqual(sent, [])
    setStreamQuality('high')
    setStreamQuality('high')
    assert.deepEqual(sent, ['high']) // one real change, sent once
    platform.player = null
  })
})
