import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('Agent Team Operating Model documentation', () => {
  it('ships and links the planned organizational contract', () => {
    const manifest = JSON.parse(read('package.json')) as { files?: string[] }
    const readme = read('README.md')
    const agentOs = read('docs/agent-os.md')
    const program = read('docs/north-star-delivery-program.md')

    expect(manifest.files).toContain('docs/agent-team-operating-model.md')
    expect(readme).toContain('[Agent Team Operating Model]')
    expect(agentOs).toContain('[Agent Team Operating Model]')
    expect(program).toContain('[Agent Team Operating Model]')
    expect(program).toContain('151 / 400 checklist boxes delivered; 249 remain open')
    expect(program).toContain('| Cross-cutting — Agent organization operating system | 0 / 25 | 25 |')
  })

  it('defines the complete ORG backlog without claiming implementation', () => {
    const model = read('docs/agent-team-operating-model.md')

    expect(model).toContain('Status: **planned, not implemented**')
    expect(model).toContain('`ORG-001` through `ORG-024` and `ORG-GATE`')
    expect(model).toContain('Identity is not role and role is not authority')
    expect(model).toContain('author and final approver are distinct principals and sessions')
    expect(model).toContain('Raw thoughts, keystrokes, hours online, lines of')
    expect(model).toContain('INSUFFICIENT_EVIDENCE')
    expect(model).toContain('## `ORG-GATE` acceptance scenario')
    const ids = [...model.matchAll(/^\| (ORG-(?:\d{3}|GATE)) \|/gm)]
      .map((match) => match[1])
    expect(ids).toEqual([
      ...Array.from({ length: 24 }, (_, index) =>
        `ORG-${String(index + 1).padStart(3, '0')}`),
      'ORG-GATE',
    ])
  })

  it('cites the professional governance and assurance sources', () => {
    const model = read('docs/agent-team-operating-model.md')

    for (const source of [
      'The SPACE of Developer Productivity',
      "DORA's software delivery performance metrics",
      'Team Topologies',
      'Google Engineering Practices',
      'NIST — AI Risk Management Framework',
      'NIST — Role Based Access Control FAQ',
      'SLSA v1.2 — Provenance',
    ]) {
      expect(model).toContain(source)
    }
  })
})
