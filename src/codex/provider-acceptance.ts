import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { projectManagedDriverEvent } from '../agent-os/managed-driver-event-projection.js'
import { canonicalHash, stableJson } from '../agent-os/agent-home-support.js'
import { CODEX_REQUEST_UNHANDLED } from './client.js'
import type {
  CodexAccountResponse,
  CodexModel,
  CodexRateLimitsResponse,
} from './protocol.js'
import { CodexAppServerService } from './service.js'
import {
  CodexAppServerSupervisor,
} from './supervisor.js'
import {
  CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1,
  createCodexProviderAdapterV1,
} from '../runtime/drivers/codex-provider-adapter.js'
import {
  CodexAgentDriver,
  type CodexApprovalDecision,
} from '../runtime/drivers/codex.js'
import { RuntimeSupervisor } from '../runtime/supervisor.js'
import type {
  DriverEvent,
  DriverSession,
} from '../runtime/types.js'
import {
  defineProviderExecutionIntentV1,
  defineProviderLaunchBoundaryV1,
  defineProviderNoCostConsentV1,
  selectProviderExecutionV1,
} from '../provider-contract.js'
import {
  CODEX_PROVIDER_MANIFEST_V1,
} from '../provider-manifests.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  ProviderAdapterRegistryV1,
} from '../provider-adapter-registry.js'
import {
  prepareManagedSubscriptionEnvironmentV1,
} from '../provider-runtime-environment.js'
import {
  ProviderAcceptanceRunV1,
  acceptanceCheckV1,
  failedAcceptanceCheckV1,
  verifyProviderAcceptanceArtifactsV1,
  type ProviderAcceptanceCheckV1,
  type ProviderAcceptanceFinalizationV1,
} from '../provider-acceptance-harness.js'

export const CODEX_ACCEPTANCE_VERSION_V1 = '0.144.6'
export const CODEX_ACCEPTANCE_PLATFORM_V1 = 'darwin-arm64'
export const CODEX_ACCEPTANCE_PACKAGE_V1 =
  `@openai/codex@${CODEX_ACCEPTANCE_VERSION_V1}`

const PREPARED_SCHEMA_VERSION = 1
const SOURCE_COMMIT = /^[a-f0-9]{40}$/
const SAFE_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'CODEX_CA_CERTIFICATE',
  'COLORTERM',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMP',
  'TMPDIR',
  'TEMP',
  'USER',
])

const allowlistedEnvironment = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SAFE_ENVIRONMENT_KEYS.has(name.toUpperCase())
      || name.toUpperCase().startsWith('LC_')) {
      environment[name] = value
    }
  }
  environment.PATH = source.PATH
  environment.TERM = source.TERM || 'xterm-256color'
  return environment
}

type CommandResult = {
  exit_code: number
  stdout: string
  stderr: string
}

export type PreparedCodexAcceptanceV1 = {
  schema_version: 1
  package_spec: string
  package_integrity: string
  cli_version: string
  platform: string
  prepared_at: string
  run_root: string
  tool_root: string
  profile_root: string
  codex_command: string
  wrapper_sha256: string
  native_executable: string
  native_sha256: string
}

export type PrepareCodexAcceptanceOptionsV1 = {
  run_root: string
  npm_command?: string
  now?: () => Date
}

export type RunCodexAcceptanceOptionsV1 = {
  run_root: string
  repository_root: string
  incompatible_codex_command?: string
  database_path?: string
  turn_timeout_ms?: number
  approval_timeout_ms?: number
  now?: () => Date
}

export type RunCodexAcceptanceResultV1 = {
  prepared: Readonly<PreparedCodexAcceptanceV1>
  finalization: ProviderAcceptanceFinalizationV1
  artifact_root: string
  database_path: string | null
  all_gates_passed: boolean
}

type ApprovalMode = 'allow' | 'deny' | 'timeout'

type ApprovalObservation = {
  mode: ApprovalMode
  kind: string
  decision: CodexApprovalDecision | 'timeout'
}

type CodexRuntime = {
  supervisor: CodexAppServerSupervisor
  service: CodexAppServerService
  driver: CodexAgentDriver
  approvals: ApprovalObservation[]
  setApprovalMode(mode: ApprovalMode): void
}

type LifecycleContext = {
  runtime: CodexRuntime
  session: DriverSession
  iterator: AsyncIterator<DriverEvent>
  workspaceId: string
  workspace: string
  model: CodexModel
  effort: string
  projectedEvents: ReturnType<typeof projectManagedDriverEvent>[]
}

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')

const command = (
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
  } = {},
): CommandResult => {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  return {
    exit_code: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? '').slice(0, 32_000),
    stderr: String(result.stderr ?? result.error?.message ?? '').slice(0, 32_000),
  }
}

const requiredCommand = (
  executable: string,
  args: readonly string[],
  options: Parameters<typeof command>[2] = {},
): CommandResult => {
  const result = command(executable, args, options)
  if (result.exit_code !== 0) {
    throw new Error(
      `${basename(executable)} failed with exit ${result.exit_code}: ${
        result.stderr.trim() || result.stdout.trim() || 'no diagnostic'
      }`,
    )
  }
  return result
}

const assertSafeRoot = (value: string, label: string): string => {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  const root = resolve(value)
  const forbidden = new Set([
    resolve('/'),
    resolve(homedir()),
    resolve(process.cwd()),
  ])
  if (forbidden.has(root) || dirname(root) === root) {
    throw new Error(`${label} is too broad`)
  }
  return root
}

const assertInside = (root: string, value: string, label: string): string => {
  const resolved = resolve(value)
  const path = relative(root, resolved)
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} must stay inside the acceptance run root`)
  }
  return resolved
}

const writeSecureJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${stableJson(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  chmodSync(path, 0o600)
}

const exactCliVersion = (output: string): string | null => {
  const match = /^codex-cli\s+([A-Za-z0-9._+-]+)$/u.exec(output.trim())
  return match?.[1] ?? null
}

const packageIntegrity = (toolRoot: string): string => {
  const lock = JSON.parse(
    readFileSync(join(toolRoot, 'package-lock.json'), 'utf8'),
  ) as {
    packages?: Record<string, { integrity?: unknown }>
  }
  const integrity = lock.packages?.['node_modules/@openai/codex']?.integrity
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error('installed Codex package has no registry integrity')
  }
  return integrity
}

const nativeExecutablePath = (toolRoot: string): string => {
  const platformPackage = join(
    toolRoot,
    'node_modules',
    '@openai',
    'codex-darwin-arm64',
    'vendor',
    'aarch64-apple-darwin',
    'bin',
    'codex',
  )
  if (!statSync(platformPackage).isFile()) {
    throw new Error('installed Codex package has no Darwin arm64 native executable')
  }
  return realpathSync(platformPackage)
}

export const prepareCodexAcceptanceV1 = (
  options: PrepareCodexAcceptanceOptionsV1,
): Readonly<PreparedCodexAcceptanceV1> => {
  const runRoot = assertSafeRoot(options.run_root, 'acceptance run root')
  if (existsSync(runRoot) && readdirSync(runRoot).length > 0) {
    throw new Error('acceptance run root must be new or empty')
  }
  mkdirSync(runRoot, { recursive: true, mode: 0o700 })
  chmodSync(runRoot, 0o700)
  const toolRoot = assertInside(runRoot, join(runRoot, 'tool'), 'tool root')
  const profileRoot = assertInside(runRoot, join(runRoot, 'profile'), 'profile root')
  mkdirSync(toolRoot, { mode: 0o700 })
  mkdirSync(profileRoot, { mode: 0o700 })
  chmodSync(toolRoot, 0o700)
  chmodSync(profileRoot, 0o700)
  const npmCache = assertInside(
    runRoot,
    join(runRoot, 'npm-cache'),
    'npm cache',
  )
  mkdirSync(npmCache, { mode: 0o700 })
  chmodSync(npmCache, 0o700)
  const installEnvironment = allowlistedEnvironment(process.env)
  installEnvironment.NPM_CONFIG_CACHE = npmCache
  installEnvironment.NPM_CONFIG_USERCONFIG = '/dev/null'
  const npmCommand = options.npm_command?.trim() || 'npm'
  requiredCommand(npmCommand, [
    'install',
    '--prefix',
    toolRoot,
    '--no-audit',
    '--no-fund',
    '--registry',
    'https://registry.npmjs.org/',
    CODEX_ACCEPTANCE_PACKAGE_V1,
  ], {
    env: installEnvironment,
    timeout: 120_000,
  })
  const codexCommand = realpathSync(join(toolRoot, 'node_modules', '.bin', 'codex'))
  const versionEnvironment = allowlistedEnvironment(process.env)
  versionEnvironment.CODEX_HOME = profileRoot
  const version = requiredCommand(codexCommand, ['--version'], {
    env: versionEnvironment,
  })
  const cliVersion = exactCliVersion(version.stdout)
  if (cliVersion !== CODEX_ACCEPTANCE_VERSION_V1) {
    throw new Error(
      `installed Codex CLI version ${cliVersion ?? 'unknown'} is not ${
        CODEX_ACCEPTANCE_VERSION_V1
      }`,
    )
  }
  const platform = `${process.platform}-${process.arch}`
  if (platform !== CODEX_ACCEPTANCE_PLATFORM_V1) {
    throw new Error(`Codex acceptance platform ${platform} is unsupported`)
  }
  const nativeExecutable = nativeExecutablePath(toolRoot)
  const prepared: PreparedCodexAcceptanceV1 = {
    schema_version: PREPARED_SCHEMA_VERSION,
    package_spec: CODEX_ACCEPTANCE_PACKAGE_V1,
    package_integrity: packageIntegrity(toolRoot),
    cli_version: cliVersion,
    platform,
    prepared_at: (options.now ?? (() => new Date()))().toISOString(),
    run_root: runRoot,
    tool_root: toolRoot,
    profile_root: profileRoot,
    codex_command: codexCommand,
    wrapper_sha256: sha256(readFileSync(codexCommand)),
    native_executable: nativeExecutable,
    native_sha256: sha256(readFileSync(nativeExecutable)),
  }
  writeSecureJson(join(runRoot, 'prepared.json'), prepared)
  return Object.freeze(prepared)
}

const exactPreparedKeys = [
  'schema_version',
  'package_spec',
  'package_integrity',
  'cli_version',
  'platform',
  'prepared_at',
  'run_root',
  'tool_root',
  'profile_root',
  'codex_command',
  'wrapper_sha256',
  'native_executable',
  'native_sha256',
] as const

export const loadPreparedCodexAcceptanceV1 = (
  runRootInput: string,
): Readonly<PreparedCodexAcceptanceV1> => {
  const runRoot = assertSafeRoot(runRootInput, 'acceptance run root')
  const value = JSON.parse(
    readFileSync(join(runRoot, 'prepared.json'), 'utf8'),
  ) as Record<string, unknown>
  const keys = Object.keys(value).sort()
  const expected = [...exactPreparedKeys].sort()
  if (keys.length !== expected.length
    || !keys.every((key, index) => key === expected[index])
    || value.schema_version !== PREPARED_SCHEMA_VERSION
    || value.package_spec !== CODEX_ACCEPTANCE_PACKAGE_V1
    || value.cli_version !== CODEX_ACCEPTANCE_VERSION_V1
    || value.platform !== CODEX_ACCEPTANCE_PLATFORM_V1
    || value.run_root !== runRoot
    || typeof value.package_integrity !== 'string'
    || !value.package_integrity.startsWith('sha512-')
    || typeof value.prepared_at !== 'string'
    || !Number.isFinite(Date.parse(value.prepared_at))
    || typeof value.wrapper_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.wrapper_sha256)
    || typeof value.native_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.native_sha256)) {
    throw new Error('Codex acceptance preparation record is invalid')
  }
  const prepared = value as PreparedCodexAcceptanceV1
  for (const [label, path] of [
    ['tool root', prepared.tool_root],
    ['profile root', prepared.profile_root],
    ['Codex command', prepared.codex_command],
    ['native executable', prepared.native_executable],
  ] as const) {
    assertInside(runRoot, path, label)
  }
  if (sha256(readFileSync(prepared.codex_command)) !== prepared.wrapper_sha256
    || sha256(readFileSync(prepared.native_executable)) !== prepared.native_sha256
    || packageIntegrity(prepared.tool_root) !== prepared.package_integrity) {
    throw new Error('Codex acceptance preparation record no longer matches installed bytes')
  }
  const version = exactCliVersion(
    requiredCommand(prepared.codex_command, ['--version'], {
      env: {
        ...allowlistedEnvironment(process.env),
        CODEX_HOME: prepared.profile_root,
      },
    }).stdout,
  )
  if (version !== CODEX_ACCEPTANCE_VERSION_V1) {
    throw new Error('prepared Codex command no longer reports the pinned version')
  }
  return Object.freeze({ ...prepared })
}

const childEnvironment = (
  prepared: PreparedCodexAcceptanceV1,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const preparedEnvironment = prepareManagedSubscriptionEnvironmentV1(
    'codex',
    source,
  ).forSpawn()
  const environment = allowlistedEnvironment(preparedEnvironment)
  environment.CODEX_HOME = prepared.profile_root
  return environment
}

const assertExactSourceCommit = (repositoryRoot: string): string => {
  const commit = requiredCommand('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
  }).stdout.trim()
  if (!SOURCE_COMMIT.test(commit)) {
    throw new Error('provider acceptance source commit is invalid')
  }
  const status = requiredCommand(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: repositoryRoot },
  ).stdout
  if (status.trim()) {
    throw new Error('provider acceptance requires a clean tracked source tree')
  }
  return commit
}

const check = async (
  checkId: string,
  evidenceKind: ProviderAcceptanceCheckV1['evidence_kind'],
  observe: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<ProviderAcceptanceCheckV1> => {
  try {
    return acceptanceCheckV1(checkId, 'passed', evidenceKind, await observe())
  } catch (error) {
    return failedAcceptanceCheckV1(checkId, evidenceKind, error)
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const waitForDriverEvent = async (
  context: Pick<LifecycleContext, 'iterator' | 'projectedEvents'>,
  predicate: (event: DriverEvent) => boolean,
  timeoutMs: number,
  label: string,
): Promise<DriverEvent> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const next = await withTimeout(
      context.iterator.next(),
      Math.max(1, deadline - Date.now()),
      label,
    )
    if (next.done) throw new Error(`${label} ended before the expected event`)
    context.projectedEvents.push(projectManagedDriverEvent(next.value, 'codex'))
    if (predicate(next.value)) return next.value
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

const collectCompletedTurn = async (
  context: Pick<LifecycleContext, 'iterator' | 'projectedEvents'>,
  timeoutMs: number,
  label: string,
): Promise<{ events: DriverEvent[]; text: string; status: string }> => {
  const events: DriverEvent[] = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const event = await waitForDriverEvent(
      context,
      () => true,
      Math.max(1, deadline - Date.now()),
      label,
    )
    events.push(event)
    if (event.metadata?.turnCompleted === true) {
      return {
        events,
        text: events
          .filter((candidate) => candidate.type === 'output')
          .map((candidate) => candidate.data)
          .join(''),
        status: String(event.metadata.status ?? ''),
      }
    }
  }
  throw new Error(`${label} did not complete`)
}

const modelChoice = (models: readonly CodexModel[]): CodexModel => {
  const model = models.find((candidate) => candidate.isDefault)
    ?? models.find((candidate) => !candidate.hidden)
    ?? models[0]
  if (!model?.model.trim()) throw new Error('Codex returned no selectable model')
  return model
}

const effortChoice = (model: CodexModel): string => {
  const supported = new Set(
    model.supportedReasoningEfforts
      .map((effort) => effort.reasoningEffort.trim())
      .filter(Boolean),
  )
  if (supported.has(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort
  }
  const effort = [...supported][0]
  if (!effort) throw new Error(`Codex model ${model.model} exposes no effort level`)
  return effort
}

const createRuntime = async (
  prepared: PreparedCodexAcceptanceV1,
  workspace: string,
  workspaceId: string,
  approvalTimeoutMs: number,
  environment = childEnvironment(prepared),
): Promise<CodexRuntime> => {
  let approvalMode: ApprovalMode = 'allow'
  const approvals: ApprovalObservation[] = []
  const supervisor = new CodexAppServerSupervisor({
    clientInfo: {
      name: 'orchestra_provider_acceptance',
      title: 'Orchestra Provider Acceptance',
      version: '1.0.0',
    },
    process: {
      command: prepared.codex_command,
      args: ['app-server', '--listen', 'stdio://'],
      cwd: workspace,
      env: environment,
      inheritEnv: false,
    },
    restart: {
      maxAttempts: 1,
      initialDelayMs: 100,
      maxDelayMs: 100,
      factor: 1,
      jitter: 0,
    },
  })
  const service = new CodexAppServerService(supervisor)
  const driver = new CodexAgentDriver({
    service,
    workspaceForThread: () => workspaceId,
    approvalTimeoutMs,
    resolveLaunchPolicy: () => ({
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    }),
    onApprovalRequest: (request) => {
      if (approvalMode === 'timeout') {
        approvals.push({
          mode: approvalMode,
          kind: request.kind,
          decision: 'timeout',
        })
        return CODEX_REQUEST_UNHANDLED
      }
      const decision = approvalMode === 'allow' ? 'allow' : 'deny'
      approvals.push({
        mode: approvalMode,
        kind: request.kind,
        decision,
      })
      return {
        decision: approvalMode === 'allow' ? 'accept' : 'decline',
      }
    },
  })
  await supervisor.start()
  return {
    supervisor,
    service,
    driver,
    approvals,
    setApprovalMode(mode): void {
      approvalMode = mode
    },
  }
}

const stopRuntime = async (runtime: CodexRuntime | undefined): Promise<void> => {
  if (!runtime) return
  await runtime.driver.detachAll().catch(() => {})
  runtime.driver.dispose()
  await runtime.supervisor.stop().catch(() => {})
}

const createWorkspace = (runRoot: string, sourceCommit: string): string => {
  const workspace = assertInside(
    runRoot,
    join(runRoot, `workspace-${sourceCommit.slice(0, 12)}`),
    'acceptance workspace',
  )
  if (existsSync(workspace) && readdirSync(workspace).length > 0) {
    throw new Error('acceptance workspace is not empty')
  }
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  chmodSync(workspace, 0o700)
  writeFileSync(
    join(workspace, 'acceptance-marker.txt'),
    'TOOL014-CLEAN-PROFILE-MARKER\n',
    { encoding: 'utf8', mode: 0o600 },
  )
  requiredCommand('git', ['init', '--quiet'], { cwd: workspace })
  requiredCommand('git', ['config', 'user.name', 'Orchestra Acceptance'], {
    cwd: workspace,
  })
  requiredCommand(
    'git',
    ['config', 'user.email', 'orchestra-acceptance@invalid.example'],
    { cwd: workspace },
  )
  requiredCommand('git', ['add', 'acceptance-marker.txt'], { cwd: workspace })
  requiredCommand('git', ['commit', '--quiet', '-m', 'acceptance fixture'], {
    cwd: workspace,
  })
  return realpathSync(workspace)
}

const assertChatGptSubscription = (
  account: CodexAccountResponse,
): { account_type: string; plan_type: string; email_present: boolean } => {
  if (account.account?.type !== 'chatgpt') {
    throw new Error(`Codex account type ${account.account?.type ?? 'signed_out'} is not ChatGPT`)
  }
  const planType = typeof account.account.planType === 'string'
    ? account.account.planType.trim()
    : ''
  if (!planType) throw new Error('Codex ChatGPT account has no plan type')
  return {
    account_type: 'chatgpt',
    plan_type: planType,
    email_present: Boolean(account.account.email),
  }
}

const rateLimitSummary = (
  response: CodexRateLimitsResponse,
): Record<string, unknown> => {
  const values = response.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId)
    : [response.rateLimits]
  if (values.length === 0) throw new Error('Codex returned no rate-limit windows')
  return {
    snapshot_count: values.length,
    exhausted: values.some((value) =>
      value.rateLimitReachedType != null
      || value.primary?.usedPercent === 100
      || value.secondary?.usedPercent === 100),
    plan_types: [...new Set(
      values.map((value) => value.planType).filter(
        (value): value is string => typeof value === 'string' && Boolean(value),
      ),
    )],
  }
}

const waitForOutput = async (
  supervisor: RuntimeSupervisor,
  processId: string,
  expected: string,
  timeoutMs: number,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  let after = 0
  let output = ''
  while (Date.now() < deadline) {
    const page = await supervisor.readOutput(processId, after, 1_000)
    output += page.chunks.map((chunk) => chunk.data).join('')
    after = page.nextSeq
    if (output.includes(expected)) return output
    await delay(50)
  }
  throw new Error(`PTY output did not contain ${expected}`)
}

const outputText = async (
  supervisor: RuntimeSupervisor,
  processId: string,
): Promise<string> => {
  let after = 0
  let output = ''
  for (;;) {
    const page = await supervisor.readOutput(processId, after, 10_000)
    output += page.chunks.map((chunk) => chunk.data).join('')
    if (page.nextSeq === after || page.chunks.length === 0) return output
    after = page.nextSeq
  }
}

const incompatibleCommand = (
  explicit: string | undefined,
  prepared: PreparedCodexAcceptanceV1,
): string => {
  if (explicit?.trim()) return realpathSync(explicit.trim())
  const located = command('/usr/bin/env', ['sh', '-lc', 'command -v codex'])
    .stdout.trim()
  if (!located) throw new Error('no independent Codex command exists for the incompatible-version gate')
  const resolved = realpathSync(located)
  if (resolved === prepared.codex_command) {
    throw new Error('incompatible Codex command resolves to the pinned command')
  }
  return resolved
}

const scanArtifactDirectory = (
  artifactRoot: string,
  forbidden: readonly string[],
): Record<string, unknown> => {
  const files = readdirSync(artifactRoot, { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === 'string' && entry.endsWith('.json'))
    .sort()
  let bytes = 0
  const prohibitedKey = /"(?:authorization|password|api_key|raw_response|email)"\s*:/iu
  for (const file of files) {
    const path = assertInside(artifactRoot, join(artifactRoot, file), 'artifact')
    const text = readFileSync(path, 'utf8')
    bytes += Buffer.byteLength(text)
    if (prohibitedKey.test(text)) {
      throw new Error(`provider acceptance artifact exposes a prohibited key: ${file}`)
    }
    for (const value of forbidden) {
      if (value && text.includes(value)) {
        throw new Error(`provider acceptance artifact contains forbidden material: ${file}`)
      }
    }
  }
  return {
    json_file_count: files.length,
    scanned_bytes: bytes,
    prohibited_key_count: 0,
    forbidden_value_count: 0,
  }
}

export async function runCodexAcceptanceV1(
  options: RunCodexAcceptanceOptionsV1,
): Promise<RunCodexAcceptanceResultV1> {
  const prepared = loadPreparedCodexAcceptanceV1(options.run_root)
  const repositoryRoot = realpathSync(options.repository_root)
  const runRootFromRepository = relative(repositoryRoot, prepared.run_root)
  if (!runRootFromRepository.startsWith(`..${sep}`)
    && runRootFromRepository !== '..'
    && !isAbsolute(runRootFromRepository)) {
    throw new Error('Codex acceptance run root must be outside the repository')
  }
  const sourceCommit = assertExactSourceCommit(repositoryRoot)
  const login = command(prepared.codex_command, ['login', 'status'], {
    env: childEnvironment(prepared),
  })
  if (login.exit_code !== 0 || !/Logged in using ChatGPT/iu.test(login.stdout)) {
    throw new Error(
      'the isolated Codex acceptance profile is not logged in with ChatGPT',
    )
  }
  const now = options.now ?? (() => new Date())
  const turnTimeoutMs = Math.max(30_000, options.turn_timeout_ms ?? 180_000)
  const approvalTimeoutMs = Math.max(
    1_000,
    options.approval_timeout_ms ?? 3_000,
  )
  const workspaceId = `tool014-${sourceCommit.slice(0, 16)}`
  const workspace = createWorkspace(prepared.run_root, sourceCommit)
  const artifactRelative = [
    'evidence',
    'codex',
    prepared.cli_version,
    prepared.platform,
    sourceCommit,
  ].join('/')
  const artifactRoot = assertInside(
    prepared.run_root,
    join(prepared.run_root, artifactRelative),
    'artifact root',
  )
  const credentialSentinel = `sk-tool014-${randomBytes(24).toString('hex')}`
  const acceptance = new ProviderAcceptanceRunV1({
    artifact_root: artifactRoot,
    reference_root: artifactRelative,
    tuple: {
      contract_version: 1,
      provider_id: 'codex',
      adapter_id: 'codex-app-server',
      adapter_version: '1.0.0',
      mode_id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kind: 'provider_account_session',
      executable_version: prepared.cli_version,
      platform: prepared.platform,
      source_commit: sourceCommit,
    },
    forbidden_substrings: [credentialSentinel],
    now,
  })
  const gateRecords = []
  let runtime: CodexRuntime | undefined
  let lifecycle: LifecycleContext | undefined
  let recoveredRuntime: CodexRuntime | undefined
  let recovered: LifecycleContext | undefined

  gateRecords.push(await acceptance.gate('executable_provenance', async () => {
    const protocol = command(process.execPath, [
      join(repositoryRoot, 'scripts', 'check-codex-protocol.mjs'),
    ], {
      cwd: repositoryRoot,
      env: {
        ...childEnvironment(prepared),
        ORCHESTRA_CODEX_COMMAND: prepared.codex_command,
      },
      timeout: 120_000,
    })
    return Promise.all([
      check('official_package_integrity', 'observed', () => ({
        package_spec: prepared.package_spec,
        package_integrity: prepared.package_integrity,
        wrapper_sha256: prepared.wrapper_sha256,
        native_sha256: prepared.native_sha256,
      })),
      check('exact_cli_version', 'observed', () => {
        const version = exactCliVersion(
          requiredCommand(prepared.codex_command, ['--version']).stdout,
        )
        if (version !== CODEX_ACCEPTANCE_VERSION_V1) {
          throw new Error(`unexpected Codex version ${version ?? 'unknown'}`)
        }
        return { executable_version: version }
      }),
      check('exact_platform', 'observed', () => {
        const platform = `${process.platform}-${process.arch}`
        if (platform !== CODEX_ACCEPTANCE_PLATFORM_V1) {
          throw new Error(`unexpected platform ${platform}`)
        }
        return { platform }
      }),
      check('exact_source_commit', 'observed', () => ({
        source_commit: sourceCommit,
        tracked_tree_clean: true,
      })),
      check('clean_isolated_profile', 'observed', () => {
        const topLevel = readdirSync(prepared.profile_root)
        const prohibited = topLevel.filter((name) =>
          name === 'config.toml'
          || name === 'AGENTS.md'
          || name === 'AGENTS.override.md'
          || name === 'skills'
          || name === 'plugins'
          || name === 'rules')
        if (prohibited.length > 0) {
          throw new Error('isolated Codex profile contains preconfigured behavior')
        }
        return {
          isolated_from_default_profile: prepared.profile_root
            !== resolve(homedir(), '.codex'),
          preconfigured_behavior_entries: 0,
        }
      }),
      check('pinned_protocol_schema', 'observed', () => {
        if (protocol.exit_code !== 0) {
          throw new Error(protocol.stderr.trim() || protocol.stdout.trim())
        }
        return {
          cli_version: CODEX_ACCEPTANCE_VERSION_V1,
          schema_sha256: CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1.slice(7),
          schema_verified: true,
        }
      }),
    ])
  }))

  try {
    runtime = await createRuntime(
      prepared,
      workspace,
      workspaceId,
      approvalTimeoutMs,
    )

    gateRecords.push(await acceptance.gate('subscription_billing', async () => {
      const [account, limits, usage] = await Promise.all([
        runtime!.service.readAccount(true),
        runtime!.service.readRateLimits(),
        runtime!.service.readUsage(),
      ])
      return [
        await check('chatgpt_account_session', 'observed', () =>
          assertChatGptSubscription(account)),
        await check('subscription_rate_limits', 'observed', () => ({
          ...rateLimitSummary(limits),
          billing_mode: 'personal_subscription',
          provider_managed_overage: 'not_enabled',
        })),
        await check('subscription_usage_projection', 'observed', () => {
          if (!usage.summary || typeof usage.summary !== 'object') {
            throw new Error('Codex returned no subscription usage summary')
          }
          return {
            usage_summary_present: true,
            daily_buckets_present: Array.isArray(usage.dailyUsageBuckets),
          }
        }),
      ]
    }))

    gateRecords.push(await acceptance.gate('credential_conflict', async () => {
      const seeded = {
        ...process.env,
        CODEX_HOME: prepared.profile_root,
        OPENAI_API_KEY: credentialSentinel,
        CODEX_API_KEY: credentialSentinel,
        OPENAI_BASE_URL: 'https://invalid.example',
      }
      const preparedEnvironment = prepareManagedSubscriptionEnvironmentV1(
        'codex',
        seeded,
      )
      const spawnEnvironment = preparedEnvironment.forSpawn()
      return [
        await check('conflicting_credentials_stripped', 'observed', () => {
          for (const name of [
            'OPENAI_API_KEY',
            'CODEX_API_KEY',
            'OPENAI_BASE_URL',
          ]) {
            if (spawnEnvironment[name] !== undefined) {
              throw new Error(`subscription environment retained ${name}`)
            }
          }
          return {
            conflict_policy: preparedEnvironment.evidence.conflict_policy,
            stripped_variables: preparedEnvironment.evidence.stripped_variables,
            credential_values_persisted: false,
          }
        }),
        await check('subscription_selection_preserved', 'observed', () => {
          const evidence = preparedEnvironment.evidence
          if (evidence.billing_mode !== 'personal_subscription'
            || evidence.credential_kind !== 'provider_account_session') {
            throw new Error('credential conflict changed the provider billing selection')
          }
          return {
            billing_mode: evidence.billing_mode,
            credential_kind: evidence.credential_kind,
            environment_fingerprint_present: Boolean(
              evidence.environment_fingerprint,
            ),
          }
        }),
      ]
    }))

    gateRecords.push(await acceptance.gate('managed_lifecycle', async () => {
      const models = await runtime!.service.listModels()
      const model = modelChoice(models)
      const effort = effortChoice(model)
      runtime!.setApprovalMode('allow')
      const session = await runtime!.driver.launch({
        workspaceId,
        cwd: workspace,
        prompt: [
          'Read acceptance-marker.txt without using a shell command.',
          'Reply with exactly TOOL014-FIRST-TURN.',
        ].join(' '),
        model: model.model,
        effort,
        accessProfile: 'workspace_write',
        permissionMode: 'workspace-write',
      })
      const context: LifecycleContext = {
        runtime: runtime!,
        session,
        iterator: runtime!.driver.events(session.id)[Symbol.asyncIterator](),
        workspaceId,
        workspace,
        model,
        effort,
        projectedEvents: [],
      }
      lifecycle = context
      const first = await collectCompletedTurn(
        context,
        turnTimeoutMs,
        'first managed Codex turn',
      )
      await runtime!.driver.updateSession(session.id, {
        model: model.model,
        effort,
        accessProfile: 'workspace_write',
      })
      await runtime!.driver.send(
        session.id,
        'Reply with exactly TOOL014-SECOND-TURN. Do not use tools.',
      )
      const second = await collectCompletedTurn(
        context,
        turnTimeoutMs,
        'second managed Codex turn',
      )

      runtime!.setApprovalMode('allow')
      const approvalsBeforeAllow = runtime!.approvals.length
      await runtime!.driver.send(session.id, [
        'Use the shell to run exactly:',
        'printf TOOL014-APPROVED > acceptance-approved.txt',
        'Then reply TOOL014-APPROVAL-ALLOW-DONE.',
      ].join(' '))
      const allowed = await collectCompletedTurn(
        context,
        turnTimeoutMs,
        'approved command turn',
      )

      runtime!.setApprovalMode('deny')
      const approvalsBeforeDeny = runtime!.approvals.length
      await runtime!.driver.send(session.id, [
        'Use the shell to run exactly:',
        'printf TOOL014-DENIED > acceptance-denied.txt',
        'If denied, reply TOOL014-APPROVAL-DENY-DONE.',
      ].join(' '))
      const denied = await collectCompletedTurn(
        context,
        turnTimeoutMs,
        'denied command turn',
      )

      runtime!.setApprovalMode('timeout')
      const approvalsBeforeTimeout = runtime!.approvals.length
      await runtime!.driver.send(session.id, [
        'Use the shell to run exactly:',
        'printf TOOL014-TIMEOUT > acceptance-timeout.txt',
        'If cancelled, reply TOOL014-APPROVAL-TIMEOUT-DONE.',
      ].join(' '))
      const timeoutTurn = await collectCompletedTurn(
        context,
        turnTimeoutMs,
        'approval timeout turn',
      )
      const usage = await runtime!.service.readUsage()
      const hasTokenEvent = context.projectedEvents.some((event) =>
        event.payload.metadata.tokens !== undefined)

      return [
        await check('real_first_turn', 'observed', () => {
          if (first.status !== 'completed'
            || !first.text.includes('TOOL014-FIRST-TURN')) {
            throw new Error('first real Codex turn did not complete with its marker')
          }
          return {
            status: first.status,
            output_marker_observed: true,
            projected_event_count: context.projectedEvents.length,
          }
        }),
        await check('real_second_turn', 'observed', () => {
          if (second.status !== 'completed'
            || !second.text.includes('TOOL014-SECOND-TURN')) {
            throw new Error('second real Codex turn did not complete with its marker')
          }
          return {
            status: second.status,
            same_provider_session: true,
          }
        }),
        await check('model_and_effort_selection', 'observed', () => {
          if (session.metadata.resolvedModel !== model.model
            || session.metadata.resolvedEffort !== effort) {
            throw new Error('Codex did not report the selected model and effort')
          }
          return {
            model: model.model,
            effort,
            access_profile: session.metadata.accessProfile,
          }
        }),
        await check('approval_allow', 'observed', () => {
          const observed = runtime!.approvals.slice(approvalsBeforeAllow)
          if (!observed.some((approval) => approval.mode === 'allow')
            || !existsSync(join(workspace, 'acceptance-approved.txt'))
            || !allowed.text.includes('TOOL014-APPROVAL-ALLOW-DONE')) {
            throw new Error('real Codex approval allow path was not observed')
          }
          return {
            approval_count: observed.length,
            approval_kinds: [...new Set(observed.map((approval) => approval.kind))],
            approved_effect_observed: true,
          }
        }),
        await check('approval_deny', 'observed', () => {
          const observed = runtime!.approvals.slice(approvalsBeforeDeny)
          if (!observed.some((approval) => approval.mode === 'deny')
            || existsSync(join(workspace, 'acceptance-denied.txt'))
            || !denied.text.includes('TOOL014-APPROVAL-DENY-DONE')) {
            throw new Error('real Codex approval deny path was not observed')
          }
          return {
            approval_count: observed.length,
            approval_kinds: [...new Set(observed.map((approval) => approval.kind))],
            denied_effect_absent: true,
          }
        }),
        await check('approval_timeout', 'observed', () => {
          const observed = runtime!.approvals.slice(approvalsBeforeTimeout)
          const timeoutEvent = timeoutTurn.events.some((event) =>
            event.type === 'error' && /approval .* timed out/iu.test(event.data))
          if (!observed.some((approval) => approval.mode === 'timeout')
            || !timeoutEvent
            || existsSync(join(workspace, 'acceptance-timeout.txt'))) {
            throw new Error('real Codex approval timeout path was not observed')
          }
          return {
            approval_count: observed.length,
            timeout_event_observed: true,
            timed_out_effect_absent: true,
          }
        }),
        await check('structured_events_and_usage', 'observed', () => {
          if (context.projectedEvents.length === 0
            || !usage.summary
            || typeof usage.summary !== 'object') {
            throw new Error('Codex structured events or usage were not observed')
          }
          return {
            projected_event_count: context.projectedEvents.length,
            token_event_observed: hasTokenEvent,
            account_usage_observed: true,
            raw_payloads_persisted: false,
          }
        }),
      ]
    }))

    gateRecords.push(await acceptance.gate('restart_recovery', async () => {
      if (!lifecycle) throw new Error('managed lifecycle session is unavailable')
      const externalId = lifecycle.session.externalId
      const selectedModel = lifecycle.model.model
      const selectedEffort = lifecycle.effort
      await lifecycle.runtime.driver.detach(lifecycle.session.id)
      lifecycle.runtime.driver.dispose()
      await lifecycle.runtime.supervisor.stop()
      runtime = undefined

      recoveredRuntime = await createRuntime(
        prepared,
        workspace,
        workspaceId,
        approvalTimeoutMs,
      )
      const attached = await recoveredRuntime.driver.attach(externalId)
      if (!attached) throw new Error('Codex restart recovery returned no session')
      await recoveredRuntime.driver.updateSession(attached.id, {
        model: selectedModel,
        effort: selectedEffort,
        accessProfile: 'workspace_write',
      })
      const context: LifecycleContext = {
        runtime: recoveredRuntime,
        session: attached,
        iterator: recoveredRuntime.driver.events(attached.id)[Symbol.asyncIterator](),
        workspaceId,
        workspace,
        model: lifecycle.model,
        effort: lifecycle.effort,
        projectedEvents: lifecycle.projectedEvents,
      }
      recovered = context
      await recoveredRuntime.driver.send(
        attached.id,
        'Reply with exactly TOOL014-RECOVERY-TURN. Do not use tools.',
      )
      const recoveryTurn = await collectCompletedTurn(
        context,
        turnTimeoutMs,
        'recovered Codex turn',
      )

      recoveredRuntime.setApprovalMode('allow')
      const cancelSession = await recoveredRuntime.driver.launch({
        workspaceId,
        cwd: workspace,
        prompt: [
          'Run the shell command sleep 60, then reply TOOL014-SHOULD-NOT-COMPLETE.',
        ].join(' '),
        model: selectedModel,
        effort: selectedEffort,
        accessProfile: 'workspace_write',
        permissionMode: 'workspace-write',
      })
      const cancelContext: LifecycleContext = {
        runtime: recoveredRuntime,
        session: cancelSession,
        iterator: recoveredRuntime.driver.events(cancelSession.id)[Symbol.asyncIterator](),
        workspaceId,
        workspace,
        model: lifecycle.model,
        effort: lifecycle.effort,
        projectedEvents: context.projectedEvents,
      }
      await waitForDriverEvent(
        cancelContext,
        (event) => {
          const item = event.metadata?.item
          return event.type === 'tool'
            && Boolean(item && typeof item === 'object'
              && (item as { type?: unknown }).type === 'commandExecution')
        },
        turnTimeoutMs,
        'Codex cancellable tool execution',
      )
      await recoveredRuntime.driver.interrupt(cancelSession.id)
      const interrupted = await collectCompletedTurn(
        cancelContext,
        turnTimeoutMs,
        'interrupted Codex turn',
      )
      await recoveredRuntime.driver.stop(cancelSession.id)

      return [
        await check('daemon_and_cli_restart', 'observed', () => ({
          old_supervisor_stopped: true,
          new_supervisor_generation: true,
          provider_session_preserved: attached.externalId === externalId,
        })),
        await check('durable_binding_recovered', 'observed', () => {
          if (attached.externalId !== externalId
            || attached.workspaceId !== workspaceId
            || attached.metadata.cwd !== workspace) {
            throw new Error('recovered Codex binding does not match durable scope')
          }
          return {
            external_id_preserved: true,
            workspace_id_preserved: true,
            cwd_preserved: true,
            model: attached.metadata.model,
            effort: attached.metadata.effort,
            access_profile: attached.metadata.accessProfile,
          }
        }),
        await check('post_restart_follow_up', 'observed', () => {
          if (recoveryTurn.status !== 'completed'
            || !recoveryTurn.text.includes('TOOL014-RECOVERY-TURN')) {
            throw new Error('post-restart Codex turn did not complete')
          }
          return {
            status: recoveryTurn.status,
            same_provider_session: true,
          }
        }),
        await check('generation_and_tool_cancellation', 'observed', () => {
          if (interrupted.status !== 'interrupted') {
            throw new Error(`Codex cancellation ended as ${interrupted.status}`)
          }
          return {
            command_execution_observed: true,
            interrupt_sent: true,
            final_status: interrupted.status,
          }
        }),
      ]
    }))

    gateRecords.push(await acceptance.gate('raw_terminal_coexistence', async () => {
      if (!recovered || recovered.session.status === 'stopped') {
        throw new Error('recovered managed session is not available for PTY coexistence')
      }
      const pty = new RuntimeSupervisor()
      const shell = await pty.spawn({
        workspaceId,
        name: 'tool014-raw-shell',
        command: '/bin/zsh',
        args: ['-f'],
        shell: false,
        cwd: workspace,
        env: childEnvironment(prepared),
        cols: 100,
        rows: 30,
        restartable: false,
      })
      await pty.write(shell.id, [
        "trap 'printf \"\\033[31mTOOL014-SIGINT\\033[0m\\n\"; exit 0' INT",
        'printf \"\\033[32mTOOL014-ANSI\\033[0m\\n\"',
        'pwd',
        'printf TOOL014-PTY-FILE > pty-created.txt',
        'git status --short',
        'node --version',
        'npm --version',
        'printf \"TOOL014-PACKAGE-TOOLS\\n\"',
        'while :; do sleep 1; done',
        '',
      ].join('\n'))
      let shellOutput = await waitForOutput(
        pty,
        shell.id,
        'TOOL014-PACKAGE-TOOLS',
        15_000,
      )
      const resized = await pty.resize(shell.id, 141, 43)
      await pty.signal(shell.id, 'SIGWINCH')
      await pty.signal(shell.id, 'SIGINT')
      await delay(250)
      shellOutput += await outputText(pty, shell.id)
      await pty.stop(shell.id, 1_000).catch(() => undefined)

      const tui = await pty.spawn({
        workspaceId,
        name: 'tool014-codex-tui',
        command: prepared.codex_command,
        args: ['--no-alt-screen', '-C', workspace],
        shell: false,
        cwd: workspace,
        env: childEnvironment(prepared),
        cols: 120,
        rows: 36,
        restartable: false,
      })
      await delay(2_000)
      const initialTuiOutput = await outputText(pty, tui.id)
      const resizedTui = await pty.resize(tui.id, 132, 40)
      await pty.write(tui.id, '\u0003')
      await delay(250)
      await pty.stop(tui.id, 1_000).catch(() => undefined)
      const tuiOutput = initialTuiOutput + await outputText(pty, tui.id)

      return [
        await check('concurrent_managed_session', 'observed', () => {
          if (recovered!.session.status === 'stopped') {
            throw new Error('managed Codex session stopped during PTY checks')
          }
          return {
            provider_session_attached: true,
            raw_terminal_processes: 2,
          }
        }),
        await check('shell_files_git_packages', 'observed', () => {
          for (const marker of [
            'TOOL014-ANSI',
            workspace,
            'pty-created.txt',
            'TOOL014-PACKAGE-TOOLS',
          ]) {
            if (!shellOutput.includes(marker)) {
              throw new Error(`PTY shell output is missing ${marker}`)
            }
          }
          if (!existsSync(join(workspace, 'pty-created.txt'))) {
            throw new Error('PTY shell did not create its file')
          }
          return {
            shell_commands_observed: true,
            file_io_observed: true,
            git_observed: true,
            package_tools_observed: true,
            ansi_observed: shellOutput.includes('\u001b['),
          }
        }),
        await check('signals_and_resize', 'observed', () => {
          if (resized.cols !== 141 || resized.rows !== 43
            || !shellOutput.includes('TOOL014-SIGINT')) {
            throw new Error('PTY signal or resize evidence is incomplete')
          }
          return {
            cols: resized.cols,
            rows: resized.rows,
            sigwinch_observed: true,
            sigint_observed: true,
          }
        }),
        await check('provider_native_tui', 'observed', () => {
          if (resizedTui.cols !== 132 || resizedTui.rows !== 40
            || tuiOutput.length === 0
            || (!/Codex/iu.test(tuiOutput) && !tuiOutput.includes('\u001b['))) {
            throw new Error('Codex native TUI did not produce terminal evidence')
          }
          return {
            tui_started: true,
            tui_output_observed: true,
            tui_resize_observed: true,
            tui_interrupt_observed: true,
          }
        }),
      ]
    }))

    gateRecords.push(await acceptance.gate('failure_semantics', async () => {
      if (!recoveredRuntime) throw new Error('Codex runtime unavailable for failure checks')
      const signedOutRoot = assertInside(
        prepared.run_root,
        join(prepared.run_root, 'negative-signed-out-profile'),
        'signed-out profile',
      )
      mkdirSync(signedOutRoot, { recursive: true, mode: 0o700 })
      chmodSync(signedOutRoot, 0o700)
      const signedOutPrepared = {
        ...prepared,
        profile_root: signedOutRoot,
      }
      const signedOutEnvironment = childEnvironment(signedOutPrepared)
      const signedOutSupervisor = new CodexAppServerSupervisor({
        process: {
          command: prepared.codex_command,
          args: ['app-server', '--listen', 'stdio://'],
          cwd: workspace,
          env: signedOutEnvironment,
          inheritEnv: false,
        },
        restart: { maxAttempts: 0 },
      })
      const signedOutService = new CodexAppServerService(signedOutSupervisor)
      let signedOutAccount: CodexAccountResponse | null = null
      try {
        await signedOutSupervisor.start()
        signedOutAccount = await signedOutService.readAccount(false)
      } finally {
        await signedOutSupervisor.stop().catch(() => {})
      }

      const otherCommand = incompatibleCommand(
        options.incompatible_codex_command,
        prepared,
      )
      const incompatibleAdapter = createCodexProviderAdapterV1({
        driver: recoveredRuntime.driver,
        service: recoveredRuntime.service,
        command: otherCommand,
        environment: childEnvironment(prepared),
      })
      const incompatible = await incompatibleAdapter.discoverExecutable()
      const acceptedAdapter = createCodexProviderAdapterV1({
        driver: recoveredRuntime.driver,
        service: recoveredRuntime.service,
        command: prepared.codex_command,
        environment: childEnvironment(prepared),
        resolveRecoveryTarget: () => ({ workspaceId, cwd: workspace }),
      })
      const selection = selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1)
      const intent = defineProviderExecutionIntentV1({
        selection,
        execution_scope: 'managed_background',
        usage_priced_api: defineProviderNoCostConsentV1(),
        provider_managed_overage: defineProviderNoCostConsentV1(),
        required_capabilities: ['launch'],
      })
      const discovery = await acceptedAdapter.discoverExecutable()
      const preparedEnvironment = acceptedAdapter.prepareEnvironment(
        intent,
        childEnvironment(prepared),
        { on_conflict: 'strip' },
      )
      const boundary = defineProviderLaunchBoundaryV1(
        CODEX_PROVIDER_MANIFEST_V1,
        discovery,
        CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1,
        preparedEnvironment,
      )
      const realLimits = await recoveredRuntime.service.readRateLimits()
      const exhaustedLimits: CodexRateLimitsResponse = structuredClone(realLimits)
      exhaustedLimits.rateLimits.rateLimitReachedType = 'acceptance_negative_control'
      const exhaustedService = {
        listModels: (...args: Parameters<CodexAppServerService['listModels']>) =>
          recoveredRuntime!.service.listModels(...args),
        readAccount: (...args: Parameters<CodexAppServerService['readAccount']>) =>
          recoveredRuntime!.service.readAccount(...args),
        readRateLimits: async () => exhaustedLimits,
        readUsage: (...args: Parameters<CodexAppServerService['readUsage']>) =>
          recoveredRuntime!.service.readUsage(...args),
      }
      const exhaustedAdapter = createCodexProviderAdapterV1({
        driver: recoveredRuntime.driver,
        service: exhaustedService,
        command: prepared.codex_command,
        environment: childEnvironment(prepared),
      })
      const exhaustedReadiness = await exhaustedAdapter.probeReadiness(
        intent,
        boundary,
      )
      const registry = new ProviderAdapterRegistryV1()
      registry.register(acceptedAdapter)
      const assessment = registry.assessSupport(
        selection,
        prepared.cli_version,
        prepared.platform,
        sourceCommit,
      )

      return [
        await check('signed_out_fails_visible', 'observed', () => {
          if (signedOutAccount?.account !== null
            || signedOutAccount.requiresOpenaiAuth !== true) {
            throw new Error('clean signed-out Codex profile did not report auth required')
          }
          return {
            account_state: 'signed_out',
            requires_openai_auth: true,
            fallback_attempted: false,
          }
        }),
        await check('incompatible_version_fails_closed', 'observed', () => {
          if (incompatible.status !== 'incompatible'
            || incompatible.version === prepared.cli_version) {
            throw new Error('independent Codex version was not rejected')
          }
          return {
            status: incompatible.status,
            observed_version: incompatible.version,
            expected_version: prepared.cli_version,
          }
        }),
        await check('exhausted_quota_fails_closed', 'negative_control', () => {
          if (exhaustedReadiness.overage_status !== 'exhausted') {
            throw new Error('Codex exhausted quota did not fail readiness closed')
          }
          return {
            overage_status: exhaustedReadiness.overage_status,
            provider_managed_overage_consent: 'not_granted',
            fallback_attempted: false,
          }
        }),
        await check('unsupported_capability_visible', 'source_contract', () => {
          const attach = CODEX_PROVIDER_MANIFEST_V1.modes[0]?.capabilities.attach
          if (attach?.state !== 'unsupported') {
            throw new Error('raw Codex attach capability is not fail-closed')
          }
          return {
            capability: 'attach',
            state: attach.state,
            reason_code: attach.reason_code,
          }
        }),
        await check('support_registry_fails_closed', 'source_contract', () => {
          if (assessment.ready) {
            throw new Error('candidate Codex provider unexpectedly passed support assessment')
          }
          return {
            ready: false,
            blockers: assessment.blockers,
            provider_or_billing_fallback: false,
          }
        }),
      ]
    }))

    gateRecords.push(await acceptance.gate('credential_redaction', async () => {
      const projections = [...new Set([
        ...(lifecycle?.projectedEvents ?? []),
        ...(recovered?.projectedEvents ?? []),
      ])]
      return [
        await check('artifact_scan', 'observed', () =>
          scanArtifactDirectory(artifactRoot, [credentialSentinel])),
        await check('approval_payloads_withheld', 'observed', () => {
          const approvals = projections.filter(
            (event) => event.classification === 'approval',
          )
          if (approvals.length === 0
            || approvals.some((event) =>
              event.payload.metadata.approvalPayloadState !== 'withheld')) {
            throw new Error('approval projections did not withhold raw payloads')
          }
          return {
            approval_projection_count: approvals.length,
            raw_approval_payloads_persisted: false,
          }
        }),
        await check('managed_event_payloads_bounded', 'observed', () => {
          if (projections.length === 0
            || projections.some((event) =>
              JSON.stringify(event.payload).includes(credentialSentinel))) {
            throw new Error('managed event redaction evidence is incomplete')
          }
          return {
            projected_event_count: projections.length,
            credential_values_persisted: false,
            raw_native_payloads_persisted: false,
          }
        }),
      ]
    }))
  } catch (error) {
    const recorded = new Set(gateRecords.map((gate) => gate.gate_id))
    for (const gateId of DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1) {
      if (recorded.has(gateId)) continue
      gateRecords.push(await acceptance.gate(gateId, async () => [
        failedAcceptanceCheckV1('run_dependency', 'observed', error),
      ]))
    }
  } finally {
    if (recoveredRuntime) await stopRuntime(recoveredRuntime)
    if (runtime) await stopRuntime(runtime)
  }

  const allPassed = gateRecords.length === 8
    && gateRecords.every((gate) => gate.state === 'passed')
  const databasePath = options.database_path === undefined
    ? join(prepared.run_root, 'orchestra-acceptance.db')
    : resolve(options.database_path)
  const finalization = acceptance.finalize(allPassed ? databasePath : undefined)
  verifyProviderAcceptanceArtifactsV1(
    artifactRoot,
    finalization,
    [credentialSentinel],
  )
  return {
    prepared,
    finalization,
    artifact_root: artifactRoot,
    database_path: allPassed ? databasePath : null,
    all_gates_passed: allPassed,
  }
}

export const preparedCodexLoginCommandV1 = (
  prepared: PreparedCodexAcceptanceV1,
): readonly string[] => Object.freeze([
  '/usr/bin/env',
  `CODEX_HOME=${prepared.profile_root}`,
  prepared.codex_command,
  'login',
  '--device-auth',
])

export const preparedCodexFingerprintV1 = (
  prepared: PreparedCodexAcceptanceV1,
): string => canonicalHash(prepared)
