import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apiUrl } from '../api/client.ts'
import { checkServer, normalizeServerUrl } from './server.ts'
import { configurePlatform } from './state.ts'

describe('server address', () => {
  it('normalises what people type', () => {
    assert.equal(normalizeServerUrl(' music.example.com/ '), 'https://music.example.com')
    assert.equal(normalizeServerUrl('https://music.example.com/pandafm/api/'), 'https://music.example.com/pandafm')
    assert.equal(normalizeServerUrl('http://192.168.1.20:8085'), 'http://192.168.1.20:8085')
    assert.throws(() => normalizeServerUrl('ftp://x'), /https/)
    assert.throws(() => normalizeServerUrl('https://me:secret@x.com'), /passwords/)
  })

  it('checks that it really is a healthy PandaFM', async () => {
    const reply = (body: object, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    const healthy = await checkServer('music.example.com', reply({ status: 'ok', version: '0.1.0', database: { ok: true }, navidrome: { ok: true } }))
    assert.equal(healthy.ok, true)
    assert.deepEqual(healthy.steps.map((s) => s.label), ['PandaFM server found', 'Database healthy', 'Navidrome healthy'])
    const sick = await checkServer('music.example.com', reply({ version: '0.1.0', database: { ok: true }, navidrome: { ok: false, detail: 'down' } }))
    assert.equal(sick.ok, false)
    assert.equal(sick.steps[2].ok, false)
    const other = await checkServer('example.com', reply({ hello: 'world' }))
    assert.match(other.message ?? '', /isn’t a PandaFM server/)
    const offline = await checkServer('http://10.0.0.5', (async () => { throw new TypeError('failed') }) as unknown as typeof fetch)
    assert.match(offline.message ?? '', /https/)
  })
})

describe('API addresses', () => {
  it('stay relative in a browser and use the configured server in the app', () => {
    configurePlatform({ kind: 'web', server: '' })
    assert.equal(apiUrl('/health'), '/api/health')
    configurePlatform({ kind: 'android', server: 'https://music.example.com' })
    assert.equal(apiUrl('/health'), 'https://music.example.com/api/health')
    configurePlatform({ kind: 'web', server: '' })
  })
})
