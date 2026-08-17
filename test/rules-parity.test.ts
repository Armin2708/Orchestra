import { describe, expect, it } from 'vitest'
import { renderSessionStart } from '../src/hooks.js'
import { compactRules, conductorRules, hookRules, verboseRules } from '../src/rules.js'

// Parity audit: the shipped discipline must survive every rules variant AND the
// composed session-start text an agent actually receives. Phrasings below are pinned
// to the ACTUAL wording in src/rules.ts — change the rule and this test tells you
// which surface silently lost a directive.
const DISCIPLINE: Array<[string, RegExp]> = [
  ['card registration before edits', /orchestra card create/],
  ['review, never done', /move review, never done|move to review/],
  ['completion mail to the operator', /orchestra mail/],
  ['worktree isolation, no shared-checkout branching', /worktree/i],
  ['session memory', /orchestra remember/],
]

const board = { name: 'agentboard', project_path: '/proj' }
const snap = { agents: [{ id: 1, name: 'me-agent', status: 'active' }], cards: [], open_questions: [] }

describe('injected rules parity', () => {
  for (const [label, pattern] of DISCIPLINE) {
    it(`compact rules cover ${label}`, () => {
      expect(compactRules('teal-ibex')).toMatch(pattern)
    })

    it(`verbose rules cover ${label}`, () => {
      expect(verboseRules('teal-ibex')).toMatch(pattern)
    })

    it(`conductor rules cover ${label} in both modes`, () => {
      expect(conductorRules('teal-ibex')).toMatch(pattern)
      process.env.ORCHESTRA_VERBOSE_RULES = '1'
      try {
        expect(conductorRules('teal-ibex')).toMatch(pattern)
      } finally {
        delete process.env.ORCHESTRA_VERBOSE_RULES
      }
    })

    it(`session-start injection carries ${label}`, () => {
      const text = renderSessionStart({ id: 1, name: 'me-agent' }, board, snap, '/proj')
      expect(text).toMatch(pattern)
    })
  }

  it('hook rules are the compact variant plus the output-discipline block by default', () => {
    expect(hookRules('teal-ibex')).toContain(compactRules('teal-ibex'))
  })
})
