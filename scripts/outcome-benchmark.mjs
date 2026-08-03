#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA = /^[a-f0-9]{40}$/u
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const OUTCOME_KEYS = new Set([
  'accepted', 'accepted_deliveries', 'quality_milli', 'provider_tokens',
  'context_tokens', 'duration_ms', 'repeated_exploration_steps',
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

const integer = (value, label, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

const identifier = (value, label) => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

const text = (value, label, maximum = 10_000) => {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1
    || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

export function validateBenchmarkOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('benchmark outcome must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!OUTCOME_KEYS.has(key)) throw new Error(`benchmark outcome field is not allowed: ${key}`)
  }
  if (typeof value.accepted !== 'boolean') throw new Error('accepted must be boolean')
  return Object.freeze({
    accepted: value.accepted,
    accepted_deliveries: integer(value.accepted_deliveries, 'accepted deliveries', 1_000_000),
    quality_milli: integer(value.quality_milli, 'quality milli', 1_000),
    provider_tokens: integer(value.provider_tokens, 'provider tokens', 1_000_000_000),
    context_tokens: integer(value.context_tokens, 'context tokens', 1_000_000_000),
    duration_ms: integer(value.duration_ms, 'duration ms', 31_536_000_000),
    repeated_exploration_steps: integer(
      value.repeated_exploration_steps,
      'repeated exploration steps',
      1_000_000,
    ),
  })
}

export function evaluateBenchmarkPair(beforeValue, afterValue) {
  const before = validateBenchmarkOutcome(beforeValue)
  const after = validateBenchmarkOutcome(afterValue)
  const beforeTokens = before.provider_tokens + before.context_tokens
  const afterTokens = after.provider_tokens + after.context_tokens
  const beforeRate = before.accepted_deliveries > 0
    ? beforeTokens / before.accepted_deliveries : null
  const afterRate = after.accepted_deliveries > 0
    ? afterTokens / after.accepted_deliveries : null
  const qualityPreserved = after.accepted
    && after.accepted_deliveries >= before.accepted_deliveries
    && after.quality_milli >= before.quality_milli
  const efficiencyImproved = beforeRate !== null && afterRate !== null && afterRate < beforeRate
  return Object.freeze({
    passed: qualityPreserved && efficiencyImproved,
    quality_preserved: qualityPreserved,
    token_efficiency_improved: efficiencyImproved,
    before_tokens_per_accepted_delivery: beforeRate,
    after_tokens_per_accepted_delivery: afterRate,
    token_delta_per_accepted_delivery: beforeRate === null || afterRate === null
      ? null : afterRate - beforeRate,
  })
}

export function validateBenchmarkManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1) {
    throw new Error('benchmark manifest schema version must be 1')
  }
  const sourceCommit = text(value.source_commit, 'source commit', 40)
  if (!SHA.test(sourceCommit)) throw new Error('source commit must be a full lowercase SHA')
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 1 || value.scenarios.length > 100) {
    throw new Error('benchmark manifest must contain 1 to 100 scenarios')
  }
  const scenarioIds = new Set()
  const scenarios = value.scenarios.map((scenario, index) => {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      throw new Error(`scenario ${index} must be an object`)
    }
    const scenarioKey = identifier(scenario.scenario_key, `scenario ${index} key`)
    if (scenarioIds.has(scenarioKey)) throw new Error(`duplicate scenario key: ${scenarioKey}`)
    scenarioIds.add(scenarioKey)
    if (!Array.isArray(scenario.command) || scenario.command.length < 1 || scenario.command.length > 128) {
      throw new Error(`scenario ${scenarioKey} command is invalid`)
    }
    const command = scenario.command.map((argument, argumentIndex) =>
      text(argument, `scenario ${scenarioKey} command argument ${argumentIndex}`, 8_192))
    return Object.freeze({
      scenario_key: scenarioKey,
      objective: text(scenario.objective, `scenario ${scenarioKey} objective`),
      acceptance_criteria: Array.isArray(scenario.acceptance_criteria)
        && scenario.acceptance_criteria.length > 0 && scenario.acceptance_criteria.length <= 64
        ? scenario.acceptance_criteria.map((criterion) => text(
          criterion,
          `scenario ${scenarioKey} acceptance criterion`,
          4_000,
        ))
        : (() => { throw new Error(`scenario ${scenarioKey} acceptance criteria are invalid`) })(),
      provider: identifier(scenario.provider, `scenario ${scenarioKey} provider`),
      model: text(scenario.model, `scenario ${scenarioKey} model`, 256),
      seed: text(scenario.seed, `scenario ${scenarioKey} seed`, 256),
      command,
      cwd: scenario.cwd === undefined ? '.' : text(scenario.cwd, `scenario ${scenarioKey} cwd`, 4_096),
      timeout_ms: integer(scenario.timeout_ms ?? 30 * 60_000, `scenario ${scenarioKey} timeout`, 86_400_000),
    })
  })
  return Object.freeze({
    schema_version: 1,
    suite_key: identifier(value.suite_key, 'suite key'),
    source_commit: sourceCommit,
    scenarios,
  })
}

const exactHead = (cwd) => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('unable to resolve benchmark source commit')
  return String(result.stdout).trim().toLowerCase()
}

const runVariant = (scenario, variant, repositoryRoot) => {
  const temporary = mkdtempSync(join(tmpdir(), 'orchestra-outcome-benchmark-'))
  const resultPath = join(temporary, 'outcome.json')
  try {
    const cwd = isAbsolute(scenario.cwd) ? scenario.cwd : resolve(repositoryRoot, scenario.cwd)
    const result = spawnSync(scenario.command[0], scenario.command.slice(1), {
      cwd,
      env: {
        ...process.env,
        ORCHESTRA_OUTCOME_BENCHMARK_RESULT: resultPath,
        ORCHESTRA_OUTCOME_BENCHMARK_VARIANT: variant,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: scenario.timeout_ms,
      shell: false,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`${scenario.scenario_key} ${variant} command failed with exit ${result.status}`)
    }
    const raw = readFileSync(resultPath, 'utf8')
    return {
      outcome: validateBenchmarkOutcome(JSON.parse(raw)),
      evidence_sha256: sha256(raw),
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function runOutcomeBenchmark(manifestValue, options = {}) {
  const manifest = validateBenchmarkManifest(manifestValue)
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd())
  const observedCommit = exactHead(repositoryRoot)
  if (observedCommit !== manifest.source_commit) {
    throw new Error(`benchmark source mismatch: expected ${manifest.source_commit}, observed ${observedCommit}`)
  }
  const runner = options.runVariant ?? runVariant
  const scenarios = manifest.scenarios.map((scenario) => {
    const before = runner(scenario, 'before', repositoryRoot)
    const after = runner(scenario, 'after', repositoryRoot)
    return Object.freeze({
      scenario_key: scenario.scenario_key,
      objective: scenario.objective,
      acceptance_criteria: scenario.acceptance_criteria,
      provider: scenario.provider,
      model: scenario.model,
      seed: scenario.seed,
      before,
      after,
      comparison: evaluateBenchmarkPair(before.outcome, after.outcome),
    })
  })
  const report = {
    schema_version: 1,
    suite_key: manifest.suite_key,
    source_commit: manifest.source_commit,
    scenario_count: scenarios.length,
    passed: scenarios.every((scenario) => scenario.comparison.passed),
    representative_evidence_observed: false,
    gate_claimed: false,
    scenarios,
  }
  return Object.freeze({ ...report, report_sha256: sha256(canonical(report)) })
}

const writeJsonAtomic = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const manifestPath = process.argv[2]
    const outputPath = process.argv[3]
    if (!manifestPath || !outputPath) {
      throw new Error('usage: outcome-benchmark.mjs <manifest.json> <report.json>')
    }
    const report = runOutcomeBenchmark(JSON.parse(readFileSync(manifestPath, 'utf8')), {
      repositoryRoot: process.cwd(),
    })
    writeJsonAtomic(resolve(outputPath), report)
    console.log(`outcome benchmark ${report.passed ? 'passed' : 'failed'}: ${report.report_sha256}`)
    process.exitCode = report.passed ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
