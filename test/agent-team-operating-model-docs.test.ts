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
    expect(program).toContain('176 / 400 checklist boxes delivered; 224 remain open')
    expect(program).toContain('| Cross-cutting — Agent organization operating system | 25 / 25 | 0 |')
  })

  it('defines the complete delivered ORG contract and its acceptance evidence', () => {
    const model = read('docs/agent-team-operating-model.md')

    expect(model).toContain('Status: **implemented and acceptance-verified**')
    expect(model).toContain('`ORG-001` through `ORG-024` and `ORG-GATE`')
    expect(model).toContain('## Delivered evidence')
    expect(model).toContain('restart-safe system gate `d68d4f8`')
    expect(model).toContain('focused governance coverage `cbfa636`')
    expect(model).toContain('Identity is not role and role is not authority')
    expect(model).toContain('author and final approver are distinct principals and sessions')
    expect(model).toContain('Raw thoughts, keystrokes, hours online, lines of')
    expect(model).toContain('INSUFFICIENT_EVIDENCE')
    expect(model).toContain('## `ORG-GATE` acceptance scenario')
    expect(model).toContain('`organization-gate.test.ts`')
    const backlogMirror = model.split('### Source-controlled ORG backlog mirror')[1]
      ?.split('### Implementation stages')[0] ?? ''
    const ids = [...backlogMirror.matchAll(/^\| (ORG-(?:\d{3}|GATE)) \|/gm)]
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
