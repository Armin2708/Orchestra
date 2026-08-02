import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPERATIONS_HEALTH_COMPONENTS,
  OperationsDiagnosticsBundle,
  OperationsHealthService,
} from '../src/operations/index.js'
import {
  SUPPORT_CASE_EXPORT_CONSENT,
  createSupportCaseExport,
  verifyOperationsDiagnosticsArtifact,
  writeSupportCaseExport,
} from '../src/support-case-export.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const clock = () => new Date('2026-08-02T15:00:00.000Z')
const nowMs = () => clock().getTime()

const diagnostics = async () => {
  const health = await new OperationsHealthService(
    OPERATIONS_HEALTH_COMPONENTS.map((component) => ({
      component,
      required: component !== 'tunnels',
      check: () => ({ status: component === 'tunnels' ? 'disabled' as const : 'ready' as const }),
    })),
    { clock },
  ).check()
  return new OperationsDiagnosticsBundle(clock).create({
    generatedByVersion: '0.1.0',
    revision: 'a'.repeat(40),
    health,
    metrics: [{
      name: 'queue_depth', value: 1, labels: {}, observed_at: clock().toISOString(),
    }],
    recentLogs: [{
      timestamp: clock().toISOString(), level: 'error', event: 'provider.failed',
      attributes: {
        provider: 'codex',
        command: 'cat /Users/operator/private',
        raw_response: 'Bearer should-not-survive',
      },
      redactions: 0,
    }],
    runtime: {
      nodeVersion: 'v22.20.0', platform: process.platform, arch: process.arch, uptimeSeconds: 3,
    },
    configuration: {
      max_active_sessions: 3,
      token: 'must-not-survive',
      workspace_path: '/Users/operator/project',
    },
  })
}

const request = {
  title: 'Provider launch is blocked',
  summary: 'The readiness check reports an accepted version mismatch.',
  reproduction_steps: ['Run the readiness check', 'Select the local provider'],
  expected: 'The accepted executable is ready.',
  actual: 'The executable remains blocked.',
  exact_commit: 'b'.repeat(40),
  orchestra_version: '0.1.0',
  consent: SUPPORT_CASE_EXPORT_CONSENT,
}

const rewrite = (
  artifact: Awaited<ReturnType<typeof diagnostics>>,
  mutate: (payload: Record<string, unknown>) => void,
) => {
  const payload = JSON.parse(gunzipSync(artifact.bytes).toString('utf8')) as Record<string, unknown>
  mutate(payload)
  const bytes = gzipSync(Buffer.from(`${JSON.stringify(payload, null, 2)}\n`), { level: 9 })
  return { ...artifact, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

describe('strict diagnostics-backed support-case export', () => {
  it('binds genuine redacted gzip bytes into one review-required local export', async () => {
    const source = await diagnostics()
    const parsed = verifyOperationsDiagnosticsArtifact(source, nowMs)
    expect(parsed.verification).toMatchObject({
      verified: true,
      verifier_id: 'operations-diagnostics-strict-v1',
      sha256: source.sha256,
      byte_length: source.bytes.length,
      secret_findings: 0,
    })

    const exported = createSupportCaseExport({ request, diagnostics: source, nowMs })
    expect(exported.value.review).toEqual({
      required_before_sharing: true,
      transport_registered: false,
      publication_performed: false,
    })
    expect(Buffer.from(exported.value.diagnostics_bundle.bytes, 'base64')).toEqual(source.bytes)
    expect(exported.value.diagnostics_bundle.byte_length).toBe(source.bytes.byteLength)
    expect(exported.value.diagnostics_bundle.sha256).toBe(source.sha256)
    expect(exported.value.support_case.diagnostics).toMatchObject({
      bundle_file: source.filename,
      sha256: source.sha256,
      verifier_id: 'operations-diagnostics-strict-v1',
    })
    const decoded = gunzipSync(Buffer.from(exported.value.diagnostics_bundle.bytes, 'base64')).toString('utf8')
    for (const forbidden of ['should-not-survive', 'must-not-survive', '/Users/operator']) {
      expect(decoded).not.toContain(forbidden)
      expect(exported.bytes.toString('utf8')).not.toContain(forbidden)
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-support-export-'))
    roots.push(root)
    const destination = writeSupportCaseExport(root, exported)
    expect(path.dirname(destination)).toBe(fs.realpathSync(root))
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(destination)).toEqual(exported.bytes)
    expect(() => writeSupportCaseExport(root, exported)).toThrow()
    expect(() => writeSupportCaseExport(root, { ...exported, filename: '../escape.json' })).toThrow(
      'support-case export artifact is invalid',
    )
  })

  it('uses canonical containment and never follows or removes a swapped output path', async () => {
    const exported = createSupportCaseExport({ request, diagnostics: await diagnostics(), nowMs })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-support-export-'))
    roots.push(root)
    const canonical = path.join(root, 'canonical')
    fs.mkdirSync(canonical)
    const alias = path.join(root, 'alias')
    fs.symlinkSync(canonical, alias, 'dir')
    const destination = writeSupportCaseExport(alias, exported)
    expect(path.dirname(destination)).toBe(fs.realpathSync(canonical))

    const target = path.join(root, 'do-not-touch.json')
    fs.writeFileSync(target, 'preserved')
    const symlinkDestination = path.join(canonical, exported.filename)
    expect(() => fs.symlinkSync(target, symlinkDestination)).toThrow()
    fs.unlinkSync(destination)
    fs.symlinkSync(target, symlinkDestination)
    expect(() => writeSupportCaseExport(canonical, exported)).toThrow()
    expect(fs.readFileSync(target, 'utf8')).toBe('preserved')

    fs.unlinkSync(symlinkDestination)
    const originalWrite = fs.writeFileSync.bind(fs)
    const writer = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(((descriptor, bytes) => {
      expect(typeof descriptor).toBe('number')
      fs.unlinkSync(symlinkDestination)
      originalWrite(symlinkDestination, 'replacement')
      throw new Error(`simulated write failure after ${Buffer.byteLength(bytes as Uint8Array)} bytes`)
    }) as typeof fs.writeFileSync)
    expect(() => writeSupportCaseExport(canonical, exported)).toThrow('simulated write failure')
    writer.mockRestore()
    expect(fs.readFileSync(symlinkDestination, 'utf8')).toBe('replacement')
  })

  it('fails closed for absent consent, digest drift, unsafe content, schema drift, and exclusion drift', async () => {
    const source = await diagnostics()
    expect(() => createSupportCaseExport({
      request: { ...request, consent: undefined } as never,
      diagnostics: source,
      nowMs,
    })).toThrow('consent is required')
    expect(() => verifyOperationsDiagnosticsArtifact({ ...source, sha256: 'c'.repeat(64) }, nowMs))
      .toThrow('digest does not match')

    const unsafeText = rewrite(source, (payload) => {
      const log = (payload.recent_logs as Array<Record<string, unknown>>)[0]!
      ;(log.attributes as Record<string, unknown>).safe_label = 'authorization=Bearer leaked-value'
    })
    expect(() => verifyOperationsDiagnosticsArtifact(unsafeText, nowMs)).toThrow('unsafe text')

    const unsafeWithheldKey = rewrite(source, (payload) => {
      const log = (payload.recent_logs as Array<Record<string, unknown>>)[0]!
      ;(log.attributes as Record<string, unknown>).workspace_path = '/Users/operator/project'
    })
    expect(() => verifyOperationsDiagnosticsArtifact(unsafeWithheldKey, nowMs)).toThrow('withheld value')

    const unknownRoot = rewrite(source, (payload) => { payload.unreviewed = true })
    expect(() => verifyOperationsDiagnosticsArtifact(unknownRoot, nowMs)).toThrow('schema or exclusion')

    const exclusionDrift = rewrite(source, (payload) => {
      payload.exclusions = (payload.exclusions as string[]).slice(1)
    })
    expect(() => verifyOperationsDiagnosticsArtifact(exclusionDrift, nowMs)).toThrow('schema or exclusion')
  })

  it('rejects absolute, home, relative, Windows, and UNC paths despite misleading claims', async () => {
    const source = await diagnostics()
    for (const retainedPath of [
      '/root/operator/private-project/.ssh/id_rsa',
      '~/private-project/.env',
      './private-project/.env',
      '../private-project/.env',
      'private-project/.ssh/id_ed25519',
      'C:\\Users\\operator\\private-project\\.env',
      '\\\\server\\share\\private-project\\.env',
      'id_rsa',
    ]) {
      const unsafe = rewrite(source, (payload) => {
        const log = (payload.recent_logs as Array<Record<string, unknown>>)[0]!
        ;(log.attributes as Record<string, unknown>).safe_label = retainedPath
      })
      expect(() => verifyOperationsDiagnosticsArtifact({
        ...unsafe,
        redactions: 999,
        verified: true,
        redaction_verified: true,
        secret_findings: 0,
      } as never, nowMs), retainedPath).toThrow('unsafe text')
    }
  })

  it('enforces every versioned nested container and rejects unknown or mistyped fields', async () => {
    const source = await diagnostics()
    const mutations: Array<(payload: Record<string, unknown>) => void> = [
      (payload) => { (payload.generator as Record<string, unknown>).unreviewed = true },
      (payload) => { (payload.runtime as Record<string, unknown>).unreviewed = true },
      (payload) => { (payload.health as Record<string, unknown>).unreviewed = true },
      (payload) => {
        const component = ((payload.health as Record<string, unknown>).components as Array<Record<string, unknown>>)[0]!
        component.unreviewed = true
      },
      (payload) => { (payload.metrics as Array<Record<string, unknown>>)[0]!.unreviewed = true },
      (payload) => { (payload.recent_logs as Array<Record<string, unknown>>)[0]!.unreviewed = true },
      (payload) => { (payload.configuration as Record<string, unknown>).unreviewed_nested_field = true },
      (payload) => { (payload.runtime as Record<string, unknown>).uptime_seconds = '3' },
      (payload) => { (payload.metrics as Array<Record<string, unknown>>)[0]!.value = '1' },
      (payload) => { (payload.configuration as Record<string, unknown>).max_active_sessions = '3' },
      (payload) => {
        const component = ((payload.health as Record<string, unknown>).components as Array<Record<string, unknown>>)[0]!
        component.details = null
      },
      (payload) => { (payload.recent_logs as Array<Record<string, unknown>>)[0]!.attributes = [] },
    ]
    for (const mutate of mutations) {
      expect(() => verifyOperationsDiagnosticsArtifact(rewrite(source, mutate), nowMs))
        .toThrow('schema or exclusion')
    }
  })

  it('rejects malformed and decompression-amplified artifacts before parsing', async () => {
    const source = await diagnostics()
    const malformed = Buffer.from('not gzip')
    expect(() => verifyOperationsDiagnosticsArtifact({
      ...source,
      bytes: malformed,
      sha256: createHash('sha256').update(malformed).digest('hex'),
    }, nowMs)).toThrow('bounded gzip')

    const amplified = gzipSync(Buffer.alloc(17 * 1024 * 1024, 0x61), { level: 9 })
    expect(() => verifyOperationsDiagnosticsArtifact({
      ...source,
      bytes: amplified,
      sha256: createHash('sha256').update(amplified).digest('hex'),
    }, nowMs)).toThrow('bounded gzip')

    const decoded = gunzipSync(source.bytes).toString('utf8')
    const nonCanonical = gzipSync(Buffer.from(decoded.trim()))
    expect(() => verifyOperationsDiagnosticsArtifact({
      ...source,
      bytes: nonCanonical,
      sha256: createHash('sha256').update(nonCanonical).digest('hex'),
    }, nowMs)).toThrow('canonical generator JSON')
  })
})
