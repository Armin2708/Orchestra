import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  OPERATIONS_CHAOS_IDS,
  REMOTE_SECURITY_ACCEPTANCE_IDS,
  runOperationsChaosContract,
  runRemoteSecurityAdversarialContract,
  type AdversarialAction,
  type AdversarialObservation,
  type RemoteOpsAdversarialTarget,
} from './support/remote-ops-adversarial-contract.js'

type ThreatMatrix = {
  abuse_cases: Array<{ id: string; target_expected: string }>
  target_controls: Array<{ id: string; verification_ids: string[] }>
  release_gate: { required_before_safe_remote_beta: string[] }
}

class DenyAllProbe implements RemoteOpsAdversarialTarget {
  actions: AdversarialAction[] = []

  async reset() {
    this.actions = []
  }

  async perform(action: AdversarialAction): Promise<AdversarialObservation> {
    this.actions.push(action)
    return { status: 501 }
  }
}

const matrix = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'docs/remote-mobile-threat-control-matrix.json'),
  'utf8',
)) as ThreatMatrix

describe('independent remote security and operations adversarial contract', () => {
  test('covers the canonical AC-01 through AC-20 register exactly once', () => {
    const expected = matrix.abuse_cases.map(({ id }) => id)
    expect(expected).toEqual(Array.from({ length: 20 }, (_, index) => `AC-${String(index + 1).padStart(2, '0')}`))
    expect(REMOTE_SECURITY_ACCEPTANCE_IDS).toEqual(expected)
    expect(new Set(REMOTE_SECURITY_ACCEPTANCE_IDS).size).toBe(20)
  })

  test('keeps every target control connected to executable abuse evidence', () => {
    for (const control of matrix.target_controls) {
      expect(control.verification_ids.length, control.id).toBeGreaterThan(0)
      for (const verificationId of control.verification_ids) {
        expect(REMOTE_SECURITY_ACCEPTANCE_IDS, `${control.id} -> ${verificationId}`).toContain(verificationId)
      }
    }
  })

  test('executes every security case and reports fail-closed adapters as failures', async () => {
    const results = await runRemoteSecurityAdversarialContract(new DenyAllProbe())
    expect(results.map(({ id }) => id)).toEqual(REMOTE_SECURITY_ACCEPTANCE_IDS)
    expect(results).toHaveLength(20)
    expect(results.every(({ status, error }) => status === 'failed' && typeof error === 'string')).toBe(true)
  })

  test('executes crash, survivor-race, outbox, and dependency-fault chaos cases', async () => {
    expect(OPERATIONS_CHAOS_IDS).toEqual([
      'OPS-CHAOS-01',
      'OPS-CHAOS-02',
      'OPS-CHAOS-03',
      'OPS-CHAOS-04',
    ])
    const results = await runOperationsChaosContract(new DenyAllProbe())
    expect(results.map(({ id }) => id)).toEqual(OPERATIONS_CHAOS_IDS)
    expect(results.every(({ status }) => status === 'failed')).toBe(true)
  })

  test('retains the release-gate expectations the harness is designed to prove', () => {
    expect(matrix.release_gate.required_before_safe_remote_beta).toEqual(expect.arrayContaining([
      expect.stringMatching(/PairingTicket/),
      expect.stringMatching(/expiry.*rotation.*revocation/i),
      expect.stringMatching(/default-deny/i),
      expect.stringMatching(/device-attributed/i),
      expect.stringMatching(/Host.*Origin.*rate-limit/i),
      expect.stringMatching(/offline read-only/i),
      expect.stringMatching(/AC-01 through AC-20/),
      expect.stringMatching(/Independent regression and security review/i),
    ]))
  })
})
