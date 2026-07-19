// Output-discipline rules (#57): the block must appear in every role variant in both
// rules modes, stay under the input-cost cap, and vanish under the rollback flag.
import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  OUTPUT_DISCIPLINE, outputDiscipline, verboseOutput, hookRules, conductorRules,
} from '../src/rules.js'
import { openDb } from '../src/db.js'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor } from '../src/conductor.js'

const tok = (chars: number) => Math.ceil(chars / 4)

afterEach(() => {
  delete process.env.ORCHESTRA_VERBOSE_OUTPUT
  delete process.env.ORCHESTRA_VERBOSE_RULES
})

it('the discipline block costs under 60 input tokens', () => {
  expect(tok(OUTPUT_DISCIPLINE.length)).toBeLessThan(60)
})

it('appears exactly once in hook and conductor rules, in both rules modes', () => {
  for (const flag of [undefined, '1']) {
    if (flag) process.env.ORCHESTRA_VERBOSE_RULES = flag
    else delete process.env.ORCHESTRA_VERBOSE_RULES
    for (const rules of [hookRules('ab-runner'), conductorRules('ab-runner')]) {
      expect(rules.split(OUTPUT_DISCIPLINE)).toHaveLength(2) // present, once
      expect(rules.endsWith(OUTPUT_DISCIPLINE)).toBe(true)   // appended at the end
    }
  }
})

it('ORCHESTRA_VERBOSE_OUTPUT=1 rolls the block back everywhere', () => {
  process.env.ORCHESTRA_VERBOSE_OUTPUT = '1'
  expect(verboseOutput()).toBe(true)
  expect(outputDiscipline()).toBe('')
  expect(hookRules('ab-runner')).not.toContain('OUTPUT:')
  expect(conductorRules('ab-runner')).not.toContain('OUTPUT:')
  delete process.env.ORCHESTRA_VERBOSE_OUTPUT
  expect(outputDiscipline()).toBe(`\n${OUTPUT_DISCIPLINE}`)
})

it('strategist and auditor role prompts carry the block (and drop it under rollback)', () => {
  const appended: string[] = []
  ;(query as any).mockImplementation((args: any) => {
    appended.push(args.options.systemPrompt.append)
    return { interrupt: async () => {}, async *[Symbol.asyncIterator]() { /* never yields */ } }
  })
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  const conductor = new Conductor(db, new EventEmitter())
  conductor.hire({ boardId: 1, cwd: '/p', role: 'strategist' })
  conductor.hire({ boardId: 1, cwd: '/p', role: 'auditor' })
  conductor.hire({ boardId: 1, cwd: '/p' })
  for (const a of appended) expect(a.split(OUTPUT_DISCIPLINE)).toHaveLength(2)

  process.env.ORCHESTRA_VERBOSE_OUTPUT = '1'
  appended.length = 0
  conductor.hire({ boardId: 1, cwd: '/p', role: 'strategist', name: 'terse-off' })
  expect(appended[0]).not.toContain('OUTPUT:')
})
