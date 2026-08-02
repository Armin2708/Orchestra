import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { OperationsHealthSnapshot } from './health.js'
import type { OperationsMetricSample } from './metrics.js'
import { redactOperationsValue } from './redaction.js'
import type { StructuredOperationsLog } from './structured-logger.js'

export interface OperationsDiagnosticsInput {
  generatedByVersion: string
  revision?: string
  health: OperationsHealthSnapshot
  metrics: ReadonlyArray<OperationsMetricSample>
  recentLogs: ReadonlyArray<StructuredOperationsLog>
  runtime: {
    nodeVersion: string
    platform: NodeJS.Platform
    arch: string
    uptimeSeconds: number
  }
  configuration?: Record<string, unknown>
}

export interface OperationsDiagnosticsArtifact {
  filename: string
  bytes: Buffer
  sha256: string
  redactions: number
}

export interface WrittenDiagnosticsArtifact {
  path: string
  sha256: string
  size: number
  redactions: number
}

/** Builds a gzip JSON artifact from an explicit allowlist; database dumps and env are unsupported. */
export class OperationsDiagnosticsBundle {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  create(input: OperationsDiagnosticsInput): OperationsDiagnosticsArtifact {
    if (!/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(input.generatedByVersion)) {
      throw new Error('invalid diagnostics generator version')
    }
    const createdAt = this.clock().toISOString()
    const safe = redactOperationsValue({
      schema_version: 1,
      created_at: createdAt,
      generator: {
        version: input.generatedByVersion,
        revision: safeRevision(input.revision),
      },
      runtime: {
        node_version: safeNodeVersion(input.runtime.nodeVersion),
        platform: input.runtime.platform,
        arch: safeArchitecture(input.runtime.arch),
        uptime_seconds: finiteNonNegative(input.runtime.uptimeSeconds),
      },
      health: input.health,
      metrics: input.metrics,
      recent_logs: input.recentLogs.slice(-500),
      configuration: input.configuration ?? {},
      exclusions: [
        'database', 'wal', 'shm', 'environment', 'credentials', 'transcripts', 'pty_output',
        'approval_parameters', 'workspaces', 'source', 'provider_raw_output',
      ],
    })
    const serialized = Buffer.from(`${JSON.stringify(safe.value, null, 2)}\n`)
    const bytes = gzipSync(serialized, { level: 9 })
    return Object.freeze({
      filename: `orchestra-diagnostics-${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}.json.gz`,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      redactions: safe.redactions,
    })
  }

  write(outputDirectory: string, artifact: OperationsDiagnosticsArtifact): WrittenDiagnosticsArtifact {
    const root = fs.realpathSync(outputDirectory)
    const filename = path.basename(artifact.filename)
    if (filename !== artifact.filename || !/^orchestra-diagnostics-[A-Za-z0-9-]+\.json\.gz$/.test(filename)) {
      throw new Error('unsafe diagnostics filename')
    }
    const destination = path.join(root, filename)
    const fd = fs.openSync(destination, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    try {
      fs.writeFileSync(fd, artifact.bytes)
      fs.fsyncSync(fd)
    } catch (error) {
      try { fs.rmSync(destination, { force: true }) } catch { /* best effort rollback */ }
      throw error
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(destination, 0o600)
    return Object.freeze({
      path: destination,
      sha256: artifact.sha256,
      size: artifact.bytes.byteLength,
      redactions: artifact.redactions,
    })
  }
}

function safeRevision(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{7,64}$/i.test(value) ? value : undefined
}

function safeNodeVersion(value: string): string {
  return /^v\d+\.\d+\.\d+$/.test(value) ? value : 'unknown'
}

function safeArchitecture(value: string): string {
  return /^[a-z0-9_-]{1,32}$/i.test(value) ? value : 'unknown'
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}
