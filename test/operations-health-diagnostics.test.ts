import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OPERATIONS_HEALTH_COMPONENTS,
  OperationsDiagnosticsBundle,
  OperationsHealthService,
  type OperationsHealthComponent,
  type OperationsHealthProbe,
} from '../src/operations/index.js'

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function probes(
  override: Partial<Record<OperationsHealthComponent, OperationsHealthProbe['check']>> = {},
): OperationsHealthProbe[] {
  return OPERATIONS_HEALTH_COMPONENTS.map((component) => ({
    component,
    required: component !== 'tunnels',
    check: override[component] ?? (() => ({ status: component === 'tunnels' ? 'disabled' : 'ready' })),
  }))
}

describe('comprehensive operations health and diagnostics', () => {
  it('requires all declared probes and reports required failures without leaking error text', async () => {
    expect(() => new OperationsHealthService(probes().slice(1))).toThrow(
      'missing health probe: database',
    )
    const service = new OperationsHealthService(probes({
      database: () => { throw new Error('password=database-secret /private/db') },
      providers: () => ({
        status: 'degraded',
        reasonCode: 'provider_backoff',
        details: { authorization: 'Bearer provider-secret', provider: 'codex' },
      }),
    }), { clock: () => new Date('2026-08-02T09:00:00.000Z') })

    const snapshot = await service.check()
    expect(snapshot.status).toBe('unavailable')
    expect(service.publicStatus(snapshot)).toEqual({ live: true, ready: false })
    expect(snapshot.components).toHaveLength(9)
    expect(snapshot.components.find((item) => item.component === 'database')).toMatchObject({
      required: true, status: 'unavailable', reasonCode: 'probe_failed', details: {},
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('database-secret')
    expect(serialized).not.toContain('/private/db')
    expect(serialized).not.toContain('provider-secret')
  })

  it('times out hung probes and treats an optional tunnel failure as degraded', async () => {
    const service = new OperationsHealthService(probes({
      tunnels: () => new Promise(() => undefined),
    }), { defaultTimeoutMs: 10 })
    const snapshot = await service.check()
    expect(snapshot.status).toBe('degraded')
    expect(snapshot.components.find((item) => item.component === 'tunnels')).toMatchObject({
      status: 'unavailable', reasonCode: 'probe_timeout', required: false,
    })
    expect(service.publicStatus(snapshot)).toEqual({ live: true, ready: true })
  })

  it('creates an allowlisted gzip diagnostics bundle and writes it owner-only without traversal', async () => {
    const health = await new OperationsHealthService(probes()).check()
    const bundle = new OperationsDiagnosticsBundle(
      () => new Date('2026-08-02T10:00:00.000Z'),
    )
    const artifact = bundle.create({
      generatedByVersion: '0.1.0',
      revision: 'a'.repeat(40),
      health,
      metrics: [{
        name: 'queue_depth', value: 4, labels: {}, observed_at: '2026-08-02T10:00:00.000Z',
      }],
      recentLogs: [{
        timestamp: '2026-08-02T10:00:00.000Z', level: 'error', event: 'provider.failed',
        attributes: {
          provider: 'codex',
          command: 'cat /Users/person/.env',
          raw_response: 'Bearer diagnostics-secret',
          context: 'private source context',
        },
        redactions: 0,
      }],
      runtime: {
        nodeVersion: 'v22.20.0', platform: process.platform, arch: process.arch, uptimeSeconds: 42,
      },
      configuration: {
        max_active_sessions: 8,
        token: 'master-token-must-not-survive',
        workspace_path: '/Users/person/private-project',
      },
    })

    const decoded = gunzipSync(artifact.bytes).toString('utf8')
    expect(JSON.parse(decoded)).toMatchObject({
      schema_version: 1,
      generator: { version: '0.1.0', revision: 'a'.repeat(40) },
      runtime: { node_version: 'v22.20.0', uptime_seconds: 42 },
      configuration: { max_active_sessions: 8 },
    })
    for (const sensitive of [
      'cat /Users', 'diagnostics-secret', 'private source', 'master-token', '/Users/person',
    ]) expect(decoded).not.toContain(sensitive)
    expect(artifact.redactions).toBeGreaterThanOrEqual(5)

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-diag-test-'))
    tempRoots.push(root)
    const written = bundle.write(root, artifact)
    expect(path.dirname(written.path)).toBe(fs.realpathSync(root))
    expect(fs.statSync(written.path).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(written.path)).toEqual(artifact.bytes)
    expect(() => bundle.write(root, { ...artifact, filename: '../escape.json.gz' })).toThrow(
      'unsafe diagnostics filename',
    )
  })
})
