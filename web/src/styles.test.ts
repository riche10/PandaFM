import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { transform } from 'lightningcss'

/**
 * 5.4 regression: a merge in 5.3 dropped one closing brace in styles.css, so every rule after it
 * (5.3 multi-select, first-run setup, ...) silently nested inside `.offline-banner span` and stopped
 * applying. Plain CSS rules here must never open inside another plain rule.
 */
describe('styles.css', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('has balanced braces and no rule accidentally nested inside another', () => {
    const stack: string[] = []
    let start = 0
    let line = 1
    for (let i = 0; i < css.length; i++) {
      const ch = css[i]
      if (ch === '\n') line++
      if (ch === '{') {
        const selector = css.slice(start, i).trim()
        const parent = stack[stack.length - 1]
        if (parent !== undefined && !parent.startsWith('@')) {
          assert.fail(`line ${line}: "${selector.slice(0, 60)}" opens inside "${parent.slice(0, 60)}" (a missing "}"?)`)
        }
        stack.push(selector)
        start = i + 1
      } else if (ch === '}') {
        assert.ok(stack.length > 0, `line ${line}: an extra "}"`)
        stack.pop()
        start = i + 1
      } else if (ch === ';' && stack.length > 0) {
        start = i + 1
      }
    }
    assert.deepEqual(stack, [], `unclosed: ${stack.join(' > ')}`)
  })

  it('compiles with the same CSS engine as the production build', () => {
    const code = readFileSync(new URL('./styles.css', import.meta.url))
    assert.doesNotThrow(() => transform({ filename: 'styles.css', code, minify: true, errorRecovery: false }))
  })
})
