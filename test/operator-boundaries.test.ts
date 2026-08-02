import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildOperatorTelemetryEnvelope,
  redactedInstallationId,
} from '../src/operator-telemetry.js'
import { checkOperatorContractCompatibility } from '../src/operator-contract.js'
import { prepareSupportCase } from '../src/support-workflow.js'

describe('operator compatibility, telemetry, and support boundaries', () => {
  it('keeps external telemetry off and emits only an allowlisted redacted envelope', () => {
    expect(buildOperatorTelemetryEnvelope('off', 'a'.repeat(32), {
      event: 'doctor_completed',
    })).toBeNull()
    const envelope = buildOperatorTelemetryEnvelope(
      'redacted',
      'a'.repeat(32),
      {
        event: 'doctor_completed',
        properties: { provider: 'codex', result: 'blocked', platform: 'darwin' },
      },
      () => '2026-08-02T12:00:00.000Z',
    )
    expect(envelope).toEqual({
      schema_version: 1,
      event: 'doctor_completed',
      installation_id: redactedInstallationId('a'.repeat(32)),
      occurred_at: '2026-08-02T12:00:00.000Z',
      properties: { provider: 'codex', result: 'blocked', platform: 'darwin' },
    })
    expect(JSON.stringify(envelope)).not.toContain('/workspace')
    expect(() => buildOperatorTelemetryEnvelope('redacted', 'a'.repeat(32), {
      event: 'doctor_completed',
      properties: { arbitrary_path: '/workspace/private' } as any,
    })).toThrow('telemetry property is not allowlisted')
    expect(() => buildOperatorTelemetryEnvelope('unknown' as any, 'a'.repeat(32), {
      event: 'doctor_completed',
    })).toThrow('telemetry consent must be off or redacted')
    expect(() => buildOperatorTelemetryEnvelope('redacted', 'short', {
      event: 'doctor_completed',
    })).toThrow('bounded local string')
    expect(() => buildOperatorTelemetryEnvelope('redacted', 'a'.repeat(32), {
      event: 'doctor_completed',
    }, () => 'not-a-time')).toThrow('canonical bounded ISO timestamp')
  })

  it('fails compatibility closed on any major contract mismatch', () => {
    expect(checkOperatorContractCompatibility({
      contract_version: 1,
      first_run_schema_version: 1,
      provider_contract_version: 1,
    })).toEqual({ compatible: true, blockers: [] })
    expect(checkOperatorContractCompatibility({
      contract_version: 2,
      first_run_schema_version: 1,
      provider_contract_version: 2,
    })).toEqual({
      compatible: false,
      blockers: ['operator_contract_major_mismatch', 'provider_contract_mismatch'],
    })
  })

  it('creates a support case only from a verified redacted diagnostics manifest', () => {
    const bundleBytes = Buffer.from('{"versions":[],"health":"ok"}\n')
    const bundleDigest = createHash('sha256').update(bundleBytes).digest('hex')
    const diagnostics = {
      schema_version: 1 as const,
      bundle_file: 'orchestra-diagnostics-20260802.zip',
      sha256: bundleDigest,
      byte_length: bundleBytes.length,
      generated_at: '2026-08-02T12:00:00.000Z',
      redaction_verified: true,
      secret_findings: 0,
      included_categories: ['versions', 'health', 'redacted-errors'],
    }
    const verifyBundle = () => ({
      verified: true as const,
      verifier_id: 'lane-c-redactor-v1',
      sha256: createHash('sha256').update(bundleBytes).digest('hex'),
      byte_length: bundleBytes.length,
      redaction_verified: true as const,
      secret_findings: 0 as const,
    })
    const deps = { verifyBundle, nowMs: () => Date.parse('2026-08-02T13:00:00.000Z') }
    expect(() => prepareSupportCase({
      title: 'Blocked', summary: 'Safe', reproduction_steps: ['Run doctor'],
      expected: 'Ready', actual: 'Blocked', exact_commit: 'b'.repeat(40),
      orchestra_version: '0.1.0', diagnostics,
    })).toThrow('verifier is not registered')
    const result = prepareSupportCase({
      title: 'Provider readiness is blocked',
      summary: 'Doctor reports a version mismatch.',
      reproduction_steps: ['Run orchestra doctor --provider codex --json'],
      expected: 'The accepted executable version is ready.',
      actual: 'The installed executable is outside the accepted matrix.',
      exact_commit: 'b'.repeat(40),
      orchestra_version: '0.1.0-beta.1',
      diagnostics,
    }, deps)
    expect(result.diagnostics).toEqual(expect.objectContaining({
      bundle_file: diagnostics.bundle_file,
      sha256: diagnostics.sha256,
    }))
    expect(() => prepareSupportCase({
      title: 'Failure',
      summary: 'token=raw-secret',
      reproduction_steps: ['Run doctor'],
      expected: 'Ready',
      actual: 'Blocked',
      exact_commit: 'b'.repeat(40),
      orchestra_version: '0.1.0',
      diagnostics,
    }, deps)).toThrow('appears to contain a secret')
    expect(() => prepareSupportCase({
      title: 'Failure',
      summary: 'Safe summary',
      reproduction_steps: ['Run doctor'],
      expected: 'Ready',
      actual: 'Blocked',
      exact_commit: 'b'.repeat(40),
      orchestra_version: '0.1.0',
      diagnostics: { ...diagnostics, redaction_verified: false },
    }, deps)).toThrow('not verified safe')
    expect(() => prepareSupportCase({
      title: '-----BEGIN PRIVATE KEY-----',
      summary: 'Safe', reproduction_steps: ['Run doctor'], expected: 'Ready', actual: 'Blocked',
      exact_commit: 'b'.repeat(40), orchestra_version: '0.1.0', diagnostics,
    }, deps)).toThrow('appears to contain a secret')
    expect(() => prepareSupportCase({
      title: 'Blocked', summary: 'Safe', reproduction_steps: ['Run doctor'], expected: 'Ready', actual: 'Blocked',
      exact_commit: 'b'.repeat(40), orchestra_version: '0.1.0', diagnostics,
    }, {
      ...deps,
      verifyBundle: () => ({ ...verifyBundle(), sha256: 'c'.repeat(64) }),
    })).toThrow('did not bind')
    expect(() => prepareSupportCase({
      title: 'Blocked', summary: 'github_pat_abcdefghijklmnopqrstuvwxyz',
      reproduction_steps: ['Run doctor'], expected: 'Ready', actual: 'Blocked',
      exact_commit: 'b'.repeat(40), orchestra_version: '0.1.0', diagnostics,
    }, deps)).toThrow('appears to contain a secret')
    expect(() => prepareSupportCase({
      title: 'Blocked', summary: 'Safe', reproduction_steps: ['Run doctor'],
      expected: 'Ready', actual: 'Blocked', exact_commit: 'b'.repeat(40),
      orchestra_version: '0.1.0',
      diagnostics: { ...diagnostics, included_categories: ['raw-transcripts'] },
    }, deps)).toThrow('not verified safe')
    expect(() => prepareSupportCase({
      title: 'Blocked', summary: 'Safe', reproduction_steps: ['Run doctor'],
      expected: 'Ready', actual: 'Blocked', exact_commit: 'b'.repeat(40),
      orchestra_version: '0.1.0',
      diagnostics: { ...diagnostics, bundle_file: '../diagnostics.zip' },
    }, deps)).toThrow('basename')
  })
})
