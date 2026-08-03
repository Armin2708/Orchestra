import { describe, expect, it } from 'vitest'
import {
  evaluateBetaMonitoring,
  validateMonitoringEvent,
} from '../scripts/beta-release-monitor.mjs'

const at = (minute: number) => `2026-08-03T10:${String(minute).padStart(2, '0')}:00.000Z`

describe('beta release monitoring evidence', () => {
  it('tracks install, provider recovery, token rate, and migration outcomes', () => {
    const report = evaluateBetaMonitoring([
      { id: 'install-1', type: 'install_succeeded', occurred_at: at(0), platform: 'macos-arm64' },
      { id: 'provider-1', type: 'provider_error', occurred_at: at(1), provider: 'codex', incident_id: 'incident-1' },
      { id: 'provider-2', type: 'provider_recovered', occurred_at: at(2), provider: 'codex', incident_id: 'incident-1' },
      { id: 'usage-1', type: 'token_usage', occurred_at: at(3), provider: 'codex', tokens: 1_000, window_seconds: 60 },
      { id: 'migration-1', type: 'migration_succeeded', occurred_at: at(4), migration_id: 'schema-42' },
    ])
    expect(report).toMatchObject({
      passed: true,
      gate_claimed: false,
      event_count: 5,
      counts: {
        installs_succeeded: 1,
        migrations_succeeded: 1,
        provider_errors: { codex: 1 },
        provider_recoveries: { codex: 1 },
        unresolved_provider_errors: 0,
        token_storms: 0,
      },
    })
  })

  it('fails closed on install/migration failures, unresolved provider errors, and token storms', () => {
    const report = evaluateBetaMonitoring([
      { id: 'install-fail', type: 'install_failed', occurred_at: at(0), platform: 'linux-x64' },
      { id: 'provider-fail', type: 'provider_error', occurred_at: at(1), provider: 'claude', incident_id: 'incident-2' },
      { id: 'usage-storm', type: 'token_usage', occurred_at: at(2), provider: 'claude', tokens: 100_000, window_seconds: 30 },
      { id: 'migration-fail', type: 'migration_failed', occurred_at: at(3), migration_id: 'schema-42' },
    ])
    expect(report.passed).toBe(false)
    expect(report.alerts.map((alert: { type: string }) => alert.type)).toEqual([
      'install_failures', 'migration_failures', 'unresolved_provider_errors', 'token_storm',
    ])
  })

  it('rejects raw diagnostic details and unmatched recovery evidence', () => {
    expect(() => validateMonitoringEvent({
      id: 'bad', type: 'install_failed', occurred_at: at(0), raw_error: 'credential leaked',
    })).toThrow(/field is not allowed/)
    expect(() => evaluateBetaMonitoring([{
      id: 'recovery', type: 'provider_recovered', occurred_at: at(0),
      provider: 'codex', incident_id: 'never-seen',
    }])).toThrow(/no observed error/)
  })
})
