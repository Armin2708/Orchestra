#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EVENT_TYPES = new Set([
  'install_succeeded', 'install_failed', 'provider_error', 'provider_recovered',
  'token_usage', 'migration_succeeded', 'migration_failed',
])
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const EVENT_KEYS = new Set([
  'id', 'type', 'occurred_at', 'provider', 'platform', 'incident_id', 'migration_id',
  'tokens', 'window_seconds',
])

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const identifier = (value, label) => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`)
  return value
}

const optionalIdentifier = (value, label) => value === undefined
  ? undefined : identifier(value, label)

const integer = (value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

export function validateMonitoringEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('monitoring event must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!EVENT_KEYS.has(key)) throw new Error(`monitoring event field is not allowed: ${key}`)
  }
  if (!EVENT_TYPES.has(value.type)) throw new Error('monitoring event type is invalid')
  const occurredAt = typeof value.occurred_at === 'string' ? value.occurred_at : ''
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
    throw new Error('monitoring event timestamp is invalid')
  }
  const event = {
    id: identifier(value.id, 'monitoring event id'),
    type: value.type,
    occurred_at: new Date(occurredAt).toISOString(),
    provider: optionalIdentifier(value.provider, 'provider'),
    platform: optionalIdentifier(value.platform, 'platform'),
    incident_id: optionalIdentifier(value.incident_id, 'incident id'),
    migration_id: optionalIdentifier(value.migration_id, 'migration id'),
    tokens: value.tokens === undefined ? undefined
      : integer(value.tokens, 'tokens', 0, 1_000_000_000),
    window_seconds: value.window_seconds === undefined ? undefined
      : integer(value.window_seconds, 'window seconds', 1, 86_400),
  }
  if ((event.type === 'provider_error' || event.type === 'provider_recovered')
    && (!event.provider || !event.incident_id)) {
    throw new Error('provider events require provider and incident id')
  }
  if ((event.type === 'migration_failed' || event.type === 'migration_succeeded')
    && !event.migration_id) throw new Error('migration events require migration id')
  if (event.type === 'token_usage' && (!event.provider
    || event.tokens === undefined || event.window_seconds === undefined)) {
    throw new Error('token usage requires provider, tokens, and window seconds')
  }
  return Object.freeze(event)
}

export function evaluateBetaMonitoring(eventsValue, thresholdsValue = {}) {
  if (!Array.isArray(eventsValue)) throw new Error('monitoring events must be an array')
  const thresholds = Object.freeze({
    max_install_failures: integer(thresholdsValue.max_install_failures ?? 0, 'install threshold'),
    max_migration_failures: integer(thresholdsValue.max_migration_failures ?? 0, 'migration threshold'),
    max_unresolved_provider_errors: integer(
      thresholdsValue.max_unresolved_provider_errors ?? 0,
      'provider error threshold',
    ),
    token_storm_per_minute: integer(
      thresholdsValue.token_storm_per_minute ?? 100_000,
      'token storm threshold',
      1,
    ),
  })
  const ids = new Set()
  const events = eventsValue.map((value) => {
    const event = validateMonitoringEvent(value)
    if (ids.has(event.id)) throw new Error(`duplicate monitoring event id: ${event.id}`)
    ids.add(event.id)
    return event
  }).sort((left, right) => left.occurred_at.localeCompare(right.occurred_at)
    || left.id.localeCompare(right.id))
  const incidents = new Map()
  let installsSucceeded = 0
  let installsFailed = 0
  let migrationsSucceeded = 0
  let migrationsFailed = 0
  const providerErrors = {}
  const providerRecoveries = {}
  const tokenStorms = []
  for (const event of events) {
    if (event.type === 'install_succeeded') installsSucceeded += 1
    if (event.type === 'install_failed') installsFailed += 1
    if (event.type === 'migration_succeeded') migrationsSucceeded += 1
    if (event.type === 'migration_failed') migrationsFailed += 1
    if (event.type === 'provider_error') {
      incidents.set(`${event.provider}:${event.incident_id}`, false)
      providerErrors[event.provider] = (providerErrors[event.provider] ?? 0) + 1
    }
    if (event.type === 'provider_recovered') {
      const key = `${event.provider}:${event.incident_id}`
      if (!incidents.has(key)) throw new Error(`provider recovery has no observed error: ${key}`)
      incidents.set(key, true)
      providerRecoveries[event.provider] = (providerRecoveries[event.provider] ?? 0) + 1
    }
    if (event.type === 'token_usage') {
      const tokensPerMinute = event.tokens * 60 / event.window_seconds
      if (tokensPerMinute >= thresholds.token_storm_per_minute) {
        tokenStorms.push({
          event_id: event.id,
          provider: event.provider,
          tokens_per_minute: tokensPerMinute,
        })
      }
    }
  }
  const unresolvedProviderErrors = [...incidents.values()].filter((recovered) => !recovered).length
  const alerts = [
    ...(installsFailed > thresholds.max_install_failures ? [{ type: 'install_failures', count: installsFailed }] : []),
    ...(migrationsFailed > thresholds.max_migration_failures ? [{ type: 'migration_failures', count: migrationsFailed }] : []),
    ...(unresolvedProviderErrors > thresholds.max_unresolved_provider_errors
      ? [{ type: 'unresolved_provider_errors', count: unresolvedProviderErrors }] : []),
    ...tokenStorms.map((storm) => ({ type: 'token_storm', ...storm })),
  ]
  const report = {
    schema_version: 1,
    event_count: events.length,
    window_start: events[0]?.occurred_at ?? null,
    window_end: events.at(-1)?.occurred_at ?? null,
    thresholds,
    counts: {
      installs_succeeded: installsSucceeded,
      installs_failed: installsFailed,
      migrations_succeeded: migrationsSucceeded,
      migrations_failed: migrationsFailed,
      provider_errors: providerErrors,
      provider_recoveries: providerRecoveries,
      unresolved_provider_errors: unresolvedProviderErrors,
      token_storms: tokenStorms.length,
    },
    passed: events.length > 0 && alerts.length === 0,
    gate_claimed: false,
    alerts,
  }
  return Object.freeze({ ...report, report_sha256: sha256(canonical(report)) })
}

const writeJsonAtomic = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const inputPath = process.argv[2]
    const outputPath = process.argv[3]
    if (!inputPath || !outputPath) {
      throw new Error('usage: beta-release-monitor.mjs <events.ndjson> <report.json>')
    }
    const lines = readFileSync(inputPath, 'utf8').split(/\r?\n/u).filter((line) => line.trim())
    const report = evaluateBetaMonitoring(lines.map((line) => JSON.parse(line)))
    writeJsonAtomic(resolve(outputPath), report)
    console.log(`beta monitoring ${report.passed ? 'passed' : 'failed'}: ${report.report_sha256}`)
    process.exitCode = report.passed ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
