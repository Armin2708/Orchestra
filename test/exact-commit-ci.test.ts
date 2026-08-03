import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEvidenceManifest,
  verifyExactCommit,
} from '../scripts/exact-commit-evidence.mjs'
import { manifestContractBinding } from '../scripts/exact-commit-contract.mjs'

type ActionPin = {
  uses: string
  release: string
  sha: string
}

type Contract = {
  schema_version: number
  backlog_item: string
  workflow: string
  runner: string
  node_version: string
  npm_version: string
  codex_cli_version: string
  artifact_retention_days: number
  gitleaks: {
    version: string
    linux_x64_archive_sha256: string
  }
  accepted_moderate_packages_by_gate: Record<string, string[]>
  action_pins: ActionPin[]
  required_gates: string[]
}

type EvidenceRecord = {
  schema_version: number
  commit_sha: string
  gate_id: string
  status: string
  exit_code: number
  started_at: string
  completed_at: string
  invocation: { executable: string }
  runner: { platform: string; arch: string; node_version: string }
  details: Record<string, unknown>
}

const root = path.resolve(import.meta.dirname, '..')
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')
const contract = JSON.parse(read('scripts/exact-commit-ci-contract.json')) as Contract
const workflow = read(contract.workflow)
const evidenceScript = read('scripts/exact-commit-evidence.mjs')
const gitleaksInstaller = read('scripts/install-gitleaks.mjs')
const packageSmoke = read('scripts/package-install-smoke.mjs')
const publishVerifier = read('scripts/verify-publish-artifact.mjs')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const git = (directory: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })

const passedRecord = (
  gateId: string,
  commitSha: string,
  details: Record<string, unknown> = {},
): EvidenceRecord => ({
  schema_version: 1,
  commit_sha: commitSha,
  gate_id: gateId,
  status: 'passed',
  exit_code: 0,
  started_at: '2026-07-25T00:00:00.000Z',
  completed_at: '2026-07-25T00:00:01.000Z',
  invocation: { executable: 'test' },
  runner: { platform: 'linux', arch: 'x64', node_version: contract.node_version },
  details,
})

describe('QA-019 exact-commit CI contract', () => {
  it('rejects tracked changes even when HEAD still matches the claimed commit', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-exact-source-'))
    temporaryDirectories.push(directory)
    git(directory, 'init', '-q')
    git(directory, 'config', 'user.name', 'Exact Commit Test')
    git(directory, 'config', 'user.email', 'exact@example.invalid')
    fs.writeFileSync(path.join(directory, 'README.md'), '# clean\n')
    git(directory, 'add', 'README.md')
    git(directory, 'commit', '-qm', 'fixture')
    const sha = git(directory, 'rev-parse', 'HEAD').trim()
    const evidenceDirectory = path.join(directory, 'evidence')
    const priorDirectory = process.env.CI_EVIDENCE_DIR
    const priorSha = process.env.CI_EVIDENCE_SHA
    process.env.CI_EVIDENCE_DIR = evidenceDirectory
    process.env.CI_EVIDENCE_SHA = sha
    try {
      expect(verifyExactCommit('exact-commit', sha, directory)).toBe(0)
      fs.appendFileSync(path.join(directory, 'README.md'), 'dirty\n')
      expect(verifyExactCommit('exact-commit', sha, directory)).toBe(1)
      const record = JSON.parse(
        fs.readFileSync(path.join(evidenceDirectory, 'records', 'exact-commit.json'), 'utf8'),
      )
      expect(record).toMatchObject({
        status: 'failed',
        details: { tracked_source_clean: false },
      })
    } finally {
      if (priorDirectory === undefined) delete process.env.CI_EVIDENCE_DIR
      else process.env.CI_EVIDENCE_DIR = priorDirectory
      if (priorSha === undefined) delete process.env.CI_EVIDENCE_SHA
      else process.env.CI_EVIDENCE_SHA = priorSha
    }
  })

  it('pins every third-party action to a reviewed immutable commit', () => {
    const usesLines = workflow.split(/\r?\n/).filter((line) => line.includes('uses:'))
    expect(usesLines.length).toBeGreaterThan(0)

    const observed = usesLines.map((line) => {
      const match = line.match(/uses:\s+([^@\s]+)@([0-9a-f]{40})\s+#\s+(\S+)/)
      expect(match, `action is not commit-pinned: ${line.trim()}`).not.toBeNull()
      return { uses: match![1], sha: match![2], release: match![3] }
    })
    const pins = new Map(contract.action_pins.map((pin) => [pin.uses, pin]))

    for (const action of observed) {
      expect(action).toEqual(pins.get(action.uses))
    }
    for (const pin of contract.action_pins) {
      expect(observed.some((action) => action.uses === pin.uses)).toBe(true)
      expect(pin.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(pin.release).toMatch(/^v\d+\.\d+\.\d+$/)
    }
  })

  it('checks out and proves github.sha without a privileged pull-request trigger', () => {
    expect(workflow).toContain('ref: ${{ github.sha }}')
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain("id: checkout_identity")
    expect(workflow).toContain('run: test "$(git rev-parse HEAD)" = "$GITHUB_SHA"')
    expect(workflow).toContain('verify-commit exact-commit "$GITHUB_SHA"')
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow).not.toContain('OPENAI_API_KEY')
    expect(workflow).not.toContain('ANTHROPIC_API_KEY')
    expect(workflow).not.toContain('GITLEAKS_LICENSE')
  })

  it('requires every release gate and retains failure evidence for the exact SHA', () => {
    expect(contract.schema_version).toBe(1)
    expect(contract.backlog_item).toBe('QA-019')
    expect(contract.runner).toBe('ubuntu-24.04')
    expect(contract.node_version).toBe('22.20.0')
    expect(contract.npm_version).toBe('10.9.3')
    expect(workflow.match(/node-version: 22\.20\.0/g)).toHaveLength(2)
    expect(contract.codex_cli_version).toBe('0.146.0')
    expect(contract.artifact_retention_days).toBe(30)
    expect(contract.accepted_moderate_packages_by_gate).toEqual({
      'dependency-audit-root': [],
      'dependency-audit-web': [],
    })
    expect(contract.required_gates).toHaveLength(new Set(contract.required_gates).size)

    for (const gate of contract.required_gates) {
      expect(workflow, `workflow does not execute or record ${gate}`).toContain(gate)
    }
    expect(workflow).toContain('npm test -- --no-file-parallelism')
    expect(workflow).toContain('run tests-default-parallel -- npm test')
    expect(workflow).toContain('audit dependency-audit-root')
    expect(workflow).toContain('audit dependency-audit-web --prefix web')
    expect(workflow).toContain('doctor --provider both --json')
    expect(workflow).toContain('npm run check:codex-protocol')
    expect(workflow).toContain('npm run check:codex-app-server')
    expect(workflow).toContain('./scripts/e2e.sh')
    expect(workflow).toContain('name: orchestra-package-${{ github.sha }}')
    expect(workflow).toContain('name: orchestra-ci-evidence-${{ github.sha }}')
    expect(
      workflow.match(
        /if: \$\{\{ always\(\) && steps\.checkout_identity\.outcome == 'success' \}\}/g,
      ),
    ).toHaveLength(4)
    expect(workflow).toContain('if: ${{ always() }}')
    expect(workflow.match(/retention-days: 30/g)).toHaveLength(2)
    expect(workflow).toContain('if-no-files-found: error')
    expect(workflow).toContain('artifact_digest=${{ steps.package_upload.outputs.artifact-digest }}')
  })

  it('keeps the scanner and package artifact supply chain closed and machine checked', () => {
    expect(contract.gitleaks.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(contract.gitleaks.linux_x64_archive_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(gitleaksInstaller).toContain('actualSha256 !== expectedSha256')
    expect(workflow).toContain('"$CI_EVIDENCE_DIR/tools/gitleaks" git . --redact')
    expect(workflow).toContain('"--log-opts=--full-history -m $GITHUB_SHA"')
    expect(workflow).toContain('vitest run test/gitleaks-ignore.test.ts')
    expect(packageSmoke).toContain("'--ignore-scripts'")
    expect(packageSmoke).toContain("'dist/cli.js'")
    expect(packageSmoke).toContain("'web/dist/index.html'")
    expect(packageSmoke).toContain("'.claude-plugin/plugin.json'")
    expect(packageSmoke).toContain("'.codex-plugin/plugin.json'")
    expect(packageSmoke).toContain('runPackageLifecycle')
    expect(packageSmoke).toContain('byte_identical')
    expect(packageSmoke).toContain('package-metadata.json')
    expect(evidenceScript).not.toContain('process.env.OPENAI_API_KEY')
    expect(evidenceScript).not.toContain('process.env.ANTHROPIC_API_KEY')
    expect(publishVerifier).not.toContain('process.env.OPENAI_API_KEY')
    expect(publishVerifier).not.toContain('process.env.ANTHROPIC_API_KEY')
  })

  it('keeps publication disabled until npm-beta reviewer protection is externally verified', () => {
    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'))
    expect(publishJob).toContain(
      'uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
    )
    expect(publishJob.match(/actions\/download-artifact@/g)).toHaveLength(2)
    expect(publishJob).toContain('artifact-ids: ${{ needs.test.outputs.package_artifact_id }}')
    expect(publishJob).toContain('artifact-ids: ${{ needs.test.outputs.evidence_artifact_id }}')
    expect(publishJob.match(/digest-mismatch: error/g)).toHaveLength(2)
    expect(publishJob).toContain('node scripts/verify-publish-artifact.mjs')
    expect(publishJob).toContain(
      'npm publish "$RUNNER_TEMP/orchestra-release/verified/verified.tgz"',
    )
    expect(publishJob).toContain('--ignore-scripts --provenance --access public')
    expect(publishJob).toContain('--tag beta')
    expect(publishJob).toContain('if: ${{ false }}')
    expect(publishJob).not.toContain("contains(github.ref_name, '-')")
    expect(publishJob).not.toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(publishJob).toContain('environment: npm-beta')
    expect(publishJob).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}')
    expect(publishJob).not.toContain('npm ci')
    expect(publishJob).not.toContain('npm pack')
    expect(publishJob).not.toContain('npm run build')
    expect(publishJob).not.toContain('npm publish --provenance')
  })

  it('includes secrets introduced only by merge conflict resolution in the scanned history', () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-ci-merge-history-'))
    temporaryDirectories.push(repository)
    git(repository, 'init', '-b', 'main')
    git(repository, 'config', 'user.name', 'QA-019')
    git(repository, 'config', 'user.email', 'qa019@example.invalid')

    const fixture = path.join(repository, 'fixture.txt')
    fs.writeFileSync(fixture, 'mode=base\n')
    git(repository, 'add', 'fixture.txt')
    git(repository, 'commit', '-m', 'base')

    git(repository, 'checkout', '-b', 'feature')
    fs.writeFileSync(fixture, 'mode=feature\n')
    git(repository, 'commit', '-am', 'feature')

    git(repository, 'checkout', 'main')
    fs.writeFileSync(fixture, 'mode=main\n')
    git(repository, 'commit', '-am', 'main')

    const merge = spawnSync('git', ['merge', '--no-ff', 'feature', '-m', 'merge'], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
    expect(merge.status).not.toBe(0)

    const mergeOnlyMarker = ['api', '_key=', 'MERGE_RESOLUTION_', 'SENTINEL'].join('')
    fs.writeFileSync(fixture, `mode=merged\n${mergeOnlyMarker}\n`)
    git(repository, 'add', 'fixture.txt')
    git(repository, 'commit', '--no-edit')

    const defaultHistory = git(repository, 'log', '-p', '-U0', 'HEAD')
    expect(defaultHistory).not.toContain(mergeOnlyMarker)

    const configured = workflow.match(/"--log-opts=([^"]+)"/)
    expect(configured).not.toBeNull()
    const configuredOptions = configured![1]
      .replace('$GITHUB_SHA', 'HEAD')
      .trim()
      .split(/\s+/)
    const scannedHistory = git(repository, 'log', '-p', '-U0', ...configuredOptions)
    expect(scannedHistory).toContain(mergeOnlyMarker)
  })

  it('builds a deterministic passed manifest only for complete same-SHA evidence', () => {
    const commitSha = 'a'.repeat(40)
    const records = contract.required_gates.map((gateId) =>
      passedRecord(
        gateId,
        commitSha,
        gateId === 'package-upload'
          ? { artifact_digest: 'b'.repeat(64), artifact_id: '42' }
          : {},
      ))
    const packageArtifact = {
      schema_version: 1,
      commit_sha: commitSha,
      package_name: 'orchestra-board',
      package_version: '0.1.0',
      filename: 'orchestra-board-0.1.0.tgz',
      sha256: 'c'.repeat(64),
      source_identity: {
        expected_commit: commitSha,
        observed_commit: commitSha,
        tracked_source_clean: true,
        packaged_nonbuild_inputs_tracked: true,
      },
      install_smoke: {
        scripts_disabled: true,
        cli_version: '0.1.0',
        passed: true,
      },
      lifecycle: {
        local_rehearsal_passed: true,
        release_gate: {
          status: 'passed',
          prior_evidence_verified: true,
          upgrade_passed: true,
          rollback_passed: true,
        },
        data_preservation: {
          database_continuity: {
            after_upgrade: { passed: true },
            after_rollback: { passed: true },
            after_uninstall: { passed: true },
          },
        },
        passed: true,
      },
    }
    const manifest = createEvidenceManifest({
      contract,
      expectedSha: commitSha,
      records,
      packageArtifact,
      generatedAt: '2026-07-25T00:00:02.000Z',
      workflowRun: { run_id: '1', run_attempt: '1' },
    })

    expect(manifest).toMatchObject({
      schema_version: 1,
      backlog_item: 'QA-019',
      commit_sha: commitSha,
      result: 'passed',
      summary: {
        required: contract.required_gates.length,
        passed: contract.required_gates.length,
        failed: 0,
        missing: 0,
        sha_consistent: true,
        package_consistent: true,
        package_upload_evidence_present: true,
      },
      unexpected_gates: [],
      package_artifact: packageArtifact,
    })
    expect(manifest.gates.map((gate: EvidenceRecord) => gate.gate_id))
      .toEqual(contract.required_gates)
    expect(manifest.contract).toEqual(manifestContractBinding(contract))
    expect(manifest.contract.contract_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.contract.contract_sha256).not.toBe(
      manifestContractBinding({ ...contract, codex_cli_version: 'changed' }).contract_sha256,
    )

    const missingSourceIdentity = structuredClone(packageArtifact)
    delete missingSourceIdentity.source_identity
    expect(createEvidenceManifest({
      contract,
      expectedSha: commitSha,
      records,
      packageArtifact: missingSourceIdentity,
      generatedAt: '2026-07-25T00:00:02.000Z',
      workflowRun: { run_id: '1', run_attempt: '1' },
    })).toMatchObject({ result: 'failed', summary: { package_consistent: false } })

    const missingContinuity = structuredClone(packageArtifact)
    delete missingContinuity.lifecycle.data_preservation.database_continuity
    expect(createEvidenceManifest({
      contract,
      expectedSha: commitSha,
      records,
      packageArtifact: missingContinuity,
      generatedAt: '2026-07-25T00:00:02.000Z',
      workflowRun: { run_id: '1', run_attempt: '1' },
    })).toMatchObject({ result: 'failed', summary: { package_consistent: false } })

    const noPriorArtifact = structuredClone(packageArtifact)
    noPriorArtifact.lifecycle.release_gate.status = 'incomplete'
    noPriorArtifact.lifecycle.passed = false
    const noPriorManifest = createEvidenceManifest({
      contract,
      expectedSha: commitSha,
      records,
      packageArtifact: noPriorArtifact,
      generatedAt: '2026-07-25T00:00:02.000Z',
      workflowRun: { run_id: '1', run_attempt: '1' },
    })
    expect(noPriorManifest).toMatchObject({
      result: 'failed',
      summary: { package_consistent: false },
      package_artifact: {
        lifecycle: {
          local_rehearsal_passed: true,
          release_gate: { status: 'incomplete' },
          passed: false,
        },
      },
    })
  })

  it('fails closed for missing, failed, or cross-commit evidence while remaining serializable', () => {
    const commitSha = 'd'.repeat(40)
    const records = contract.required_gates.slice(0, -1).map((gateId) =>
      passedRecord(gateId, commitSha))
    records[0] = { ...records[0], commit_sha: 'e'.repeat(40), status: 'failed', exit_code: 1 }
    const manifest = createEvidenceManifest({
      contract,
      expectedSha: commitSha,
      records,
      packageArtifact: null,
      generatedAt: '2026-07-25T00:00:02.000Z',
      workflowRun: {},
    })

    expect(manifest.result).toBe('failed')
    expect(manifest.summary).toMatchObject({
      failed: 1,
      missing: 1,
      sha_consistent: false,
      package_consistent: false,
      package_upload_evidence_present: false,
    })
    expect(() => JSON.stringify(manifest)).not.toThrow()
  })
})
