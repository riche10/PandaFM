import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type DraftAction, draftReducer, initialDraft, stationPayload, type StationDraft } from './stationDraft.ts'

const run = (start: StationDraft, ...actions: DraftAction[]) => actions.reduce(draftReducer, start)

describe('station draft with an inline radio style', () => {
  it('a new station starts on Panda Radio, explicitly', () => {
    const d = initialDraft(null)
    assert.equal(d.style, 'panda')
    assert.deepEqual(stationPayload({ ...d, name: 'Rock', genres: ['Rock'] }), { name: 'Rock', genres: ['Rock'], preset: null })
  })

  it('an existing custom style can be chosen', () => {
    const d = run(initialDraft(null), { type: 'name', value: 'Metal' }, { type: 'toggleGenre', genre: 'Metalcore' }, { type: 'style', id: 'uuid-discovery-plus' })
    assert.deepEqual(stationPayload(d), { name: 'Metal', genres: ['Metalcore'], preset: 'uuid-discovery-plus' })
  })

  it('creating a style keeps the station draft, then selects the new style', () => {
    const filled = run(initialDraft(null), { type: 'name', value: 'Pop Punk Drive' }, { type: 'toggleGenre', genre: 'Pop Punk' },
      { type: 'toggleGenre', genre: 'Emo' }, { type: 'query', value: 'pu' })
    const editing = draftReducer(filled, { type: 'newStyle' })
    assert.equal(editing.view, 'style')
    assert.deepEqual([editing.name, editing.genres, editing.query], ['Pop Punk Drive', ['Pop Punk', 'Emo'], 'pu'])
    const back = draftReducer(editing, { type: 'styleSaved', id: 'uuid-deep-cuts' })
    assert.deepEqual([back.view, back.style, back.name, back.genres, back.query], ['station', 'uuid-deep-cuts', 'Pop Punk Drive', ['Pop Punk', 'Emo'], 'pu'])
  })

  it('cancelling (or Android Back) returns to the station unchanged', () => {
    const filled = run(initialDraft(null), { type: 'name', value: 'X' }, { type: 'toggleGenre', genre: 'Rock' }, { type: 'style', id: 'familiar' })
    const back = run(filled, { type: 'newStyle' }, { type: 'styleCancelled' })
    assert.deepEqual(back, filled)
  })

  it('editing a station starts from its own style and can switch to a new one', () => {
    const d = initialDraft({ name: 'Rock Radio', genres: ['Rock'], preset: 'familiar' })
    assert.equal(d.style, 'familiar')
    const after = run(d, { type: 'newStyle' }, { type: 'styleSaved', id: 'uuid-new' })
    assert.deepEqual(stationPayload(after), { name: 'Rock Radio', genres: ['Rock'], preset: 'uuid-new' })
  })

  it('“Customize a copy” starts a new style from the selected one, never editing it', () => {
    const d = draftReducer(initialDraft(null), { type: 'customizeStyle', from: { name: 'Discovery', base_mode: 'discovery', controls: { familiarity: 20, discovery: 90 } } })
    assert.deepEqual(d.styleSeed, { name: 'Discovery copy', base: 'discovery', controls: { familiarity: 20, discovery: 90 } })
    assert.equal(d.style, 'panda') // the selection only changes once the copy is saved
  })

  it('genres (what) and the style reference (how) stay separate in the payload', () => {
    const payload = stationPayload(run(initialDraft(null), { type: 'name', value: 'J-Rock' }, { type: 'toggleGenre', genre: 'J-Rock' }, { type: 'style', id: 'uuid' }))
    assert.deepEqual(Object.keys(payload).sort(), ['genres', 'name', 'preset'])
    assert.ok(!('controls' in payload) && !('base_mode' in payload))
  })
})
