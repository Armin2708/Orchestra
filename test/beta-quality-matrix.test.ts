import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EVIDENCE_SCHEMA,
  DEFAULT_MATRIX,
  DEFAULT_REQUIREMENTS,
  DEFAULT_ROOT,
  discoverStateMachineFiles,
  evaluateBetaQualityMatrix,
  stateMachineDiscoveryDigest,
} from '../scripts/check-beta-quality-matrix.mjs'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryFile(name: string, content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-quality-contract-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, name)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

const matrix = () => JSON.parse(fs.readFileSync(DEFAULT_MATRIX, 'utf8')) as {
  requirements: Array<Record<string, unknown>>
}

describe('beta quality coverage contract', () => {
  it('validates the immutable current-base inventory without claiming beta closure', () => {
    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'current-base' })

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.unresolved).toHaveLength(37)
    expect(result.unresolved.every((entry) =>
      entry.status === 'prerequisite' || entry.status === 'lane-dependent')).toBe(true)
    expect(result.unresolved.some((entry) => entry.item === 'QA-016'
      && entry.case === 'long-running-dogfood-daemon-provider-network'
      && entry.status === 'lane-dependent')).toBe(true)
    expect(result.unresolved.some((entry) => entry.item === 'QA-018')).toBe(true)
  })

  it('rejects deleted, renamed, status-flipped, unknown, and empty-bound cases', () => {
    const variants = [
      (value: ReturnType<typeof matrix>) => { value.requirements.shift() },
      (value: ReturnType<typeof matrix>) => { value.requirements[0].case = 'renamed-case' },
      (value: ReturnType<typeof matrix>) => { value.requirements[0].status = 'covered' },
      (value: ReturnType<typeof matrix>) => { value.requirements[0].command_ids = [] },
      (value: ReturnType<typeof matrix>) => { value.requirements[0].evidence = [{ path: 'comment.md', anchors: ['PASS'] }] },
      (value: ReturnType<typeof matrix>) => { value.requirements.push({ item: 'QA-999', case: 'unknown', status: 'prerequisite', command_ids: ['qa001-runtime'] }) },
    ]

    for (const mutate of variants) {
      const candidate = matrix()
      mutate(candidate)
      const result = evaluateBetaQualityMatrix({
        root: DEFAULT_ROOT,
        mode: 'current-base',
        matrixPath: temporaryFile('matrix.json', JSON.stringify(candidate)),
      })
      expect(result.ok).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it('pins both the requirement manifest and evidence schema digests', () => {
    const requirements = temporaryFile(
      'requirements.json',
      `${fs.readFileSync(DEFAULT_REQUIREMENTS, 'utf8')} `,
    )
    expect(evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'current-base',
      requirementsPath: requirements,
    }).errors).toContain('requirements manifest digest differs from the pinned immutable digest')

    const schema = temporaryFile(
      'schema.json',
      `${fs.readFileSync(DEFAULT_EVIDENCE_SCHEMA, 'utf8')} `,
    )
    expect(evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'current-base',
      schemaPath: schema,
    }).errors).toContain('evidence schema digest differs from the pinned immutable digest')
  })

  it('discovers class, function, SQL trigger, type, and transition-constant evasions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-quality-discovery-'))
    temporaryDirectories.push(root)
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    const fixtures = {
      'class.ts': 'export class HiddenStateMachine {}',
      'function.ts': 'export function transitionHiddenState() {}',
      'trigger.sql': 'CREATE TRIGGER hidden_status_transition BEFORE UPDATE ON hidden BEGIN SELECT 1; END;',
      'type.ts': "export type HiddenStatus = 'open' | 'closed'",
      'constant.ts': "export const HIDDEN_TRANSITIONS = { open: ['closed'] }",
    }
    for (const [name, content] of Object.entries(fixtures)) {
      fs.writeFileSync(path.join(root, 'src', name), content, 'utf8')
    }

    expect(discoverStateMachineFiles(root)).toEqual(Object.keys(fixtures).sort()
      .map((name) => `src/${name}`))
  })

  it('changes the discovery digest when an existing classified file gains a candidate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-quality-existing-file-'))
    temporaryDirectories.push(root)
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    const file = path.join(root, 'src', 'existing.ts')
    fs.writeFileSync(file, "export type ExistingStatus = 'open' | 'closed'\n", 'utf8')
    const before = stateMachineDiscoveryDigest(root)

    fs.appendFileSync(file, 'export function transitionExistingStatus() {}\n', 'utf8')

    expect(stateMachineDiscoveryDigest(root)).not.toBe(before)
  })

  it('fails when a discovered state-machine candidate loses classification', () => {
    const requirements = JSON.parse(fs.readFileSync(DEFAULT_REQUIREMENTS, 'utf8')) as {
      classified_state_machine_files: string[]
    }
    const removed = requirements.classified_state_machine_files.shift()!
    const result = evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'current-base',
      requirementsPath: temporaryFile('requirements.json', JSON.stringify(requirements)),
    })

    expect(result.errors).toContain(`unclassified state-machine candidate: ${removed}`)
  })

  it('requires exact-head artifacts, Vitest JSON, and GitNexus/Graphify reports for release', () => {
    const report = temporaryFile('evidence.json', JSON.stringify({
      schema_version: 1,
      tested_commit: '0'.repeat(40),
      requirements_sha256: '0'.repeat(64),
      schema_sha256: '0'.repeat(64),
      artifacts: [],
      commands: [],
      case_results: [],
      tool_reports: {},
    }))
    const result = evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'release',
      evidenceReport: report,
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      'evidence report schema/version arrays are empty or invalid',
      'evidence report is not bound to exact HEAD',
      'evidence report requirements digest mismatch',
      'evidence report schema digest mismatch',
      'missing, altered, or non-exact gitnexus report',
      'missing, altered, or non-exact graphify report',
    ]))
    expect(result.errors.some((error) => error.includes('release evidence missing required case')))
      .toBe(true)
  })
})
