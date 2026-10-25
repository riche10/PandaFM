import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AudioQuality } from '../api/library'
import { anyFilter, readFilters, writeFilters } from './filters.ts'
import { albumQuality } from './qualitySummary.ts'

const q = (codec: string, badge: AudioQuality['badge'], detail: string | null, lossless: boolean | null, hi = false): AudioQuality =>
  ({ codec, badge, detail, lossless, hi_res: hi, short: null, bitrate_kbps: null })

describe('album quality summary', () => {
  it('is exact only when every song shares it', () => {
    const cd = q('FLAC', 'LOSSLESS', '16-bit / 44.1 kHz', true)
    assert.equal(albumQuality([cd, cd, cd]), 'FLAC · LOSSLESS · 16-bit / 44.1 kHz')
    const hires = q('FLAC', 'HI-RES', '24-bit / 96 kHz', true, true)
    assert.equal(albumQuality([hires, cd]), 'Lossless · mixed formats') // never "24/96" for a mixed album
    assert.equal(albumQuality([hires, q('ALAC', 'HI-RES', '24-bit / 48 kHz', true, true)]), 'Hi-Res · mixed formats')
    assert.equal(albumQuality([cd, q('MP3', null, '44.1 kHz', false)]), 'Mixed quality')
    assert.equal(albumQuality([q('MP3', null, '44.1 kHz', false), q('MP3', null, '44.1 kHz', false)]), 'MP3 · 44.1 kHz')
  })

  it('says nothing when it doesn’t know', () => {
    assert.equal(albumQuality([]), null)
    assert.equal(albumQuality([q('FLAC', 'LOSSLESS', '16-bit / 44.1 kHz', true), null]), null)
  })
})

describe('library filters in the URL', () => {
  it('round-trip, keep other params and ignore junk', () => {
    const p = new URLSearchParams('sort=newest&genre=pop%20punk&decade=2010&fav=1&hires=1')
    const f = readFilters(p)
    assert.deepEqual(f, { genre: 'pop punk', decade: 2010, favorites: true, lossless: false, hires: true, downloaded: false })
    assert.equal(writeFilters(p, { ...f, decade: null, favorites: false }).toString(), 'sort=newest&genre=pop+punk&hires=1')
    assert.equal(readFilters(new URLSearchParams('decade=2015')).decade, null)
    assert.equal(anyFilter(readFilters(new URLSearchParams('sort=random'))), false)
  })
})
