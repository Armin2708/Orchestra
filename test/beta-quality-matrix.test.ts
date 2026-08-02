import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson } from '../scripts/exact-commit-contract.mjs'
import {
  DEFAULT_EVIDENCE_SCHEMA,
  DEFAULT_INTEGRATION_MANIFEST_SCHEMA,
  DEFAULT_MATRIX,
  DEFAULT_REQUIREMENTS,
  DEFAULT_ROOT,
  DEFAULT_SIGNATURE_RECEIPT_SCHEMA,
  DEFAULT_TOOL_EVIDENCE_SCHEMA,
  PINNED_EVIDENCE_SCHEMA_SHA256,
  PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
  PINNED_REQUIREMENTS_SHA256,
  PINNED_SIGNATURE_RECEIPT_SCHEMA_SHA256,
  PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
  discoverStateMachineFiles,
  evaluateBetaQualityMatrix,
  stateMachineDiscoveryDigest,
  verifyQa018EvidenceBundle,
} from '../scripts/check-beta-quality-matrix.mjs'
import {
  BETA_QUALITY_AUTHORIZATION_SCOPE,
  BETA_QUALITY_PURPOSE,
  BETA_QUALITY_REPOSITORY,
  DEFAULT_BETA_QUALITY_TRUST_ROOTS,
  betaQualitySigningPayload,
  verifyBetaQualitySignature,
  verifyBetaQualitySignatureForTesting,
} from '../scripts/beta-quality-signature.mjs'
import { importQa018Bundle } from '../scripts/run-beta-quality-evidence.mjs'
import { captureGraphifyStatus } from '../scripts/capture-graphify-status.mjs'

const temporaryDirectories: string[] = []
const temporaryRoot = fs.realpathSync(os.tmpdir())
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, prefix))
  temporaryDirectories.push(directory)
  return directory
}

function temporaryFile(name: string, content: string): string {
  const directory = temporaryDirectory('beta-quality-contract-')
  const file = path.join(directory, name)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

function writeJson(directory: string, name: string, value: unknown): { path: string; sha256: string } {
  const file = path.join(directory, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const content = JSON.stringify(value, null, 2)
  fs.writeFileSync(file, `${content}\n`, 'utf8')
  return { path: name, sha256: hash(`${content}\n`) }
}

function writeText(directory: string, name: string, content: string): { path: string; sha256: string } {
  const file = path.join(directory, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return { path: name, sha256: hash(content) }
}

function commit(root: string, message: string): string {
  fs.writeFileSync(path.join(root, 'history.txt'), `${randomUUID()}\n`, { flag: 'a' })
  execFileSync('git', ['add', 'history.txt'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: root })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

type Fixture = ReturnType<typeof qa018Fixture>

function qa018Fixture({
  highRiskWithoutDisposition = false,
  highRiskWithDisposition = false,
  wrongGitRequestCasing = false,
  nonexistentGraphifyStatus = false,
} = {}) {
  const root = temporaryDirectory('beta-quality-git-')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Beta Quality Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'beta-quality@example.invalid'], { cwd: root })
  const base = commit(root, 'test: beta base')
  const checkpoints = {
    lane_a: {
      source: commit(root, 'test: Lane A source [beta-lane-a-ready]'),
      remediations: [] as string[],
    },
    lane_b: {
      source: '',
      remediations: [] as string[],
    },
    lane_c: {
      source: '',
      remediations: [] as string[],
    },
    lane_d: {
      source: '',
      remediations: [] as string[],
    },
    integrator: {
      source: '',
      remediations: [] as string[],
    },
  }
  checkpoints.lane_a.remediations.push(commit(root, 'test: Lane A remediation [beta-lane-a-remediation-ready]'))
  checkpoints.lane_b.source = commit(root, 'test: Lane B source [beta-lane-b-ready]')
  checkpoints.lane_b.remediations.push(commit(root, 'test: Lane B remediation [beta-lane-b-remediation-ready]'))
  checkpoints.lane_c.source = commit(root, 'test: Lane C source [beta-lane-c-ready]')
  checkpoints.lane_d.source = commit(root, 'test: Lane D source [beta-lane-d-ready]')
  checkpoints.integrator.source = commit(root, 'test: integrator source [beta-release-candidate]')
  const head = checkpoints.integrator.source
  const evidenceDirectory = temporaryDirectory('beta-quality-evidence-')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keyId = `sha256:${hash(publicKey.export({ format: 'der', type: 'spki' }) as Buffer)}`
  const trustRoots = {
    schema_version: 1,
    purpose: BETA_QUALITY_PURPOSE,
    repository: BETA_QUALITY_REPOSITORY,
    authorization_scope: BETA_QUALITY_AUTHORIZATION_SCOPE,
    trusted_signing_keys: [{
      algorithm: 'ed25519', key_id: keyId,
      public_key_pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      signer: 'independent-beta-reviewer', status: 'active',
    }],
  }
  const sourceMarkers: Record<string, string> = {
    lane_a: '[beta-lane-a-ready]', lane_b: '[beta-lane-b-ready]',
    lane_c: '[beta-lane-c-ready]', lane_d: '[beta-lane-d-ready]',
    integrator: '[beta-release-candidate]',
  }
  const remediationMarkers: Record<string, string> = {
    lane_a: '[beta-lane-a-remediation-ready]', lane_b: '[beta-lane-b-remediation-ready]',
    lane_c: '[beta-lane-c-remediation-ready]', lane_d: '[beta-lane-d-remediation-ready]',
    integrator: '[beta-release-candidate-remediation]',
  }
  const slices = Object.entries(checkpoints).map(([sliceId, checkpoint]) => {
    const acceptedCommit = checkpoint.remediations.at(-1) ?? checkpoint.source
    const target = `symbol-${sliceId}`
    const risk = (highRiskWithoutDisposition || highRiskWithDisposition) && sliceId === 'lane_a' ? 'HIGH' : 'LOW'
    const impactRaw = writeJson(evidenceDirectory, `${sliceId}/gitnexus-impact.json`, {
      target: { name: target }, risk, summary: { direct: 0 }, affected_processes: [],
    })
    const detectRaw = writeJson(evidenceDirectory, `${sliceId}/gitnexus-detect.json`, {
      summary: { changed_files: 1, risk_level: 'LOW' }, affected_processes: [],
    })
    const impactArguments = wrongGitRequestCasing && sliceId === 'lane_a'
      ? {
        repo: root, target, direction: 'upstream', max_depth: 3,
        min_confidence: 0.8, include_tests: true,
      }
      : {
        repo: root, target, direction: 'upstream', maxDepth: 3,
        minConfidence: 0.8, includeTests: true,
      }
    const impactRequest = {
      request_id: `impact-${sliceId.replace('_', '-')}`,
      api: 'mcp__gitnexus__impact',
      arguments: impactArguments,
      observed_risk: risk,
      result: impactRaw,
    }
    const gitRequests = {
      impact: [impactRequest],
      detect_changes: {
        api: 'mcp__gitnexus__detect_changes',
        arguments: { repo: root, worktree: root, scope: 'compare', base_ref: base },
        result: detectRaw,
      },
    }
    const gitReport = writeJson(evidenceDirectory, `${sliceId}/gitnexus-report.json`, {
      schema_version: 3, tool: 'gitnexus', slice_id: sliceId,
      tested_commit: acceptedCommit, base_ref: base, range: `${base}..${acceptedCommit}`,
      tool_version: '1.2.3', requests: gitRequests,
      unresolved_findings: { p0: 0, p1: 0, p2: 0 },
    })
    const graph = writeJson(evidenceDirectory, `${sliceId}/graph.json`, {
      built_at_commit: acceptedCommit, nodes: [], links: [],
    })
    const graphManifest = writeJson(evidenceDirectory, `${sliceId}/graph-manifest.json`, { files: ['history.txt'] })
    const updateRaw = writeText(
      evidenceDirectory,
      `${sliceId}/graphify-update.txt`,
      `Graphify update completed for ${acceptedCommit}\n`,
    )
    const statusRaw = writeJson(evidenceDirectory, `${sliceId}/graphify-status.json`, {
      schema_version: 1, operation: 'status', tested_commit: acceptedCommit,
      graph_path: 'graphify-out/graph.json', graph_sha256: graph.sha256,
      manifest_path: 'graphify-out/manifest.json', manifest_sha256: graphManifest.sha256,
    })
    const graphRequests = {
      update: { argv: ['graphify', 'update', '.'], exit_code: 0, result: updateRaw },
      status: {
        argv: nonexistentGraphifyStatus && sliceId === 'lane_a' ? ['graphify', 'status'] : [
          'node', 'scripts/capture-graphify-status.mjs',
          '--graph', 'graphify-out/graph.json',
          '--manifest', 'graphify-out/manifest.json',
          '--tested-commit', acceptedCommit,
        ],
        exit_code: 0,
        result: statusRaw,
      },
    }
    const graphReport = writeJson(evidenceDirectory, `${sliceId}/graphify-report.json`, {
      schema_version: 3, tool: 'graphify', slice_id: sliceId,
      tested_commit: acceptedCommit, base_ref: base, range: `${base}..${acceptedCommit}`,
      tool_version: '4.5.6', requests: graphRequests,
      artifacts: { graph, manifest: graphManifest },
      unresolved_findings: { p0: 0, p1: 0, p2: 0 },
    })
    return {
      slice_id: sliceId,
      source_checkpoint: {
        commit: checkpoint.source, base_ref: base, range: `${base}..${checkpoint.source}`,
        marker: sourceMarkers[sliceId],
      },
      accepted_remediation_checkpoints: checkpoint.remediations.map((checkpointCommit) => ({
        commit: checkpointCommit, base_ref: base, range: `${base}..${checkpointCommit}`,
        marker: remediationMarkers[sliceId],
      })),
      accepted_commit: acceptedCommit,
      tool_reports: {
        gitnexus: {
          tested_commit: acceptedCommit, tool_version: '1.2.3', ...gitReport,
          requests_sha256: hash(canonicalJson(gitRequests)),
          raw_artifacts: [
            { kind: 'gitnexus-impact', ...impactRaw },
            { kind: 'gitnexus-detect-changes', ...detectRaw },
          ],
        },
        graphify: {
          tested_commit: acceptedCommit, tool_version: '4.5.6', ...graphReport,
          requests_sha256: hash(canonicalJson(graphRequests)),
          raw_artifacts: [
            { kind: 'graphify-update', ...updateRaw },
            { kind: 'graphify-status', ...statusRaw },
            { kind: 'graphify-graph', ...graph },
            { kind: 'graphify-manifest', ...graphManifest },
          ],
        },
      },
      risk_dispositions: risk === 'HIGH' && highRiskWithDisposition ? [{
        request_sha256: hash(canonicalJson({ api: impactRequest.api, arguments: impactRequest.arguments })),
        target,
        risk: 'HIGH',
        disposition: 'accepted-after-independent-review',
        reviewer: 'independent-beta-reviewer',
        rationale: 'Reviewed the exact upstream blast radius and accepted this bounded change.',
        checkpoint_commit: acceptedCommit,
      }] : [],
      unresolved_findings: { p0: 0, p1: 0, p2: 0 },
    }
  })
  let manifest = {
    schema_version: 2,
    purpose: BETA_QUALITY_PURPOSE,
    repository: BETA_QUALITY_REPOSITORY,
    base_ref: base,
    integrator_commit: head,
    authorization_scope: BETA_QUALITY_AUTHORIZATION_SCOPE,
    public_release_authorized: false,
    slices,
    unresolved_findings: { p0: 0, p1: 0, p2: 0 },
  }
  let manifestReference = writeJson(evidenceDirectory, 'integration-manifest.json', manifest)
  let receipt: Record<string, unknown>
  let receiptReference: { path: string; sha256: string }

  const resign = () => {
    manifestReference = writeJson(evidenceDirectory, 'integration-manifest.json', manifest)
    const attestation = {
      purpose: BETA_QUALITY_PURPOSE,
      repository: BETA_QUALITY_REPOSITORY,
      manifest_sha256: manifestReference.sha256,
      integrator_commit: manifest.integrator_commit,
      signed_at: '2026-08-02T12:00:00.000Z',
      authorization_scope: BETA_QUALITY_AUTHORIZATION_SCOPE,
    }
    receipt = {
      schema_version: 1,
      kind: 'qa-018-evidence-signature',
      attestation,
      signature: {
        algorithm: 'ed25519', key_id: keyId,
        value: sign(null, betaQualitySigningPayload(attestation), privateKey).toString('base64'),
      },
    }
    receiptReference = writeJson(evidenceDirectory, 'signature-receipt.json', receipt)
  }
  resign()

  return {
    root, base, head, evidenceDirectory, trustRoots, keyId,
    publicKey, privateKey,
    get manifest() { return manifest },
    set manifest(value) { manifest = value },
    get manifestReference() { return manifestReference },
    get receipt() { return receipt },
    get receiptReference() { return receiptReference },
    resign,
  }
}

const verifyFixture = (fixture: Fixture) => verifyQa018EvidenceBundle({
  root: fixture.root,
  evidenceDirectory: fixture.evidenceDirectory,
  manifestReference: fixture.manifestReference,
  receiptReference: fixture.receiptReference,
  testOnlyTrustRoots: fixture.trustRoots,
  testOnlyRequiredBase: fixture.base,
  testOnlyHead: fixture.head,
})

describe('beta quality coverage contract', () => {
  it('validates the immutable current-base inventory without claiming beta closure', () => {
    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'current-base' })

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.unresolved).toHaveLength(37)
    expect(result.unresolved.some((entry) => entry.item === 'QA-018')).toBe(true)
  })

  it('pins the requirement manifest and every quality evidence schema', () => {
    const checks = [
      ['requirements manifest digest differs from the pinned immutable digest', { requirementsPath: temporaryFile('requirements.json', `${fs.readFileSync(DEFAULT_REQUIREMENTS, 'utf8')} `) }],
      ['evidence schema digest differs from the pinned immutable digest', { schemaPath: temporaryFile('schema.json', `${fs.readFileSync(DEFAULT_EVIDENCE_SCHEMA, 'utf8')} `) }],
      ['tool evidence schema digest differs from the pinned immutable digest', { toolSchemaPath: temporaryFile('tool.json', `${fs.readFileSync(DEFAULT_TOOL_EVIDENCE_SCHEMA, 'utf8')} `) }],
      ['integration manifest schema digest differs from the pinned immutable digest', { integrationSchemaPath: temporaryFile('integration.json', `${fs.readFileSync(DEFAULT_INTEGRATION_MANIFEST_SCHEMA, 'utf8')} `) }],
      ['signature receipt schema digest differs from the pinned immutable digest', { signatureSchemaPath: temporaryFile('receipt.json', `${fs.readFileSync(DEFAULT_SIGNATURE_RECEIPT_SCHEMA, 'utf8')} `) }],
    ] as const
    for (const [message, options] of checks) {
      expect(evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'current-base', ...options }).errors).toContain(message)
    }
  })

  it('discovers enum, arrow transition, lowercase transitions, workflow setter, and SQL evasions', () => {
    const root = temporaryDirectory('beta-quality-discovery-')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    const fixtures = {
      'enum.ts': 'export enum HiddenState { Open, Closed }',
      'arrow.ts': 'export const transitionHiddenState = () => undefined',
      'lowercase.ts': "export const statusTransitions = { open: ['closed'] }",
      'workflow.ts': 'export class HiddenWorkflow { setStatus() {} }',
      'trigger.sql': 'CREATE TRIGGER hidden_status_transition BEFORE UPDATE ON hidden BEGIN SELECT 1; END;',
    }
    for (const [name, content] of Object.entries(fixtures)) fs.writeFileSync(path.join(root, 'src', name), content, 'utf8')
    expect(discoverStateMachineFiles(root)).toEqual(Object.keys(fixtures).sort().map((name) => `src/${name}`))
    expect(stateMachineDiscoveryDigest(root)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verifies a complete v2 inventory and obtains signer identity only from a test-local trust root', () => {
    const fixture = qa018Fixture()
    expect(verifyFixture(fixture)).toMatchObject({ ok: true, verified: true, errors: [] })

    const verification = verifyBetaQualitySignatureForTesting({
      manifestPath: path.join(fixture.evidenceDirectory, fixture.manifestReference.path),
      receiptPath: path.join(fixture.evidenceDirectory, fixture.receiptReference.path),
      testOnlyTrustRoots: fixture.trustRoots,
    })
    expect(verification).toMatchObject({
      verified: true,
      signer: 'independent-beta-reviewer',
      authorization_scope: 'qa-018-evidence-only',
      public_release_authorized: false,
    })
    expect((fixture.receipt as { signer?: string }).signer).toBeUndefined()
  })

  it('imports one external manifest/receipt pair and only its signed artifact inventory', () => {
    const fixture = qa018Fixture()
    const output = temporaryDirectory('beta-quality-imported-')
    const imported = importQa018Bundle({
      manifestArgument: path.join(fixture.evidenceDirectory, fixture.manifestReference.path),
      receiptArgument: path.join(fixture.evidenceDirectory, fixture.receiptReference.path),
      output,
    })
    expect(fs.existsSync(path.join(output, imported.manifestReference.path))).toBe(true)
    expect(fs.existsSync(path.join(output, imported.receiptReference.path))).toBe(true)
    expect(verifyQa018EvidenceBundle({
      root: fixture.root,
      evidenceDirectory: output,
      manifestReference: imported.manifestReference,
      receiptReference: imported.receiptReference,
      testOnlyTrustRoots: fixture.trustRoots,
      testOnlyRequiredBase: fixture.base,
      testOnlyHead: fixture.head,
    })).toMatchObject({ ok: true, verified: true, errors: [] })
  })

  it('captures Graphify status through a real deterministic project command', () => {
    const fixture = qa018Fixture()
    const graphDirectory = path.join(fixture.root, 'graphify-out')
    fs.mkdirSync(graphDirectory)
    fs.writeFileSync(path.join(graphDirectory, 'graph.json'), JSON.stringify({
      built_at_commit: fixture.head, nodes: [], links: [],
    }), 'utf8')
    fs.writeFileSync(path.join(graphDirectory, 'manifest.json'), JSON.stringify({
      'history.txt': { sha256: hash(fs.readFileSync(path.join(fixture.root, 'history.txt'))) },
    }), 'utf8')
    expect(captureGraphifyStatus({
      root: fixture.root,
      graphPath: 'graphify-out/graph.json',
      manifestPath: 'graphify-out/manifest.json',
      testedCommit: fixture.head,
    })).toMatchObject({
      schema_version: 1,
      operation: 'status',
      tested_commit: fixture.head,
      graph_path: 'graphify-out/graph.json',
      manifest_path: 'graphify-out/manifest.json',
    })
  })

  it('keeps production trust empty and fails closed without generating or accepting a key override', () => {
    const fixture = qa018Fixture()
    const productionRoots = JSON.parse(fs.readFileSync(DEFAULT_BETA_QUALITY_TRUST_ROOTS, 'utf8'))
    expect(productionRoots.trusted_signing_keys).toEqual([])
    expect(fs.readFileSync(DEFAULT_BETA_QUALITY_TRUST_ROOTS, 'utf8')).not.toContain('PRIVATE KEY')
    expect(() => verifyBetaQualitySignature({
      manifestPath: path.join(fixture.evidenceDirectory, fixture.manifestReference.path),
      receiptPath: path.join(fixture.evidenceDirectory, fixture.receiptReference.path),
    })).toThrow('no trusted beta-quality signing key is configured')
  })

  it('rejects unknown and revoked keys', () => {
    const fixture = qa018Fixture()
    const unknownRoots = structuredClone(fixture.trustRoots)
    unknownRoots.trusted_signing_keys[0].key_id = `sha256:${'0'.repeat(64)}`
    expect(() => verifyBetaQualitySignatureForTesting({
      manifestPath: path.join(fixture.evidenceDirectory, fixture.manifestReference.path),
      receiptPath: path.join(fixture.evidenceDirectory, fixture.receiptReference.path),
      testOnlyTrustRoots: unknownRoots,
    })).toThrow('signing key is not trusted')

    const revokedRoots = structuredClone(fixture.trustRoots)
    revokedRoots.trusted_signing_keys[0].status = 'revoked'
    expect(() => verifyBetaQualitySignatureForTesting({
      manifestPath: path.join(fixture.evidenceDirectory, fixture.manifestReference.path),
      receiptPath: path.join(fixture.evidenceDirectory, fixture.receiptReference.path),
      testOnlyTrustRoots: revokedRoots,
    })).toThrow('signing key is revoked')
  })

  it('rejects manifest and detached-signature tampering', () => {
    const fixture = qa018Fixture()
    fs.appendFileSync(path.join(fixture.evidenceDirectory, fixture.manifestReference.path), ' ')
    expect(verifyFixture(fixture).errors.join('\n')).toContain('digest mismatch')

    const signatureFixture = qa018Fixture()
    const receipt = structuredClone(signatureFixture.receipt) as any
    receipt.signature.value = `${receipt.signature.value.slice(0, -2)}AA`
    writeJson(signatureFixture.evidenceDirectory, signatureFixture.receiptReference.path, receipt)
    expect(verifyFixture(signatureFixture).errors.join('\n')).toMatch(/digest mismatch|signature verification failed/)
  })

  it.each([
    ['repository', 'Elsewhere/Other'],
    ['authorization_scope', 'public-release'],
    ['public_release_authorized', true],
    ['base_ref', 'f'.repeat(40)],
    ['integrator_commit', 'e'.repeat(40)],
  ])('rejects a signed manifest with wrong %s binding', (field, value) => {
    const fixture = qa018Fixture()
    fixture.manifest = { ...fixture.manifest, [field]: value }
    fixture.resign()
    expect(verifyFixture(fixture).ok).toBe(false)
    expect(verifyFixture(fixture).errors.length).toBeGreaterThan(0)
  })

  it('rejects QA-only evidence that attempts to authorize public release', () => {
    const fixture = qa018Fixture()
    fixture.manifest = { ...fixture.manifest, public_release_authorized: true }
    fixture.resign()
    const result = verifyFixture(fixture)
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toMatch(/public_release_authorized|QA-only scope|must not authorize a public release/)
  })

  it('rejects remediation marker substitution even when the mutated manifest is freshly signed', () => {
    const fixture = qa018Fixture()
    const manifest = structuredClone(fixture.manifest)
    manifest.slices[0].accepted_remediation_checkpoints[0].marker = '[beta-lane-a-ready]'
    fixture.manifest = manifest
    fixture.resign()
    expect(verifyFixture(fixture).errors.join('\n')).toContain('remediation checkpoint 1 base, range, or marker is not exact')
  })

  it('rejects missing signed HIGH/CRITICAL dispositions', () => {
    const fixture = qa018Fixture({ highRiskWithoutDisposition: true })
    const result = verifyFixture(fixture)
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('HIGH impact symbol-lane_a lacks one exact signed independent-review disposition')
  })

  it('accepts exactly one signed disposition for a real HIGH impact request', () => {
    expect(verifyFixture(qa018Fixture({ highRiskWithDisposition: true }))).toMatchObject({
      ok: true, verified: true, errors: [],
    })
  })

  it('rejects normalized snake_case GitNexus fields instead of treating them as exact MCP input', () => {
    const result = verifyFixture(qa018Fixture({ wrongGitRequestCasing: true }))
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toMatch(/schema validation failed|exact GitNexus MCP invocation/)
  })

  it('rejects evidence claiming the nonexistent Graphify status command', () => {
    const result = verifyFixture(qa018Fixture({ nonexistentGraphifyStatus: true }))
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('status request is not the exact supported capture-graphify-status invocation')
  })

  it('rejects raw artifact digest tampering', () => {
    const digestFixture = qa018Fixture()
    fs.appendFileSync(path.join(digestFixture.evidenceDirectory, 'lane_a/gitnexus-impact.json'), ' ')
    expect(verifyFixture(digestFixture).errors.join('\n')).toContain('digest mismatch')
  })

  it('rejects signed artifact path traversal', () => {
    const traversalFixture = qa018Fixture()
    const traversalManifest = structuredClone(traversalFixture.manifest)
    traversalManifest.slices[0].tool_reports.gitnexus.path = '../outside.json'
    traversalFixture.manifest = traversalManifest
    traversalFixture.resign()
    expect(verifyFixture(traversalFixture).errors.join('\n')).toContain('outside the evidence directory')
  })

  it('rejects symlink substitution inside the signed artifact inventory', () => {
    const symlinkFixture = qa018Fixture()
    const impact = path.join(symlinkFixture.evidenceDirectory, 'lane_a/gitnexus-impact.json')
    const outside = temporaryFile('outside-impact.json', fs.readFileSync(impact, 'utf8'))
    fs.rmSync(impact)
    fs.symlinkSync(outside, impact)
    expect(verifyFixture(symlinkFixture).errors.join('\n')).toContain('uses a symlink')
  })

  it('does not allow QA-018 case results without independently verified inventory and signature', () => {
    const report = temporaryFile('evidence.json', JSON.stringify({
      schema_version: 2,
      tested_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim(),
      requirements_sha256: PINNED_REQUIREMENTS_SHA256,
      schema_sha256: PINNED_EVIDENCE_SCHEMA_SHA256,
      tool_schema_sha256: PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
      integration_schema_sha256: PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
      signature_schema_sha256: PINNED_SIGNATURE_RECEIPT_SCHEMA_SHA256,
      qa018_closure_supported: true,
      integration_manifest: null,
      qa018_signature_receipt: null,
      artifacts: [], commands: [],
      case_results: [{ item: 'QA-018', case: 'lane-a-tool-reports', command_ids: ['qa018-tool-reports'], status: 'passed' }],
    }))
    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release', evidenceReport: report })
    expect(result.errors).toContain('evidence report QA-018 closure flag does not match independent signature and inventory verification')
    expect(result.errors).toContain('case result command binding mismatch QA-018/lane-a-tool-reports')
  })

  it('rejects pre-existing/symlinked outputs and all legacy per-lane runner flags before testing', () => {
    const runner = path.join(DEFAULT_ROOT, 'scripts/run-beta-quality-evidence.mjs')
    const existing = temporaryDirectory('beta-quality-existing-output-')
    const existingRun = spawnSync(process.execPath, [runner, '--output-dir', existing], { cwd: DEFAULT_ROOT, encoding: 'utf8' })
    expect(`${existingRun.stderr}${existingRun.stdout}`).toContain('evidence output directory must not already exist')

    const legacy = spawnSync(process.execPath, [runner, '--output-dir', path.join(temporaryRoot, `beta-quality-${randomUUID()}`), '--lane-a-gitnexus-report', 'receipt.json'], { cwd: DEFAULT_ROOT, encoding: 'utf8' })
    expect(`${legacy.stderr}${legacy.stdout}`).toContain('per-lane QA-018 flags are unsupported')

    const realParent = temporaryDirectory('beta-quality-real-parent-')
    const linkParent = `${realParent}-link`
    fs.symlinkSync(realParent, linkParent, 'dir')
    temporaryDirectories.push(linkParent)
    const symlinkRun = spawnSync(process.execPath, [runner, '--output-dir', path.join(linkParent, 'evidence')], { cwd: DEFAULT_ROOT, encoding: 'utf8' })
    expect(`${symlinkRun.stderr}${symlinkRun.stdout}`).toContain('evidence output parent must be a real, existing, non-symlink directory')
  })
})
