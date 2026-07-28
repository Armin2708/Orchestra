#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { cpus, homedir, platform, arch, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

export const BASELINE_SCHEMA_VERSION = 1
const shaPattern = /^[0-9a-f]{40}$/
const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(scriptPath), '..')
const sensitiveEnvironmentPattern =
  /(?:API_KEY|AUTH|BEARER|CREDENTIAL|PASSWORD|SECRET|SESSION|TOKEN)$/i

const round = (value, digits = 3) => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('percentile requires at least one sample')
  }
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error('percentile fraction must be between 0 and 1')
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  return sorted[index]
}

export function summarizeSamples(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('sample summary requires at least one value')
  }
  return {
    samples: values.length,
    min: round(Math.min(...values)),
    mean: round(values.reduce((total, value) => total + value, 0) / values.length),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values)),
  }
}

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const positive = (value) => Number.isFinite(value) && value > 0

export function validateBaseline(value) {
  const errors = []
  if (!object(value)) return ['baseline must be an object']
  if (value.schema_version !== BASELINE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${BASELINE_SCHEMA_VERSION}`)
  }
  if (value.backlog_item !== 'BASE-008') errors.push('backlog_item must be BASE-008')
  if (value.status !== 'observed') errors.push('status must be observed')
  if (!shaPattern.test(value.source?.commit ?? '')) {
    errors.push('source.commit must be a full Git SHA')
  }
  if (!shaPattern.test(value.source?.tree ?? '')) {
    errors.push('source.tree must be a full Git tree SHA')
  }
  if (value.source?.tracked_clean_before_capture !== true) {
    errors.push('source tree was not clean before capture')
  }
  if (value.source?.environment_files_present?.length !== 0) {
    errors.push('project environment files must be absent for this baseline')
  }

  for (const mode of ['default_parallel', 'serial']) {
    const result = value.tests?.[mode]
    if (!result?.passed || result.exit_code !== 0) {
      errors.push(`${mode} tests did not pass`)
      continue
    }
    if (!positive(result.test_files) || result.failed_test_files !== 0) {
      errors.push(`${mode} test-file counts are invalid`)
    }
    if (!positive(result.tests) || result.failed_tests !== 0) {
      errors.push(`${mode} test counts are invalid`)
    }
    if (!positive(result.wall_ms)) errors.push(`${mode} wall time is invalid`)
  }

  for (const name of [
    'root_typecheck',
    'root_production',
    'web_typecheck',
    'web_production',
  ]) {
    const result = value.builds?.[name]
    if (!result?.passed || result.exit_code !== 0 || !positive(result.wall_ms)) {
      errors.push(`${name} build evidence is invalid`)
    }
  }
  for (const name of ['root_production', 'web_production']) {
    const output = value.builds?.[name]?.output
    if (!positive(output?.files) || !positive(output?.bytes)) {
      errors.push(`${name} output summary is empty`)
    }
    if (!/^[0-9a-f]{64}$/.test(output?.sha256 ?? '')) {
      errors.push(`${name} output digest is invalid`)
    }
  }

  if (
    value.package?.passed !== true
    || value.package?.exit_code !== 0
    || value.package?.install_smoke?.passed !== true
  ) {
    errors.push('package smoke did not pass')
  }
  if (
    !positive(value.package?.bytes)
    || !positive(value.package?.unpacked_bytes)
    || !positive(value.package?.file_count)
    || !/^[0-9a-f]{64}$/.test(value.package?.sha256 ?? '')
  ) {
    errors.push('package measurements are invalid')
  }

  const runtime = value.runtime
  if (runtime?.mode !== 'credential_free_loopback') {
    errors.push('runtime mode must be credential_free_loopback')
  }
  if (!Array.isArray(runtime?.runs) || runtime.runs.length < 3) {
    errors.push('runtime requires at least three cold-start runs')
  } else {
    for (const [index, run] of runtime.runs.entries()) {
      if (
        !positive(run.startup_ms)
        || !positive(run.ready_rss_bytes)
        || !positive(run.ready_virtual_bytes)
        || run.health_requests < 50
        || run.health_failures !== 0
        || run.health_latency_ms?.samples !== run.health_requests
        || run.graceful_shutdown !== true
      ) {
        errors.push(`runtime run ${index + 1} is incomplete`)
      }
    }
  }
  if (
    !positive(runtime?.startup_ms?.p50)
    || !positive(runtime?.ready_rss_bytes?.p50)
    || !positive(runtime?.health_latency_ms?.p50)
  ) {
    errors.push('runtime summaries are invalid')
  }
  const totalHealthRequests = Array.isArray(runtime?.runs)
    ? runtime.runs.reduce((total, run) => total + (run.health_requests ?? 0), 0)
    : 0
  if (
    runtime?.health_latency_ms?.requests !== totalHealthRequests
    || runtime?.health_latency_ms?.samples !== totalHealthRequests
    || runtime?.health_latency_ms?.aggregation !== 'all sequential loopback request samples'
  ) {
    errors.push('runtime health latency aggregation is incomplete')
  }

  const tokens = value.token_usage
  if (tokens?.method !== 'deterministic_injected_context_estimate') {
    errors.push('token method is invalid')
  }
  if (
    !positive(tokens?.verbose?.tokens)
    || !positive(tokens?.compact?.tokens)
    || tokens.compact.tokens >= tokens.verbose.tokens
    || !positive(tokens?.reduction_pct)
  ) {
    errors.push('token totals do not prove a reduction')
  }
  if (
    !positive(tokens?.compliance?.total)
    || tokens.compliance.passed !== tokens.compliance.total
  ) {
    errors.push('token compliance is incomplete')
  }
  if (!tokens?.provider_native_completion_tokens?.excluded_reason) {
    errors.push('provider-native token exclusion must be explicit')
  }
  return errors
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const git = async (args, options = {}) => {
  const result = await runCommand('git', args, {
    cwd: repositoryRoot,
    env: options.env ?? safeEnvironment(options.tempRoot),
    label: `git ${args.join(' ')}`,
  })
  if (result.exit_code !== 0) throw new Error(`${result.label} failed`)
  return result.stdout.trim()
}

const safeEnvironment = (tempRoot) => {
  const allowed = [
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TMP',
    'TEMP',
  ]
  const environment = Object.fromEntries(
    allowed
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
  for (const [name] of Object.entries(process.env)) {
    if (sensitiveEnvironmentPattern.test(name)) continue
    if (name.startsWith('LC_') && environment[name] === undefined) {
      environment[name] = process.env[name]
    }
  }
  return {
    ...environment,
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    ...(tempRoot ? {
      npm_config_cache: join(tempRoot, 'npm-cache'),
      npm_config_userconfig: join(tempRoot, 'empty-npmrc'),
    } : {}),
  }
}

const boundedAppend = (chunks, chunk) => {
  chunks.push(Buffer.from(chunk))
  let bytes = chunks.reduce((total, entry) => total + entry.byteLength, 0)
  while (bytes > 32 * 1024 * 1024 && chunks.length > 1) {
    bytes -= chunks.shift().byteLength
  }
}

async function runCommand(command, args, {
  cwd = repositoryRoot,
  env = safeEnvironment(),
  label = [command, ...args].join(' '),
} = {}) {
  console.error(`[baseline] ${label}`)
  const started = performance.now()
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => boundedAppend(stdout, chunk))
  child.stderr.on('data', (chunk) => boundedAppend(stderr, chunk))
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveResult({ code, signal }))
  })
  return {
    label,
    exit_code: result.code ?? (result.signal ? 1 : 0),
    signal: result.signal,
    wall_ms: round(performance.now() - started),
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

const requirePassed = (result) => {
  if (result.exit_code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`
      .replaceAll(repositoryRoot, '<repository>')
      .replaceAll(homedir(), '<home>')
      .slice(-2_000)
    throw new Error(`${result.label} failed with exit ${result.exit_code}\n${detail}`)
  }
  return result
}

const parseLastJsonArray = (text) => {
  const start = Math.max(text.lastIndexOf('\n['), text.startsWith('[') ? 0 : -1)
  if (start < 0) throw new Error('command did not produce a JSON array')
  return JSON.parse(text.slice(start === 0 ? 0 : start + 1))
}

export const directorySummary = (directory) => {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (entry.isFile()) {
        const bytes = readFileSync(absolute)
        files.push({
          path: relative(directory, absolute).split(sep).join('/'),
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        })
      }
    }
  }
  walk(directory)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: sha256(JSON.stringify(files)),
  }
}

const testResult = async (name, extraArgs, reportPath, env) => {
  const result = requirePassed(await runCommand(
    'npm',
    [
      'test',
      '--',
      ...extraArgs,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    { env, label: `tests:${name}` },
  ))
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (report.success !== true) throw new Error(`${name} Vitest report was not successful`)
  return {
    command: name === 'serial'
      ? 'npm test -- --maxWorkers=1'
      : 'npm test',
    passed: true,
    exit_code: result.exit_code,
    wall_ms: result.wall_ms,
    test_files: report.numTotalTestSuites,
    passed_test_files: report.numPassedTestSuites,
    failed_test_files: report.numFailedTestSuites,
    tests: report.numTotalTests,
    passed_tests: report.numPassedTests,
    failed_tests: report.numFailedTests,
    pending_tests: report.numPendingTests,
    todo_tests: report.numTodoTests,
  }
}

const buildResult = async (
  name,
  command,
  args,
  env,
  outputDirectory,
  cwd = repositoryRoot,
) => {
  const result = requirePassed(await runCommand(command, args, {
    cwd,
    env,
    label: `build:${name}`,
  }))
  return {
    command: `${cwd === repositoryRoot ? '' : 'cd web && '}${[command, ...args].join(' ')}`,
    passed: true,
    exit_code: result.exit_code,
    wall_ms: result.wall_ms,
    ...(outputDirectory ? { output: directorySummary(outputDirectory) } : {}),
  }
}

const unusedPort = () => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.unref()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const selected = typeof address === 'object' && address ? address.port : 0
    server.close((error) => error ? reject(error) : resolvePort(selected))
  })
})

const waitForExit = (child, timeoutMs) => new Promise((resolveExit) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolveExit({ code: child.exitCode, signal: child.signalCode, timed_out: false })
    return
  }
  let timer
  const done = (code, signal, timedOut) => {
    clearTimeout(timer)
    resolveExit({ code, signal, timed_out: timedOut })
  }
  child.once('close', (code, signal) => done(code, signal, false))
  timer = setTimeout(() => done(child.exitCode, child.signalCode, true), timeoutMs)
})

const processMemory = async (pid, env) => {
  const result = requirePassed(await runCommand(
    '/bin/ps',
    ['-o', 'rss=', '-o', 'vsz=', '-p', String(pid)],
    { env, label: 'runtime:process-memory' },
  ))
  const [rssKb, virtualKb] = result.stdout.trim().split(/\s+/).map(Number)
  if (!positive(rssKb) || !positive(virtualKb)) {
    throw new Error('ps returned invalid process memory')
  }
  return {
    rss_bytes: rssKb * 1024,
    virtual_bytes: virtualKb * 1024,
  }
}

const oneRuntimeRun = async (index, env, tempRoot) => {
  const runtimeHome = mkdtempSync(join(tempRoot, `runtime-${index}-`))
  const selectedPort = await unusedPort()
  const runtimeEnv = {
    ...env,
    ORCHESTRA_AUTOSHIP: '0',
    ORCHESTRA_AUTOWAKE: '0',
    ORCHESTRA_CODEX_COMMAND: join(runtimeHome, 'intentionally-missing-codex'),
    ORCHESTRA_CODEX_PROVIDER_CONTRACT: '0',
    ORCHESTRA_HOME: runtimeHome,
    ORCHESTRA_NO_AUTH: '1',
    ORCHESTRA_PORT: String(selectedPort),
  }
  const stdout = []
  const stderr = []
  const started = performance.now()
  const child = spawn(process.execPath, [join(repositoryRoot, 'dist', 'cli.js'), 'serve'], {
    cwd: repositoryRoot,
    env: runtimeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => boundedAppend(stdout, chunk))
  child.stderr.on('data', (chunk) => boundedAppend(stderr, chunk))
  let spawnError
  child.on('error', (error) => {
    spawnError = error
  })
  let startupMs
  let gracefulShutdown = false
  try {
    const deadline = performance.now() + 15_000
    while (performance.now() < deadline) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`daemon exited before health was ready`)
      }
      try {
        const response = await fetch(`http://127.0.0.1:${selectedPort}/health`, {
          signal: AbortSignal.timeout(500),
        })
        const body = await response.json()
        if (response.ok && body.ok === true) {
          startupMs = round(performance.now() - started)
          break
        }
      } catch {
        // Expected while the daemon is starting.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    if (!positive(startupMs)) {
      throw new Error('daemon health did not become ready within 15 seconds')
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    const latencySamples = []
    let healthFailures = 0
    for (let request = 0; request < 100; request += 1) {
      const requestStarted = performance.now()
      try {
        const response = await fetch(`http://127.0.0.1:${selectedPort}/health`, {
          signal: AbortSignal.timeout(1_000),
        })
        const body = await response.json()
        if (!response.ok || body.ok !== true) healthFailures += 1
      } catch {
        healthFailures += 1
      }
      latencySamples.push(performance.now() - requestStarted)
    }
    const memory = await processMemory(child.pid, runtimeEnv)
    child.kill('SIGTERM')
    let exit = await waitForExit(child, 5_000)
    if (exit.timed_out) {
      child.kill('SIGKILL')
      exit = await waitForExit(child, 2_000)
    }
    gracefulShutdown = !exit.timed_out
      && (exit.code === 0 || exit.signal === 'SIGTERM')
    return {
      run: index,
      startup_ms: startupMs,
      ready_rss_bytes: memory.rss_bytes,
      ready_virtual_bytes: memory.virtual_bytes,
      health_requests: latencySamples.length,
      health_failures: healthFailures,
      health_latency_ms: summarizeSamples(latencySamples),
      health_latency_samples_ms: latencySamples,
      graceful_shutdown: gracefulShutdown,
      exit_code: exit.code,
      exit_signal: exit.signal,
    }
  } catch (error) {
    child.kill('SIGTERM')
    let exit = await waitForExit(child, 2_000)
    if (exit.timed_out) {
      child.kill('SIGKILL')
      exit = await waitForExit(child, 2_000)
    }
    const detail = `${Buffer.concat(stderr)}\n${Buffer.concat(stdout)}`
      .replaceAll(repositoryRoot, '<repository>')
      .replaceAll(runtimeHome, '<runtime-home>')
      .replaceAll(homedir(), '<home>')
      .slice(-2_000)
    throw new Error(
      `credential-free runtime baseline ${index} failed: ${
        error instanceof Error ? error.message : String(error)
      }\n${detail}`,
    )
  } finally {
    if (!gracefulShutdown && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child, 2_000)
    }
    rmSync(runtimeHome, { recursive: true, force: true })
  }
}

export const aggregateRuntimeRuns = (observedRuns) => {
  const latencySamples = observedRuns.flatMap((run) => run.health_latency_samples_ms)
  const runs = observedRuns.map(({ health_latency_samples_ms: _samples, ...run }) => run)
  return {
    runs,
    startup_ms: summarizeSamples(runs.map((run) => run.startup_ms)),
    ready_rss_bytes: summarizeSamples(runs.map((run) => run.ready_rss_bytes)),
    ready_virtual_bytes: summarizeSamples(runs.map((run) => run.ready_virtual_bytes)),
    health_latency_ms: {
      ...summarizeSamples(latencySamples),
      requests: runs.reduce((total, run) => total + run.health_requests, 0),
      failures: runs.reduce((total, run) => total + run.health_failures, 0),
      aggregation: 'all sequential loopback request samples',
    },
  }
}

const runtimeBaseline = async (env, tempRoot) => {
  const observedRuns = []
  for (let index = 1; index <= 3; index += 1) {
    console.error(`[baseline] runtime:cold-start:${index}`)
    observedRuns.push(await oneRuntimeRun(index, env, tempRoot))
  }
  return {
    mode: 'credential_free_loopback',
    provider_state: 'Codex command intentionally unavailable; no provider login or turn executed',
    auth_state: 'ORCHESTRA_NO_AUTH=1 on loopback-only disposable homes',
    ...aggregateRuntimeRuns(observedRuns),
  }
}

const tokenBaseline = async (env, tempRoot) => {
  const reportPath = join(tempRoot, 'token-diet.json')
  const result = requirePassed(await runCommand(
    'npx',
    ['vitest', 'run', 'test/token-diet-ab.test.ts'],
    {
      env: { ...env, AB_REPORT: reportPath },
      label: 'tokens:deterministic-injected-context',
    },
  ))
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const compliance = Object.values(report.compact.compliance)
  return {
    method: 'deterministic_injected_context_estimate',
    command: 'npx vitest run test/token-diet-ab.test.ts',
    passed: true,
    exit_code: result.exit_code,
    wall_ms: result.wall_ms,
    estimator: 'ceil(characters / 4) per emitted hook payload',
    scenario: report.scenario,
    verbose: report.verbose.total,
    compact: report.compact.total,
    reduction_pct: report.reduction_pct,
    output_rules_cost: report.output_rules_cost,
    compliance: {
      passed: compliance.filter(Boolean).length,
      total: compliance.length,
    },
    provider_native_completion_tokens: {
      measured: false,
      excluded_reason:
        'A credential-free deterministic baseline cannot execute provider-native turns; ' +
        'real provider token evidence remains gated by TOOL-014 acceptance.',
    },
  }
}

const packageBaseline = async (sourceCommit, env, tempRoot) => {
  const evidenceDirectory = join(tempRoot, 'package-evidence')
  mkdirSync(evidenceDirectory, { recursive: true })
  const result = requirePassed(await runCommand(
    'node',
    ['scripts/package-install-smoke.mjs'],
    {
      env: {
        ...env,
        CI_EVIDENCE_DIR: evidenceDirectory,
        CI_EVIDENCE_SHA: sourceCommit,
      },
      label: 'package:pack-and-install-smoke',
    },
  ))
  const metadata = JSON.parse(readFileSync(
    join(evidenceDirectory, 'package', 'package-metadata.json'),
    'utf8',
  ))
  const dryRun = requirePassed(await runCommand(
    'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { env, label: 'package:dry-run-inventory' },
  ))
  const reports = parseLastJsonArray(dryRun.stdout)
  if (!Array.isArray(reports) || reports.length !== 1) {
    throw new Error('npm pack dry-run did not report exactly one package')
  }
  const report = reports[0]
  if (report.size !== metadata.bytes) {
    throw new Error('package dry-run bytes differ from installed smoke artifact')
  }
  return {
    command: 'node scripts/package-install-smoke.mjs',
    passed: true,
    exit_code: result.exit_code,
    wall_ms: result.wall_ms,
    name: metadata.package_name,
    version: metadata.package_version,
    filename: metadata.filename,
    bytes: metadata.bytes,
    unpacked_bytes: report.unpackedSize,
    file_count: Array.isArray(report.files) ? report.files.length : 0,
    sha256: metadata.sha256,
    npm_integrity: metadata.npm_integrity,
    npm_shasum: metadata.npm_shasum,
    required_files: metadata.required_files,
    install_smoke: metadata.install_smoke,
  }
}

const npmVersion = async (env) => {
  const result = requirePassed(await runCommand(
    'npm',
    ['--version'],
    { env, label: 'toolchain:npm-version' },
  ))
  return result.stdout.trim()
}

const parseArguments = (argv) => {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument ${argument}`)
    const key = argument.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    options[key] = value
    index += 1
  }
  return { command, options }
}

const capture = async ({ output, 'source-commit': sourceCommit }) => {
  if (!output || !isAbsolute(output)) {
    throw new Error('--output must be an absolute path')
  }
  if (!shaPattern.test(sourceCommit ?? '')) {
    throw new Error('--source-commit must be a full Git SHA')
  }
  const outputPath = resolve(output)
  if (existsSync(outputPath)) throw new Error(`output already exists: ${basename(outputPath)}`)
  const tempRoot = mkdtempSync(join(tmpdir(), 'agent-os-baseline-'))
  writeFileSync(join(tempRoot, 'empty-npmrc'), '', { mode: 0o600 })
  const env = safeEnvironment(tempRoot)
  try {
    const head = await git(['rev-parse', 'HEAD'], { env })
    if (head !== sourceCommit) throw new Error('source commit does not match HEAD')
    const trackedStatus = await git(
      ['status', '--porcelain', '--untracked-files=no'],
      { env },
    )
    if (trackedStatus !== '') throw new Error('tracked source tree must be clean before capture')
    const tree = await git(['rev-parse', 'HEAD^{tree}'], { env })
    const environmentFiles = ['.env', '.env.local', 'web/.env', 'web/.env.local']
      .filter((file) => existsSync(join(repositoryRoot, file)))
    if (environmentFiles.length) {
      throw new Error(`project environment files are present: ${environmentFiles.join(', ')}`)
    }
    const lockSha = sha256(readFileSync(join(repositoryRoot, 'package-lock.json')))
    const startedAt = new Date().toISOString()
    const tests = {
      default_parallel: await testResult(
        'default_parallel',
        [],
        join(tempRoot, 'vitest-default.json'),
        env,
      ),
      serial: await testResult(
        'serial',
        ['--maxWorkers=1'],
        join(tempRoot, 'vitest-serial.json'),
        env,
      ),
    }
    const builds = {
      root_typecheck: await buildResult(
        'root_typecheck',
        'npx',
        ['tsc', '--noEmit'],
        env,
      ),
      root_production: await buildResult(
        'root_production',
        'npm',
        ['run', 'build'],
        env,
        join(repositoryRoot, 'dist'),
      ),
      web_typecheck: await buildResult(
        'web_typecheck',
        'npx',
        ['tsc', '--noEmit'],
        env,
        undefined,
        join(repositoryRoot, 'web'),
      ),
      web_production: await buildResult(
        'web_production',
        'npm',
        ['run', 'build'],
        env,
        join(repositoryRoot, 'web', 'dist'),
        join(repositoryRoot, 'web'),
      ),
    }
    const beforePackageOutputs = {
      root: builds.root_production.output,
      web: builds.web_production.output,
    }
    const packageResult = await packageBaseline(sourceCommit, env, tempRoot)
    const afterPackageOutputs = {
      root: directorySummary(join(repositoryRoot, 'dist')),
      web: directorySummary(join(repositoryRoot, 'web', 'dist')),
    }
    if (JSON.stringify(beforePackageOutputs) !== JSON.stringify(afterPackageOutputs)) {
      throw new Error('package prepack changed production build output')
    }
    const runtime = await runtimeBaseline(env, tempRoot)
    const tokenUsage = await tokenBaseline(env, tempRoot)
    const endingHead = await git(['rev-parse', 'HEAD'], { env })
    const endingTrackedStatus = await git(
      ['status', '--porcelain', '--untracked-files=no'],
      { env },
    )
    if (endingHead !== sourceCommit || endingTrackedStatus !== '') {
      throw new Error('tracked source tree changed during capture')
    }
    const baseline = {
      schema_version: BASELINE_SCHEMA_VERSION,
      backlog_item: 'BASE-008',
      status: 'observed',
      captured_at: new Date().toISOString(),
      started_at: startedAt,
      source: {
        commit: sourceCommit,
        tree,
        tracked_clean_before_capture: true,
        package_lock_sha256: lockSha,
        environment_files_present: environmentFiles,
      },
      methodology: {
        scope: 'single-host local engineering baseline',
        thresholds: 'descriptive measurements, not release SLOs or performance budgets',
        isolation:
          'tracked clean tree, locked dependencies, empty npm user config, disposable daemon homes',
        startup_repetitions: 3,
        health_requests_per_run: 100,
      },
      host: {
        platform: platform(),
        architecture: arch(),
        os_release: release(),
        logical_cpus: cpus().length,
        total_memory_bytes: totalmem(),
        node_version: process.versions.node,
        npm_version: await npmVersion(env),
      },
      tests,
      builds,
      package: packageResult,
      runtime,
      token_usage: tokenUsage,
    }
    const errors = validateBaseline(baseline)
    if (errors.length) throw new Error(`captured baseline is invalid: ${errors.join('; ')}`)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, {
      mode: 0o644,
      flag: 'wx',
    })
    console.log(
      `BASE-008 baseline captured for ${sourceCommit.slice(0, 7)} at ${outputPath}`,
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

const validate = ({ input }) => {
  if (!input || !isAbsolute(input)) {
    throw new Error('--input must be an absolute path')
  }
  const baseline = JSON.parse(readFileSync(resolve(input), 'utf8'))
  const errors = validateBaseline(baseline)
  if (errors.length) throw new Error(errors.join('; '))
  console.log(
    `BASE-008 baseline is valid for ${baseline.source.commit.slice(0, 7)}: ` +
    `${baseline.tests.serial.test_files} files / ${baseline.tests.serial.tests} tests`,
  )
}

const main = async () => {
  const { command, options } = parseArguments(process.argv.slice(2))
  if (command === 'capture') {
    await capture(options)
    return
  }
  if (command === 'validate') {
    validate(options)
    return
  }
  throw new Error(
    'usage: capture-agent-os-baseline.mjs ' +
    'capture --output <absolute-path> --source-commit <full-sha> | ' +
    'validate --input <absolute-path>',
  )
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
