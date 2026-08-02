import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EVIDENCE_SCHEMA,
  DEFAULT_INTEGRATION_MANIFEST_SCHEMA,
  DEFAULT_MATRIX,
  DEFAULT_REQUIREMENTS,
  DEFAULT_ROOT,
  DEFAULT_TOOL_EVIDENCE_SCHEMA,
  PINNED_EVIDENCE_SCHEMA_SHA256,
  PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
  PINNED_REQUIREMENTS_SHA256,
  PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
  REQUIRED_BETA_BASE,
  discoverStateMachineFiles,
  evaluateBetaQualityMatrix,
  stateMachineDiscoveryDigest,
} from '../scripts/check-beta-quality-matrix.mjs'

const temporaryDirectories: string[] = []
const temporaryRoot = fs.realpathSync(os.tmpdir())

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryFile(name: string, content: string): string {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-contract-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, name)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

function writeJson(directory: string, name: string, value: unknown): { path: string; sha256: string } {
  const file = path.join(directory, name)
  const content = JSON.stringify(value)
  fs.writeFileSync(file, content, 'utf8')
  return { path: name, sha256: createHash('sha256').update(content).digest('hex') }
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

  it('rejects rebinding a case to a known passing command or a different lane', () => {
    const rebound = matrix()
    rebound.requirements[9].command_ids = ['qa001-runtime']
    const reboundResult = evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'current-base',
      matrixPath: temporaryFile('rebound-matrix.json', JSON.stringify(rebound)),
    })
    expect(reboundResult.errors).toContain('quality matrix digest differs from the pinned immutable digest')

    const moved = matrix()
    const laneEntry = moved.requirements.find((entry) => entry.status === 'lane-dependent')!
    laneEntry.lane = laneEntry.lane === 'A' ? 'B' : 'A'
    const movedResult = evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'current-base',
      matrixPath: temporaryFile('moved-matrix.json', JSON.stringify(moved)),
    })
    expect(movedResult.errors).toContain('quality matrix digest differs from the pinned immutable digest')
  })

  it('pins the complete matrix, requirement manifest, and all evidence schemas', () => {
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

    const toolSchema = temporaryFile(
      'tool-schema.json',
      `${fs.readFileSync(DEFAULT_TOOL_EVIDENCE_SCHEMA, 'utf8')} `,
    )
    expect(evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'current-base',
      toolSchemaPath: toolSchema,
    }).errors).toContain('tool evidence schema digest differs from the pinned immutable digest')

    const integrationSchema = temporaryFile(
      'integration-schema.json',
      `${fs.readFileSync(DEFAULT_INTEGRATION_MANIFEST_SCHEMA, 'utf8')} `,
    )
    expect(evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'current-base',
      integrationSchemaPath: integrationSchema,
    }).errors).toContain('integration manifest schema digest differs from the pinned immutable digest')
  })

  it('discovers enum, arrow transition, lowercase transitions, workflow setter, and SQL evasions', () => {
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-discovery-'))
    temporaryDirectories.push(root)
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    const fixtures = {
      'enum.ts': 'export enum HiddenState { Open, Closed }',
      'arrow.ts': 'export const transitionHiddenState = () => undefined',
      'lowercase.ts': "export const statusTransitions = { open: ['closed'] }",
      'workflow.ts': 'export class HiddenWorkflow { setStatus() {} }',
      'trigger.sql': 'CREATE TRIGGER hidden_status_transition BEFORE UPDATE ON hidden BEGIN SELECT 1; END;',
    }
    for (const [name, content] of Object.entries(fixtures)) {
      fs.writeFileSync(path.join(root, 'src', name), content, 'utf8')
    }

    expect(discoverStateMachineFiles(root)).toEqual(Object.keys(fixtures).sort()
      .map((name) => `src/${name}`))
  })

  it('changes the discovery digest when an existing classified file gains a candidate', () => {
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-existing-file-'))
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
      tool_schema_sha256: '0'.repeat(64),
      integration_schema_sha256: '0'.repeat(64),
      qa018_closure_supported: false,
      integration_manifest: null,
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
      'evidence report tool schema digest mismatch',
      'evidence report integration schema digest mismatch',
      'missing or altered lane_a gitnexus report',
      'missing or altered integrator graphify report',
    ]))
    expect(result.errors.some((error) => error.includes('release evidence missing required case')))
      .toBe(true)
  })

  it('returns structured failures for malformed evidence JSON', () => {
    const result = evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      mode: 'release',
      evidenceReport: temporaryFile('malformed-evidence.json', '{'),
    })

    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.startsWith('malformed evidence report:'))).toBe(true)
  })

  it('rejects evidence paths outside the evidence directory', () => {
    const toolEntry = { tested_commit: '0'.repeat(40), path: '../outside.json', sha256: '0'.repeat(64) }
    const laneReports = { gitnexus: toolEntry, graphify: toolEntry }
    const report = temporaryFile('path-traversal.json', JSON.stringify({
      schema_version: 1,
      tested_commit: '0'.repeat(40),
      requirements_sha256: '0'.repeat(64),
      schema_sha256: '0'.repeat(64),
      tool_schema_sha256: '0'.repeat(64),
      integration_schema_sha256: '0'.repeat(64),
      qa018_closure_supported: false,
      integration_manifest: null,
      artifacts: [],
      commands: [{ id: 'qa001-runtime', argv: ['node_modules/.bin/vitest', 'run', '--reporter=json', 'test/codex-runtime-state-machines.test.ts'], exit_code: 0, log_path: '../outside.json', log_sha256: '0'.repeat(64), test_files: 1, tests: 1, passed: 1, failed: 0, pending: 0, skipped: 0, todo: 0 }],
      case_results: [],
      tool_reports: { lane_a: laneReports, lane_b: laneReports, lane_c: laneReports, lane_d: laneReports, integrator: laneReports },
    }))
    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release', evidenceReport: report })

    expect(result.errors).toContain('command log is outside evidence directory qa001-runtime')
    expect(result.errors).toContain('lane_a gitnexus report is outside evidence directory')
  })

  it('rejects schema-invalid empty tool payloads instead of accepting self-hashes', () => {
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-tool-schema-'))
    temporaryDirectories.push(directory)
    const payload = path.join(directory, 'empty-tool.json')
    fs.writeFileSync(payload, '{}', 'utf8')
    const digest = createHash('sha256').update('{}').digest('hex')
    const entry = { tested_commit: '0'.repeat(40), path: 'empty-tool.json', sha256: digest }
    const laneReports = { gitnexus: entry, graphify: entry }
    const report = path.join(directory, 'evidence.json')
    fs.writeFileSync(report, JSON.stringify({
      schema_version: 1,
      tested_commit: '0'.repeat(40),
      requirements_sha256: '0'.repeat(64),
      schema_sha256: '0'.repeat(64),
      tool_schema_sha256: '0'.repeat(64),
      integration_schema_sha256: '0'.repeat(64),
      qa018_closure_supported: false,
      integration_manifest: null,
      artifacts: [], commands: [], case_results: [],
      tool_reports: { lane_a: laneReports, lane_b: laneReports, lane_c: laneReports, lane_d: laneReports, integrator: laneReports },
    }), 'utf8')

    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release', evidenceReport: report })
    expect(result.errors.some((error) => error.startsWith('lane_a gitnexus report schema validation failed:'))).toBe(true)
    expect(result.errors).toContain('invalid identity binding for lane_a gitnexus report')
  })

  it('returns structured errors for invalid contract and evidence root shapes', () => {
    expect(() => evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      requirementsPath: temporaryFile('null-requirements.json', 'null'),
    })).not.toThrow()
    expect(evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      requirementsPath: temporaryFile('array-requirements.json', '[]'),
    }).errors).toContain('requirements manifest schema/required arrays are empty or invalid')
    expect(evaluateBetaQualityMatrix({
      root: DEFAULT_ROOT,
      matrixPath: temporaryFile('null-matrix.json', 'null'),
    }).errors).toContain('matrix schema is invalid or empty')

    const malformedShape = temporaryFile('shape-evidence.json', JSON.stringify({
      schema_version: 1,
      tested_commit: '0'.repeat(40),
      requirements_sha256: PINNED_REQUIREMENTS_SHA256,
      schema_sha256: PINNED_EVIDENCE_SCHEMA_SHA256,
      tool_schema_sha256: PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
      integration_schema_sha256: PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
      qa018_closure_supported: false,
      integration_manifest: [], artifacts: {}, commands: {}, case_results: {}, tool_reports: null,
    }))
    expect(() => evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release', evidenceReport: malformedShape })).not.toThrow()
    expect(evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release', evidenceReport: malformedShape }).errors)
      .toContain('evidence report schema/version arrays are empty or invalid')
  })

  it('rejects pending, skipped, and todo tests even when Vitest reports success', () => {
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-incomplete-vitest-'))
    temporaryDirectories.push(directory)
    const log = writeJson(directory, 'qa001-runtime.json', {
      success: true, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1,
      numPassedTests: 1, numTotalTests: 3, numTotalTestSuites: 1,
      testResults: [{ assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'todo' }] }],
    })
    const report = path.join(directory, 'evidence.json')
    fs.writeFileSync(report, JSON.stringify({
      schema_version: 1,
      tested_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim(),
      requirements_sha256: PINNED_REQUIREMENTS_SHA256,
      schema_sha256: PINNED_EVIDENCE_SCHEMA_SHA256,
      tool_schema_sha256: PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
      integration_schema_sha256: PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
      qa018_closure_supported: false, integration_manifest: null, artifacts: [],
      commands: [{ id: 'qa001-runtime', argv: ['node_modules/.bin/vitest', 'run', '--reporter=json', 'test/codex-runtime-state-machines.test.ts'], exit_code: 0, log_path: log.path, log_sha256: log.sha256, test_files: 1, tests: 3, passed: 1, failed: 0, pending: 1, skipped: 1, todo: 1 }],
      case_results: [], tool_reports: {},
    }), 'utf8')

    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release', evidenceReport: report })
    expect(result.errors).toContain('command qa001-runtime has incomplete, skipped, pending, todo, or failing tests')
    expect(result.errors).toContain('command qa001-runtime result does not match its complete Vitest JSON artifact')
  })

  it('rejects pre-existing and symlinked output directories and refuses QA-018 receipt flags', () => {
    const runner = path.join(DEFAULT_ROOT, 'scripts/run-beta-quality-evidence.mjs')
    const existing = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-existing-output-'))
    temporaryDirectories.push(existing)
    const existingRun = spawnSync(process.execPath, [runner, '--output-dir', existing], { cwd: DEFAULT_ROOT, encoding: 'utf8' })
    expect(`${existingRun.stderr}${existingRun.stdout}`).toContain('evidence output directory must not already exist')

    const realParent = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-real-parent-'))
    temporaryDirectories.push(realParent)
    const linkParent = `${realParent}-link`
    fs.symlinkSync(realParent, linkParent, 'dir')
    temporaryDirectories.push(linkParent)
    const symlinkRun = spawnSync(process.execPath, [runner, '--output-dir', path.join(linkParent, 'evidence')], { cwd: DEFAULT_ROOT, encoding: 'utf8' })
    expect(`${symlinkRun.stderr}${symlinkRun.stdout}`).toContain('evidence output parent must be a real, existing, non-symlink directory')

    const unsupported = spawnSync(process.execPath, [runner, '--output-dir', path.join(temporaryRoot, `beta-quality-unsupported-${Date.now()}`), '--lane-a-gitnexus-report', 'receipt.json'], { cwd: DEFAULT_ROOT, encoding: 'utf8' })
    expect(`${unsupported.stderr}${unsupported.stdout}`).toContain('current runner cannot close QA-018')
  })

  it('rejects lane tool pairs that do not match one exact signed ready commit', () => {
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-lane-binding-'))
    temporaryDirectories.push(directory)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim()
    const marker = { lane_a: '[beta-lane-a-ready]', lane_b: '[beta-lane-b-ready]', lane_c: '[beta-lane-c-ready]', lane_d: '[beta-lane-d-ready]', integrator: '[beta-release-candidate]' } as const
    const lanes = Object.fromEntries(Object.entries(marker).map(([lane, readyMarker]) => [lane, {
      ready_commit: head, base_ref: REQUIRED_BETA_BASE, range: `${REQUIRED_BETA_BASE}..${head}`,
      ready_marker: readyMarker, gitnexus_version: '1.0.0', graphify_version: '1.0.0',
    }]))
    const manifest = writeJson(directory, 'integration.json', {
      schema_version: 1, base_ref: REQUIRED_BETA_BASE, integrator_commit: head, lanes,
      external_receipt: { signer: 'release-integrator', signed_at: '2026-08-02T00:00:00Z', signature: 'a'.repeat(64), verification: 'external-human-required' },
    })
    const malformedEnvelopeFile = writeJson(directory, 'malformed-mcp.json', { content: [{ type: 'text', text: 'not-json' }] })
    const nullFile = writeJson(directory, 'null.json', null)
    const malformedEnvelope = { path: malformedEnvelopeFile.path, output_sha256: malformedEnvelopeFile.sha256 }
    const nullArtifact = { path: nullFile.path, output_sha256: nullFile.sha256 }
    const missing = { path: 'missing.json', output_sha256: '0'.repeat(64) }
    const gitReceipt = writeJson(directory, 'lane-a-gitnexus.json', {
      schema_version: 2, tool: 'gitnexus', lane: 'lane_a', tested_commit: head, base_ref: REQUIRED_BETA_BASE,
      range: `${REQUIRED_BETA_BASE}..${head}`, ready_marker: marker.lane_a, tool_version: '1.0.0',
      invocation_argv: { impact: ['gitnexus', 'impact'], detect_changes: ['gitnexus', 'detect_changes', REQUIRED_BETA_BASE] },
      raw_impact: malformedEnvelope, raw_detect_changes: nullArtifact, unresolved_findings: { p0: 0, p1: 0, p2: 0 },
    })
    const graphReceipt = writeJson(directory, 'lane-a-graphify.json', {
      schema_version: 2, tool: 'graphify', lane: 'lane_a', tested_commit: REQUIRED_BETA_BASE, base_ref: REQUIRED_BETA_BASE,
      range: `${REQUIRED_BETA_BASE}..${REQUIRED_BETA_BASE}`, ready_marker: marker.lane_a, tool_version: '1.0.0',
      invocation_argv: { update: ['graphify', 'update', '.'], status: ['graphify', 'status'] }, raw_update: nullArtifact,
      raw_status: malformedEnvelope, graph_artifact: missing, manifest_artifact: missing, unresolved_findings: { p0: 0, p1: 0, p2: 0 },
    })
    const report = path.join(directory, 'evidence.json')
    fs.writeFileSync(report, JSON.stringify({
      schema_version: 1, tested_commit: head, requirements_sha256: PINNED_REQUIREMENTS_SHA256,
      schema_sha256: PINNED_EVIDENCE_SCHEMA_SHA256, tool_schema_sha256: PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
      integration_schema_sha256: PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256, qa018_closure_supported: false,
      integration_manifest: manifest, artifacts: [], commands: [], case_results: [],
      tool_reports: { lane_a: { gitnexus: { tested_commit: head, ...gitReceipt }, graphify: { tested_commit: REQUIRED_BETA_BASE, ...graphReceipt } } },
    }), 'utf8')

    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release', evidenceReport: report })
    expect(result.errors).toContain('lane_a graphify report does not match the signed integration manifest')
    expect(result.errors).toContain('lane_a GitNexus and Graphify receipts do not use the same exact ready commit')
    expect(result.errors).toContain('lane_a raw GitNexus impact output is null, malformed, or lacks semantic fields')
    expect(result.errors).toContain('lane_a raw GitNexus detect_changes output is null, malformed, or lacks semantic fields')
    expect(result.errors).toContain('lane_a raw Graphify update output is null, malformed, or lacks semantic fields')
    expect(result.errors).toContain('lane_a raw Graphify status output is null, malformed, or does not bind retained graph/manifest hashes')
    expect(result.errors).toContain('QA-018 remains impossible in this runner: integrator-signed external raw tool receipts require a reviewed verifier upgrade')
  })

  it('rejects nonexistent, nonancestor, and wrong-marker ready commits from actual Git history', () => {
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'beta-quality-git-binding-'))
    temporaryDirectories.push(directory)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim()
    const lane = (readyCommit: string, readyMarker: string) => ({
      ready_commit: readyCommit, base_ref: REQUIRED_BETA_BASE, range: `${REQUIRED_BETA_BASE}..${readyCommit}`,
      ready_marker: readyMarker, gitnexus_version: '1.0.0', graphify_version: '1.0.0',
    })
    const manifest = writeJson(directory, 'integration.json', {
      schema_version: 1, base_ref: REQUIRED_BETA_BASE, integrator_commit: head,
      lanes: {
        lane_a: lane('f'.repeat(40), '[beta-lane-a-ready]'),
        lane_b: lane('3c79b69b3298a17a54e9fd2426e2eca1a337bd18', '[beta-lane-b-ready]'),
        lane_c: lane(head, '[beta-lane-c-ready]'),
        lane_d: lane(head, '[beta-lane-d-ready]'),
        integrator: lane(head, '[beta-release-candidate]'),
      },
      external_receipt: { signer: 'release-integrator', signed_at: '2026-08-02T00:00:00Z', signature: 'a'.repeat(64), verification: 'external-human-required' },
    })
    const report = path.join(directory, 'evidence.json')
    fs.writeFileSync(report, JSON.stringify({
      schema_version: 1, tested_commit: head, requirements_sha256: PINNED_REQUIREMENTS_SHA256,
      schema_sha256: PINNED_EVIDENCE_SCHEMA_SHA256, tool_schema_sha256: PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
      integration_schema_sha256: PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256, qa018_closure_supported: false,
      integration_manifest: manifest, artifacts: [], commands: [], case_results: [], tool_reports: {},
    }), 'utf8')

    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release', evidenceReport: report })
    expect(result.errors).toContain('lane_a ready commit does not exist in the repository')
    expect(result.errors).toContain('lane_b ready commit is not integrated into exact HEAD')
    expect(result.errors).toContain('lane_c ready marker is absent from the actual commit message')
  })
})
