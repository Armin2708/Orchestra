import { afterEach, describe, expect, it } from 'vitest'
import { renderSessionStart } from '../src/hooks.js'
import { compactRules, conductorCompactRules, conductorRules, hookRules, verboseRules } from '../src/rules.js'

afterEach(() => { delete process.env.ORCHESTRA_VERBOSE_RULES })

// every standing directive must survive the diet — these are the load-bearing phrases
const DIRECTIVES = [
  'orchestra card create',        // register a card...
  '--column in_progress',         // ...in progress...
  '--paths',                      // ...with claimed paths
  'Before your first file edit',  // ...before edits
  'orchestra ask',                // overlap-ask before starting
  'wait for the answer',
  '⚠ overlap',
  '≈ similar',
  'card update/move',             // keep the card updated / moved
  'done when finished',
  'paths claimed by another active card', // don't touch claimed paths
  'Subagents NEVER run orchestra commands', // subagent prohibition
  'snapshot --full',              // where the full board lives now
]

describe('compact rules', () => {
  it('keeps every directive keyword', () => {
    const text = compactRules('teal-ibex')
    for (const d of DIRECTIVES) expect(text).toContain(d)
  })

  it('fits in 150 tokens (ceil(chars/4), the token_telemetry estimate)', () => {
    expect(Math.ceil(compactRules('teal-ibex').length / 4)).toBeLessThanOrEqual(150)
  })

  it('conductor variant keeps its extra directives on top of the core rules', () => {
    const text = conductorCompactRules('teal-ibex')
    for (const d of DIRECTIVES) expect(text).toContain(d)
    expect(text).toContain('prerequisite steps')
    expect(text).toContain('orchestra reply <msg-id>')
    expect(text).toContain('npx -y orchestra-board')
  })

  it('ORCHESTRA_VERBOSE_RULES=1 restores the old text, read per call', () => {
    expect(hookRules('x')).toBe(compactRules('x'))
    process.env.ORCHESTRA_VERBOSE_RULES = '1'
    expect(hookRules('x')).toBe(verboseRules('x'))
    expect(conductorRules('x')).toContain('REQUIRED before starting any task')
    delete process.env.ORCHESTRA_VERBOSE_RULES
    expect(hookRules('x')).toBe(compactRules('x'))
  })
})

describe('session-start injection', () => {
  // 20-card board modeled on a live one: long ticket titles, claimed paths, chatty questions
  const me = { id: 1, name: 'me-agent' }
  const board = { name: 'agentboard', project_path: '/proj' }
  const snap = {
    agents: [
      { id: 1, name: 'me-agent', status: 'active' },
      ...Array.from({ length: 6 }, (_, i) => ({ id: i + 2, name: `agent-${i}`, status: 'active' })),
      { id: 9, name: 'gone-agent', status: 'gone' },
    ],
    cards: Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      column: i % 3 === 0 ? 'backlog' : 'in_progress',
      title: `Ticket ${i}: a reasonably descriptive title about one feature area`,
      owner: i % 4 === 0 ? null : `agent-${i % 6}`,
      paths: i % 4 === 1 ? [] : [`src/module${i}/impl.ts`, `src/module${i}/types.ts`, `web/src/View${i}.tsx`, `test/module${i}.test.ts`],
    })),
    open_questions: Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      from_name: `agent-${i % 6}`,
      to_name: i % 4 === 0 ? 'me-agent' : i % 4 === 1 ? null : `agent-${(i + 1) % 6}`,
      body: 'Boundary question about scope and interfaces: which endpoints, response envelopes, event shapes and file regions do you own, and what should I build against while your side is still in flight? '.repeat(2),
    })),
  }

  it('compact injection is ≤40% of the verbose baseline on a 20-card board', () => {
    process.env.ORCHESTRA_VERBOSE_RULES = '1'
    const baseline = renderSessionStart(me, board, snap, '/proj')
    delete process.env.ORCHESTRA_VERBOSE_RULES
    const compact = renderSessionStart(me, board, snap, '/proj')
    expect(baseline).toContain('- agent agent-0: active')
    expect(compact.length).toBeLessThanOrEqual(0.4 * baseline.length)
  })

  it('compact keeps unowned cards, own cards, cwd-overlapping cards, and my/broadcast questions', () => {
    const compact = renderSessionStart(me, board, snap, '/proj/src/module2')
    expect(compact).toContain('- #1 [')  // unowned (i=0)
    expect(compact).toContain('- #3 [in_progress]') // paths overlap cwd (i=2 → src/module2)
    expect(compact).not.toContain('- #4 [') // owned by another agent, cwd elsewhere
    expect(compact).toContain('- Q#1 ') // addressed to me
    expect(compact).toContain('- Q#2 ') // broadcast
    expect(compact).not.toContain('- Q#3 ') // someone else's
    expect(compact).toContain('6 other active agent(s)')
    expect(compact).not.toContain('- agent agent-0') // no per-agent list
  })
})
