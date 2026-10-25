import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filterGenres, stationSubtitle } from './stationText.ts'

const genres = [
  { name: 'Rock', songs: 120, family: 'rock' }, { name: 'Pop Punk', songs: 40, family: 'punk' },
  { name: 'Alternative Rock', songs: 60, family: 'rock' }, { name: 'Film Score', songs: 30, family: 'soundtrack' },
  ...Array.from({ length: 200 }, (_, i) => ({ name: `Genre ${i}`, songs: 1, family: null })),
]

describe('stations', () => {
  it('the genre picker searches and never floods the screen', () => {
    assert.equal(filterGenres(genres, '', []).length, 60)
    assert.deepEqual(filterGenres(genres, 'rock', []).map((g) => g.name), ['Rock', 'Alternative Rock'])
    assert.deepEqual(filterGenres(genres, 'punk', ['Film Score']).map((g) => g.name), ['Pop Punk']) // filter applies to chosen too
    assert.equal(filterGenres(genres, '', ['Genre 199'])[0].name, 'Genre 199') // chosen ones come first
  })

  it('station subtitles say what and how, quietly', () => {
    const rock = { genres: ['Rock'], preset: 'panda', preset_name: 'Panda Radio', preset_missing: false }
    assert.equal(stationSubtitle(rock), 'Rock')
    assert.equal(stationSubtitle({ ...rock, genres: ['Pop Punk', 'Emo', 'Alternative Rock'], preset: 'familiar', preset_name: 'Familiar' }), 'Pop Punk · Emo +1 — Familiar')
    assert.match(stationSubtitle({ ...rock, preset_missing: true }), /playing as Panda/)
  })
})
