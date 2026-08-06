import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import {
  compareExecutableSemver,
  parseExecutableSemver,
  pickNewestExecutable,
} from './provider-executable-version.js'
import {
  ENVIRONMENT_COMPATIBILITY_CONTRACT,
  runEnvironmentDoctor,
  type CompatibilityCheck,
  type CompatibilityStatus,
  type DoctorProvider,
  type EnvironmentDoctorReport,
} from './environment-compatibility.js'

const COMMAND_TIMEOUT_MS = 3_000
const COMMAND_MAX_BUFFER_BYTES = 16 * 1024
const COMMAND_PARSE_LIMIT = 4_096
const PINNED_CODEX_VERSION =
  ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.codex.managed.validated_versions[0]
const PINNED_CLAUDE_CLI_VERSION = Object.values(
  ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.claude.managed.bundled_cli_by_sdk,
)[0]

export type DoctorRemediation = {
  summary: string
  commands: string[]
  docs: string
}

export type DoctorExecutableIdentity = {
  source: 'process' | 'path' | 'environment_override' | 'sdk_bundled'
  display: string
  path_fingerprint: string | null
}

export type ReadinessCheck = {
  id: 'git' | 'codex_login' | 'claude_login'
  label: string
  required: true
  status: CompatibilityStatus
  actual: string | null
  expected: string
  detail: string
  executable: DoctorExecutableIdentity
  remediation?: DoctorRemediation
}

export type OperatorDoctorCheck = (
  CompatibilityCheck & {
    executable?: DoctorExecutableIdentity
    remediation?: DoctorRemediation
  }
) | ReadinessCheck

export type OperatorDoctorReport = {
  schema_version: 2
  contract_schema_version: number
  compatibility_schema_version: EnvironmentDoctorReport['schema_version']
  checked_at: string
  provider: DoctorProvider
  mode: 'readiness'
  fail_closed: true
  ready: boolean
  status: CompatibilityStatus
  compatibility_ready: boolean
  compatibility_status: CompatibilityStatus
  checks: OperatorDoctorCheck[]
}

export type DoctorCommandOutcome = {
  exitCode: number | null
  stdout: string
  failure: 'missing' | 'timeout' | 'overflow' | 'failed' | null
}

export type OperatorDoctorDeps = {
  runCompatibilityDoctor?: (
    provider: DoctorProvider,
    env: NodeJS.ProcessEnv,
  ) => EnvironmentDoctorReport
  runCommand?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => DoctorCommandOutcome
  resolveClaudeBundledCommand?: () => string | null
}

type Semver = readonly [major: number, minor: number, patch: number]

const parseSemver = (
  value: string | null | undefined,
): { value: string; tuple: Semver } | null => {
  const match = value?.match(/(?:^|[^0-9])v?(\d+)\.(\d+)(?:\.(\d+))?(?=$|\s|\))/)
  if (!match) return null
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] as const
  if (tuple.some((part) => !Number.isSafeInteger(part))) return null
  return { value: tuple.join('.'), tuple }
}

const compareSemver = (left: Semver, right: Semver): number => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

const safeFailure = (code: string | undefined): DoctorCommandOutcome['failure'] => {
  if (code === 'ENOENT') return 'missing'
  if (code === 'ETIMEDOUT') return 'timeout'
  if (code === 'ENOBUFS') return 'overflow'
  return 'failed'
}

export const runBoundedDoctorCommand = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DoctorCommandOutcome => {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env,
    input: undefined,
    killSignal: 'SIGKILL',
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  })
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  return {
    exitCode: result.status,
    stdout: typeof result.stdout === 'string'
      ? result.stdout.slice(0, COMMAND_PARSE_LIMIT)
      : '',
    failure: result.error ? safeFailure(errorCode) : null,
  }
}

const executableCandidates = (
  command: string,
  env: NodeJS.ProcessEnv,
): string[] => {
  if (isAbsolute(command)) return [command]
  if (command.includes('/') || command.includes('\\')) return [resolve(command)]
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((entry) => extensions.map((extension) =>
      join(entry, `${command}${extension}`)))
}

const resolvedExecutablePath = (
  command: string,
  env: NodeJS.ProcessEnv,
): string | null => {
  for (const candidate of executableCandidates(command, env)) {
    try {
      accessSync(candidate, constants.X_OK)
      return resolve(candidate)
    } catch {}
  }
  return null
}

const executableIdentity = (
  command: string,
  source: DoctorExecutableIdentity['source'],
  env: NodeJS.ProcessEnv,
  label: 'node' | 'npm' | 'git' | 'codex' | 'claude',
): DoctorExecutableIdentity => {
  const resolvedPath = resolvedExecutablePath(command, env)
  const sourceLabel = source === 'process'
    ? 'process'
    : source === 'path'
      ? '$PATH'
      : source === 'environment_override'
        ? 'environment-override'
        : 'sdk-bundled'
  return {
    source,
    display: `<${sourceLabel}>/${label}`,
    path_fingerprint: resolvedPath
      ? `sha256:${createHash('sha256').update(resolvedPath).digest('hex').slice(0, 16)}`
      : null,
  }
}

const remediation = (
  summary: string,
  commands: readonly string[],
  docs = 'docs/supported-environments.md',
): DoctorRemediation => ({
  summary,
  commands: [...commands],
  docs,
})

const compatibilityRemediation = (
  check: CompatibilityCheck,
  env: NodeJS.ProcessEnv,
): DoctorRemediation | undefined => {
  if (!check.required || check.status === 'validated') return undefined
  switch (check.id) {
    case 'platform':
      return remediation(
        'Use one of the exact validated platform and toolchain profiles.',
        [],
      )
    case 'node':
      return remediation(
        'Install and select Node.js 22.20.0, then rerun Orchestra doctor.',
        ['nvm install 22.20.0', 'nvm use 22.20.0', 'node --version'],
      )
    case 'npm':
      return remediation(
        'Select npm 10.9.3 for the validated Node.js 22.20.0 toolchain.',
        ['npm install --global npm@10.9.3', 'npm --version'],
      )
    case 'toolchain':
      return remediation(
        'Use an observed whole platform, Node.js, and npm tuple.',
        ['node --version', 'npm --version'],
      )
    case 'codex_cli':
      return env.ORCHESTRA_CODEX_COMMAND?.trim()
        ? remediation(
          'Point ORCHESTRA_CODEX_COMMAND at the protocol-pinned Codex CLI before checking login state.',
          ['"$ORCHESTRA_CODEX_COMMAND" --version'],
          'docs/codex.md',
        )
        : remediation(
          'Install the protocol-pinned Codex CLI before checking login state.',
          [`npm install --global @openai/codex@${PINNED_CODEX_VERSION}`, 'codex --version'],
          'docs/codex.md',
        )
    case 'claude_sdk':
    case 'claude_native_package':
    case 'claude_bundled_cli':
      return remediation(
        'Reinstall Orchestra from the same verified distribution or source checkout. No automatic repair command is offered because the installation directory cannot be inferred safely.',
        [],
      )
    default:
      return undefined
  }
}

const identityForCompatibilityCheck = (
  check: CompatibilityCheck,
  env: NodeJS.ProcessEnv,
  codexCommand: string,
  claudeBundledCommand: string | null,
): DoctorExecutableIdentity | undefined => {
  switch (check.id) {
    case 'node':
      return executableIdentity(process.execPath, 'process', env, 'node')
    case 'npm':
      return executableIdentity('npm', 'path', env, 'npm')
    case 'codex_cli':
      return executableIdentity(
        codexCommand,
        env.ORCHESTRA_CODEX_COMMAND?.trim()
          ? 'environment_override'
          : 'path',
        env,
        'codex',
      )
    case 'claude_bundled_cli':
      return executableIdentity(
        claudeBundledCommand ?? 'claude',
        'sdk_bundled',
        env,
        'claude',
      )
    case 'claude_ambient_cli':
      return executableIdentity('claude', 'path', env, 'claude')
    default:
      return undefined
  }
}

const nativeClaudePackageName = (
  platform: string,
  arch: string,
  libc: string | null,
): string | null => {
  if (arch !== 'arm64' && arch !== 'x64') return null
  if (platform === 'darwin') return `@anthropic-ai/claude-agent-sdk-darwin-${arch}`
  if (platform === 'win32') return `@anthropic-ai/claude-agent-sdk-win32-${arch}`
  if (platform === 'linux') {
    if (libc !== 'glibc' && libc !== 'musl') return null
    return `@anthropic-ai/claude-agent-sdk-linux-${arch}${libc === 'musl' ? '-musl' : ''}`
  }
  return null
}

const runtimeLibc = (): string | null => {
  if (process.platform !== 'linux') return null
  try {
    const report = process.report?.getReport() as {
      header?: Record<string, unknown>
      sharedObjects?: unknown
    } | undefined
    if (typeof report?.header?.glibcVersionRuntime === 'string') return 'glibc'
    if (Array.isArray(report?.sharedObjects) && report.sharedObjects.some((entry) =>
      typeof entry === 'string' && entry.toLowerCase().includes('musl'))) return 'musl'
  } catch {}
  return null
}

export const resolveClaudeBundledCliCommand = (): string | null => {
  const packageName = nativeClaudePackageName(
    process.platform,
    process.arch,
    runtimeLibc(),
  )
  if (!packageName) return null
  try {
    const require = createRequire(import.meta.url)
    const packageJson = require.resolve(`${packageName}/package.json`)
    const descriptor = JSON.parse(readFileSync(packageJson, 'utf8')) as {
      name?: unknown
    }
    if (descriptor.name !== packageName) return null
    return join(dirname(packageJson), process.platform === 'win32' ? 'claude.exe' : 'claude')
  } catch {
    return null
  }
}

const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 3_000
const CLAUDE_VERSION_PROBE_BUFFER = 1 << 16

const readClaudeExecutableVersion = (
  executable: string,
  env: NodeJS.ProcessEnv,
): string | null => {
  const outcome = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env,
    timeout: CLAUDE_VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: CLAUDE_VERSION_PROBE_BUFFER,
  })
  if (outcome.status !== 0 || typeof outcome.stdout !== 'string') return null
  return outcome.stdout.trim() || null
}

// PATH order is arbitrary and frequently front-loaded with stale shims (npx
// prepends node_modules/.bin, which can hold a years-old CLI). Taking the FIRST
// hit would pin that stale binary — the very failure this resolver exists to
// prevent — so every candidate is collected and the newest one wins.
const locateClaudeOnPath = (env: NodeJS.ProcessEnv): string | null => {
  const rawPath = env.PATH ?? env.Path ?? ''
  if (!rawPath) return null
  const names = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude']
    : ['claude']
  const candidates: string[] = []
  for (const dir of rawPath.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = isAbsolute(dir) ? join(dir, name) : resolve(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        if (!candidates.includes(candidate)) candidates.push(candidate)
      } catch { /* keep scanning PATH */ }
    }
  }
  return pickNewestExecutable(
    candidates,
    (candidate) => readClaudeExecutableVersion(candidate, env),
  )
}

let preferredClaudeExecutableCache: { value: string | null } | null = null

const computePreferredClaudeExecutable = (
  env: NodeJS.ProcessEnv,
): string | null => {
  const pathClaude = locateClaudeOnPath(env)
  if (!pathClaude) return null
  const pathVersion = parseExecutableSemver(readClaudeExecutableVersion(pathClaude, env))
  if (!pathVersion) return null
  const bundled = resolveClaudeBundledCliCommand()
  // No bundled binary at all (unsupported platform / pruned install): the PATH CLI
  // is the only option, so take it.
  if (!bundled) return pathClaude
  const bundledVersion = parseExecutableSemver(readClaudeExecutableVersion(bundled, env))
  // Bundled exists but would not report a version: we cannot PROVE the PATH CLI is
  // newer, so keep the vetted bundled binary rather than gambling on an unknown.
  if (!bundledVersion) return null
  // Hand the SDK the PATH-installed CLI only when it is STRICTLY newer than the
  // bundled one — otherwise fall back to the vetted bundled binary (return null).
  return compareExecutableSemver(pathVersion.tuple, bundledVersion.tuple) > 0 ? pathClaude : null
}

// The SDK spawns its own bundled Claude CLI unless `pathToClaudeCodeExecutable`
// overrides it. Returns a PATH-installed `claude` when it is newer than the bundled
// binary (so operators who keep the CLI current get its newer model catalog — e.g. a
// freshly released Opus — without an app release), else null to use the SDK default.
// Memoized for the process lifetime; a CLI upgrade pairs with a daemon restart.
export const resolvePreferredClaudeExecutableV1 = (
  env: NodeJS.ProcessEnv = process.env,
  options: { force?: boolean } = {},
): string | null => {
  if (preferredClaudeExecutableCache && !options.force) {
    return preferredClaudeExecutableCache.value
  }
  const value = computePreferredClaudeExecutable(env)
  preferredClaudeExecutableCache = { value }
  return value
}

const gitFailureDetail = (
  failure: DoctorCommandOutcome['failure'],
): string => {
  if (failure === 'missing') return 'Git was not found on PATH.'
  if (failure === 'timeout') return 'Git version detection timed out after 3 seconds.'
  if (failure === 'overflow') return 'Git version output exceeded the 16 KiB safety limit.'
  return 'Git did not return a usable version.'
}

const gitCheck = (
  env: NodeJS.ProcessEnv,
  runCommand: NonNullable<OperatorDoctorDeps['runCommand']>,
): ReadinessCheck => {
  const expected = `>=${ENVIRONMENT_COMPATIBILITY_CONTRACT.tools.git.min_inclusive}`
    + ` <${ENVIRONMENT_COMPATIBILITY_CONTRACT.tools.git.max_exclusive}`
  const executable = executableIdentity('git', 'path', env, 'git')
  const outcome = runCommand('git', ['--version'], env)
  const parsed = outcome.failure || outcome.exitCode !== 0
    ? null
    : parseSemver(outcome.stdout)
  const min = parseSemver(ENVIRONMENT_COMPATIBILITY_CONTRACT.tools.git.min_inclusive)
  const max = parseSemver(ENVIRONMENT_COMPATIBILITY_CONTRACT.tools.git.max_exclusive)
  const supported = Boolean(
    parsed
    && min
    && max
    && compareSemver(parsed.tuple, min.tuple) >= 0
    && compareSemver(parsed.tuple, max.tuple) < 0,
  )
  if (supported && parsed) {
    return {
      id: 'git',
      label: 'Git',
      required: true,
      status: 'validated',
      actual: parsed.value,
      expected,
      detail: `Git ${parsed.value} is inside the supported functional readiness range.`,
      executable,
    }
  }
  const commands = process.platform === 'darwin'
    ? ['xcode-select --install', 'git --version']
    : process.platform === 'linux'
      ? ['sudo apt-get update', 'sudo apt-get install git', 'git --version']
      : ['git --version']
  return {
    id: 'git',
    label: 'Git',
    required: true,
    status: 'unsupported',
    actual: parsed?.value ?? null,
    expected,
    detail: outcome.failure
      ? gitFailureDetail(outcome.failure)
      : parsed
        ? `Git ${parsed.value} is outside the supported functional readiness range.`
        : 'Git returned an unparseable version.',
    executable,
    remediation: remediation(
      `Install or upgrade Git to ${expected}, then rerun Orchestra doctor.`,
      commands,
    ),
  }
}

const blockedLoginCheck = (
  provider: 'claude' | 'codex',
  executable: DoctorExecutableIdentity,
  env: NodeJS.ProcessEnv,
): ReadinessCheck => ({
  id: provider === 'codex' ? 'codex_login' : 'claude_login',
  label: provider === 'codex' ? 'Codex login' : 'Claude login',
  required: true,
  status: 'unsupported',
  actual: 'not checked',
  expected: 'authenticated',
  detail: `Login state was not probed because the ${provider === 'codex' ? 'Codex' : 'Claude'} CLI compatibility check did not pass.`,
  executable,
  remediation: provider === 'codex'
    ? env.ORCHESTRA_CODEX_COMMAND?.trim()
      ? remediation(
        'Select a pinned Codex executable, sign in through that same executable, and restart Orchestra.',
        [
          '"$ORCHESTRA_CODEX_COMMAND" --version',
          '"$ORCHESTRA_CODEX_COMMAND" login',
          '"$ORCHESTRA_CODEX_COMMAND" login status',
          'orchestra restart',
        ],
        'docs/codex.md',
      )
      : remediation(
        'Install the pinned Codex CLI, sign in, and restart Orchestra.',
        [
          `npm install --global @openai/codex@${PINNED_CODEX_VERSION}`,
          'codex login',
          'codex login status',
          'orchestra restart',
        ],
        'docs/codex.md',
      )
    : remediation(
      `Reinstall Orchestra from the same verified distribution or source checkout so its SDK-bundled Claude CLI is restored at ${PINNED_CLAUDE_CLI_VERSION}. No automatic repair command is offered because the installation directory cannot be inferred safely.`,
      [],
    ),
})

const failedLoginDetail = (
  provider: 'Claude' | 'Codex',
  failure: DoctorCommandOutcome['failure'],
  exitCode: number | null,
): string => {
  if (failure === 'missing') return `${provider} login status command was not found.`
  if (failure === 'timeout') return `${provider} login status timed out after 3 seconds.`
  if (failure === 'overflow') return `${provider} login status output exceeded the 16 KiB safety limit.`
  if (failure === 'failed' || exitCode === null) return `${provider} login status could not be determined.`
  if (exitCode === 0) return `${provider} login status returned an unparseable response.`
  return `${provider} login status returned an unsupported exit code.`
}

const codexLoginCheck = (
  env: NodeJS.ProcessEnv,
  command: string,
  compatible: boolean,
  runCommand: NonNullable<OperatorDoctorDeps['runCommand']>,
): ReadinessCheck => {
  const executable = executableIdentity(
    command,
    env.ORCHESTRA_CODEX_COMMAND?.trim() ? 'environment_override' : 'path',
    env,
    'codex',
  )
  if (!compatible) return blockedLoginCheck('codex', executable, env)
  const outcome = runCommand(command, ['login', 'status'], env)
  if (!outcome.failure && outcome.exitCode === 0) {
    return {
      id: 'codex_login',
      label: 'Codex login',
      required: true,
      status: 'validated',
      actual: 'authenticated',
      expected: 'authenticated',
      detail: 'Codex reported an authenticated session.',
      executable,
    }
  }
  const loggedOut = !outcome.failure && outcome.exitCode === 1
  return {
    id: 'codex_login',
    label: 'Codex login',
    required: true,
    status: 'unsupported',
    actual: loggedOut ? 'unauthenticated' : 'unknown',
    expected: 'authenticated',
    detail: loggedOut
      ? 'Codex reported that no authenticated session is available.'
      : failedLoginDetail('Codex', outcome.failure, outcome.exitCode),
    executable,
    remediation: env.ORCHESTRA_CODEX_COMMAND?.trim()
      ? remediation(
        'Sign in through the configured Codex executable, verify the same login, and restart Orchestra.',
        [
          '"$ORCHESTRA_CODEX_COMMAND" login',
          '"$ORCHESTRA_CODEX_COMMAND" login status',
          'orchestra restart',
        ],
        'docs/codex.md',
      )
      : remediation(
        'Sign in to Codex, verify the login, and restart Orchestra.',
        ['codex login', 'codex login status', 'orchestra restart'],
        'docs/codex.md',
      ),
  }
}

const parseClaudeLoggedIn = (stdout: string): boolean | null => {
  try {
    const value = JSON.parse(stdout) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const loggedIn = (value as Record<string, unknown>).loggedIn
    return typeof loggedIn === 'boolean' ? loggedIn : null
  } catch {
    return null
  }
}

const claudeLoginCheck = (
  env: NodeJS.ProcessEnv,
  command: string | null,
  compatible: boolean,
  runCommand: NonNullable<OperatorDoctorDeps['runCommand']>,
): ReadinessCheck => {
  const executable = executableIdentity(
    command ?? 'claude',
    'sdk_bundled',
    env,
    'claude',
  )
  if (!compatible || !command) return blockedLoginCheck('claude', executable, env)
  const outcome = runCommand(command, ['auth', 'status', '--json'], env)
  const loggedIn = outcome.failure ? null : parseClaudeLoggedIn(outcome.stdout)
  if (outcome.exitCode === 0 && loggedIn === true) {
    return {
      id: 'claude_login',
      label: 'Claude login',
      required: true,
      status: 'validated',
      actual: 'authenticated',
      expected: 'authenticated',
      detail: 'The SDK-bundled Claude CLI reported an authenticated session.',
      executable,
    }
  }
  return {
    id: 'claude_login',
    label: 'Claude login',
    required: true,
    status: 'unsupported',
    actual: loggedIn === false ? 'unauthenticated' : 'unknown',
    expected: 'authenticated',
    detail: loggedIn === false
      ? 'The SDK-bundled Claude CLI reported that no authenticated session is available.'
      : failedLoginDetail('Claude', outcome.failure, outcome.exitCode),
    executable,
    remediation: remediation(
      'Install the supported interactive Claude CLI, sign in, verify the login, and restart Orchestra.',
      [
        `npm install --global @anthropic-ai/claude-code@${PINNED_CLAUDE_CLI_VERSION}`,
        'claude auth login',
        'claude auth status --text',
        'orchestra restart',
      ],
    ),
  }
}

const reportStatus = (
  checks: readonly OperatorDoctorCheck[],
): CompatibilityStatus => {
  const required = checks.filter((check) => check.required)
  if (required.every((check) => check.status === 'validated')) return 'validated'
  if (required.some((check) => check.status === 'unsupported')) return 'unsupported'
  return 'experimental'
}

export const runOperatorReadinessDoctor = (
  provider: DoctorProvider = 'both',
  env: NodeJS.ProcessEnv = process.env,
  deps: OperatorDoctorDeps = {},
): OperatorDoctorReport => {
  const runCompatibility = deps.runCompatibilityDoctor ?? runEnvironmentDoctor
  const runCommand = deps.runCommand ?? runBoundedDoctorCommand
  const resolveClaude = deps.resolveClaudeBundledCommand ?? resolveClaudeBundledCliCommand
  const compatibility = runCompatibility(provider, env)
  const codexCommand = env.ORCHESTRA_CODEX_COMMAND?.trim() || 'codex'
  const claudeBundledCommand = resolveClaude()
  const checks: OperatorDoctorCheck[] = compatibility.checks.map((check) => {
    const executable = identityForCompatibilityCheck(
      check,
      env,
      codexCommand,
      claudeBundledCommand,
    )
    const fix = compatibilityRemediation(check, env)
    return {
      ...check,
      ...(executable ? { executable } : {}),
      ...(fix ? { remediation: fix } : {}),
    }
  })
  const git = gitCheck(env, runCommand)
  const toolchainIndex = checks.findIndex((check) => check.id === 'toolchain')
  checks.splice(toolchainIndex < 0 ? 0 : toolchainIndex + 1, 0, git)

  if (provider === 'codex' || provider === 'both') {
    checks.push(codexLoginCheck(
      env,
      codexCommand,
      compatibility.checks.some((check) =>
        check.id === 'codex_cli' && check.status === 'validated'),
      runCommand,
    ))
  }
  if (provider === 'claude' || provider === 'both') {
    checks.push(claudeLoginCheck(
      env,
      claudeBundledCommand,
      compatibility.checks.some((check) =>
        check.id === 'claude_bundled_cli' && check.status === 'validated'),
      runCommand,
    ))
  }

  const status = reportStatus(checks)
  return {
    schema_version: 2,
    contract_schema_version: compatibility.contract_schema_version,
    compatibility_schema_version: compatibility.schema_version,
    checked_at: compatibility.checked_at,
    provider,
    mode: 'readiness',
    fail_closed: true,
    ready: status === 'validated',
    status,
    compatibility_ready: compatibility.ready,
    compatibility_status: compatibility.status,
    checks,
  }
}
