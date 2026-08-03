import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendDogfoodObservation,
  initializeDogfoodEvidence,
  runEngineeringCycle,
  verifyDogfoodEvidence,
} from '../scripts/run-beta-dogfood.mjs'

const roots: string[] = []
const DAY = 86_400_000
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-dogfood-repo-')))
  const evidenceParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-dogfood-evidence-')))
  const artifactParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-dogfood-artifact-')))
  roots.push(root, evidenceParent, artifactParent)
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'candidate\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'orchestra-board',
    version: '0.1.0',
  }))
  const fakeVitest = path.join(root, 'node_modules', '.bin', 'vitest')
  fs.mkdirSync(path.dirname(fakeVitest), { recursive: true })
  fs.writeFileSync(fakeVitest, `#!/usr/bin/env node
const path = require('node:path')
const required = [
  'test/agent-home-daemon-restart-acceptance.test.ts',
  'test/operations-chaos-production-adapter.test.ts',
  'test/provider-agent-manager.test.ts',
  'test/remote-security-integration.test.ts',
  'test/runtime-pty-contract.test.ts'
]
process.stdout.write(JSON.stringify({
  success: true,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numPassedTests: 5,
  numTotalTests: 5,
  testResults: required.map((name) => ({
    name: path.resolve(name),
    assertionResults: [{ status: 'passed' }]
  }))
}))
`)
  fs.chmodSync(fakeVitest, 0o755)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'QA-016 Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'qa016@example.invalid'], { cwd: root })
  execFileSync('git', ['add', 'tracked.txt', 'package.json', 'node_modules/.bin/vitest'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'test candidate'], { cwd: root })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const artifact = path.join(artifactParent, 'orchestra-board-0.1.0-beta.1.tgz')
  const staging = path.join(artifactParent, 'staging', 'package')
  fs.mkdirSync(staging, { recursive: true })
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
    name: 'orchestra-board',
    version: '0.1.0',
    bin: { orchestra: './dist/cli.js' },
  }))
  execFileSync('tar', ['-czf', artifact, '-C', path.dirname(staging), 'package'])
  const artifactBytes = fs.readFileSync(artifact)
  const artifactSha256 = digest(artifactBytes)
  fs.writeFileSync(path.join(artifactParent, 'package-metadata.json'), JSON.stringify({
    schema_version: 1,
    commit_sha: commit,
    package_version: '0.1.0',
    filename: path.basename(artifact),
    bytes: artifactBytes.byteLength,
    sha256: artifactSha256,
    source_identity: {
      expected_commit: commit,
      observed_commit: commit,
      tracked_source_clean: true,
      packaged_nonbuild_inputs_tracked: true,
    },
    reproducibility: { byte_identical: true, second_pack_sha256: artifactSha256 },
    lifecycle: { passed: false, release_gate: { status: 'incomplete' } },
  }))
  fs.writeFileSync(
    path.join(artifactParent, `${path.basename(artifact)}.sha256`),
    `${artifactSha256}  ${path.basename(artifact)}\n`,
  )
  const observation = path.join(artifactParent, 'observation.json')
  fs.writeFileSync(observation, JSON.stringify({ status: 'observed' }))
  return {
    root,
    commit,
    artifact,
    observation,
    output: path.join(evidenceParent, 'run'),
    started: new Date('2026-08-03T00:00:00.000Z'),
  }
}

const append = (
  run: ReturnType<typeof fixture>,
  kind: string,
  offset: number,
  provider: string | null = null,
  incidentId: string | null = null,
) => appendDogfoodObservation({
  root: run.root,
  output: run.output,
  kind,
  evidencePath: run.observation,
  provider,
  incidentId,
  now: new Date(run.started.getTime() + offset),
})

const initialize = (run: ReturnType<typeof fixture>, providers = 'codex') =>
  initializeDogfoodEvidence({
    root: run.root,
    output: run.output,
    candidateCommit: run.commit,
    artifactPath: run.artifact,
    providers,
    now: run.started,
  })

const completeRun = (run: ReturnType<typeof fixture>) => {
  append(run, 'work_cycle_passed', 30 * 60_000, 'codex')
  expect(runEngineeringCycle({
    root: run.root,
    output: run.output,
    now: new Date(run.started.getTime() + 60 * 60_000),
  }).passed).toBe(true)
  append(run, 'daemon_interrupted', 2 * 60 * 60_000)
  append(run, 'daemon_recovered', 2 * 60 * 60_000 + 60_000)
  append(run, 'provider_interrupted', 8 * 60 * 60_000, 'codex')
  append(run, 'provider_recovered', 8 * 60 * 60_000 + 60_000, 'codex')
  append(run, 'network_interrupted', 12 * 60 * 60_000)
  append(run, 'network_recovered', 12 * 60 * 60_000 + 60_000)
  append(run, 'work_cycle_passed', 12 * 60 * 60_000 + 2 * 60_000, 'codex')
  append(run, 'work_cycle_passed', DAY, 'codex')
}

describe('QA-016 durable dogfood evidence', () => {
  it('binds a clean exact commit, retained artifact, providers, and immutable 24-hour plan', () => {
    const run = fixture()
    const manifest = initialize(run, 'codex,claude,codex')

    expect(manifest).toMatchObject({
      candidate_commit: run.commit,
      providers: ['claude', 'codex'],
      minimum_duration_ms: DAY,
      minimum_work_cycles: 3,
      release_authorized: false,
    })
    expect(manifest.retained_artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.statSync(run.output).mode & 0o777).toBe(0o700)
  })

  it('keeps the gate incomplete until duration, work, engineering, and every interruption pair exist', () => {
    const run = fixture()
    initialize(run)
    append(run, 'work_cycle_passed', 30 * 60_000, 'codex')

    const summary = verifyDogfoodEvidence({
      root: run.root,
      output: run.output,
      now: new Date(run.started.getTime() + DAY),
    })

    expect(summary.status).toBe('incomplete')
    expect(summary.qa016_closed).toBe(false)
    expect(summary.errors).toEqual(expect.arrayContaining([
      'too few retained real-work cycles',
      'missing ordered daemon_interrupted/daemon_recovered evidence',
      'missing ordered provider interruption/recovery evidence for codex',
      'missing ordered network_interrupted/network_recovered evidence',
      'no deterministic engineering interruption cycle was retained',
    ]))
  })

  it('produces review eligibility without self-closing QA-016 or authorizing release', () => {
    const run = fixture()
    initialize(run)
    completeRun(run)

    const summary = verifyDogfoodEvidence({
      root: run.root,
      output: run.output,
      now: new Date(run.started.getTime() + DAY),
    })

    expect(summary).toMatchObject({
      status: 'eligible_for_independent_review',
      qa016_closed: false,
      requires_independent_review: true,
      release_authorized: false,
      errors: [],
    })
  })

  it('fails closed for tampered evidence and unresolved P0/P1 incidents', () => {
    const run = fixture()
    initialize(run)
    completeRun(run)
    append(run, 'p1_opened', DAY, null, 'P1-42')
    const artifacts = fs.readdirSync(path.join(run.output, 'artifacts'))
    const firstArtifact = path.join(run.output, 'artifacts', artifacts[0])
    const engineeringArtifact = path.join(run.output, 'artifacts', artifacts[1])
    fs.appendFileSync(firstArtifact, 'tampered')
    fs.writeFileSync(engineeringArtifact, '{}')

    const summary = verifyDogfoodEvidence({
      root: run.root,
      output: run.output,
      now: new Date(run.started.getTime() + DAY),
    })

    expect(summary.status).toBe('incomplete')
    expect(summary.errors).toEqual(expect.arrayContaining([
      'event 1 evidence digest changed',
      'event 2 engineering result does not match its retained Vitest JSON',
      'unresolved P0/P1 incidents remain',
    ]))
  })

  it('rejects dirty candidates, repository-local evidence, and undeclared providers', () => {
    const dirty = fixture()
    fs.writeFileSync(path.join(dirty.root, 'tracked.txt'), 'dirty\n')
    expect(() => initialize(dirty)).toThrow('tracked changes after the exact commit')

    const local = fixture()
    expect(() => initializeDogfoodEvidence({
      root: local.root,
      output: path.join(local.root, 'evidence'),
      candidateCommit: local.commit,
      artifactPath: local.artifact,
      providers: 'codex',
      now: local.started,
    })).toThrow('outside the repository')

    const provider = fixture()
    initialize(provider)
    expect(() => append(provider, 'provider_interrupted', 60_000, 'claude'))
      .toThrow('provider declared in the manifest')
    expect(() => append(provider, 'engineering_cycle_passed', 60_000))
      .toThrow('only be created by the pinned cycle command')
  })

  it('requires the retained tarball metadata, checksum, source identity, and reproducibility contract', () => {
    const run = fixture()
    const metadataPath = path.join(path.dirname(run.artifact), 'package-metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    metadata.source_identity.tracked_source_clean = false
    fs.writeFileSync(metadataPath, JSON.stringify(metadata))

    expect(() => initialize(run)).toThrow(
      'retained tarball metadata, checksum, source identity, or reproducibility does not bind exact HEAD',
    )
  })

  it('fails cycle and verification when HEAD advances after the retained run begins', () => {
    const run = fixture()
    initialize(run)
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'advance candidate'], { cwd: run.root })

    expect(() => runEngineeringCycle({
      root: run.root,
      output: run.output,
      now: new Date(run.started.getTime() + 60_000),
    })).toThrow('package source commit mismatch')

    const summary = verifyDogfoodEvidence({
      root: run.root,
      output: run.output,
      now: new Date(run.started.getTime() + DAY),
    })
    expect(summary.status).toBe('incomplete')
    expect(summary.errors).toContainEqual(expect.stringContaining('package source commit mismatch'))
  })

  it('fails cycle and verification when tracked source or retained package bytes change', () => {
    const dirty = fixture()
    initialize(dirty)
    fs.writeFileSync(path.join(dirty.root, 'tracked.txt'), 'changed after init\n')

    expect(() => runEngineeringCycle({
      root: dirty.root,
      output: dirty.output,
      now: new Date(dirty.started.getTime() + 60_000),
    })).toThrow('tracked changes after the exact commit')
    expect(verifyDogfoodEvidence({
      root: dirty.root,
      output: dirty.output,
      now: new Date(dirty.started.getTime() + DAY),
    }).errors).toContain('package source has tracked changes after the exact commit')

    const tampered = fixture()
    initialize(tampered)
    fs.appendFileSync(tampered.artifact, 'tampered')
    expect(() => runEngineeringCycle({
      root: tampered.root,
      output: tampered.output,
      now: new Date(tampered.started.getTime() + 60_000),
    })).toThrow('retained candidate package verification failed')
    expect(verifyDogfoodEvidence({
      root: tampered.root,
      output: tampered.output,
      now: new Date(tampered.started.getTime() + DAY),
    }).errors).toContainEqual(expect.stringContaining('retained candidate package verification failed'))
  })
})
