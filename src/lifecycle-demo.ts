import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { AgentOsApi } from './agent-os-cli.js'

export type LifecycleDemoLaunchAttestationV1 = {
  schema_version: 1
  provider_id: 'claude' | 'codex'
  doctor: {
    ready: true
    checked_at: string
  }
  acceptance: {
    accepted: true
    runtime_mode: 'native_cli'
    billing_mode: 'personal_subscription'
    source_commit: string
    matrix_sha256: string
    executable_version: string
    platform: string
  }
}

export type LifecycleDemoDeps = {
  authorizeLaunch?: (
    provider: 'claude' | 'codex',
    projectRoot: string,
  ) => Promise<LifecycleDemoLaunchAttestationV1>
  nowMs?: () => number
  orchestraHome?: string
}

export type LifecycleDemoLaunchGateDeps = {
  runDoctor: (provider: 'claude' | 'codex') => {
    mode: 'readiness'
    provider: 'claude' | 'codex' | 'both'
    ready: boolean
    checked_at: string
  }
  requireExactAcceptance: (
    provider: 'claude' | 'codex',
    projectRoot: string,
  ) => Promise<LifecycleDemoLaunchAttestationV1['acceptance']>
}

export const createLifecycleDemoLaunchAuthorizer = (
  deps: LifecycleDemoLaunchGateDeps,
): NonNullable<LifecycleDemoDeps['authorizeLaunch']> =>
  async (provider, projectRoot) => {
    const doctor = deps.runDoctor(provider)
    if (doctor.mode !== 'readiness'
      || doctor.provider !== provider
      || doctor.ready !== true
      || !canonicalTimestamp(doctor.checked_at)) {
      throw new Error('lifecycle demo launch requires a current ready provider doctor')
    }
    const acceptance = await deps.requireExactAcceptance(provider, projectRoot)
    return {
      schema_version: 1,
      provider_id: provider,
      doctor: { ready: true, checked_at: doctor.checked_at },
      acceptance,
    }
  }

export type LifecycleDemoResult = {
  board_id: number
  card_id: number
  contract_version: number | null
  job_id: string | null
  state: 'contract_published' | 'job_created'
  next_step: string
}

const objectId = (value: unknown, label: string): string | number => {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw new Error(`demo response is missing ${label}`)
}

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

const validateLaunchAttestation = (
  value: LifecycleDemoLaunchAttestationV1,
  provider: 'claude' | 'codex',
  nowMs: number,
): void => {
  const plainWithKeys = (candidate: unknown, keys: readonly string[]): boolean => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.getPrototypeOf(candidate) !== Object.prototype) return false
    const actual = Object.keys(candidate).sort()
    const expected = [...keys].sort()
    return actual.length === expected.length
      && actual.every((key, index) => key === expected[index])
  }
  const checkedAt = Date.parse(value?.doctor?.checked_at)
  if (!plainWithKeys(value, ['schema_version', 'provider_id', 'doctor', 'acceptance'])
    || !plainWithKeys(value?.doctor, ['ready', 'checked_at'])
    || !plainWithKeys(value?.acceptance, [
      'accepted', 'runtime_mode', 'billing_mode', 'source_commit', 'matrix_sha256',
      'executable_version', 'platform',
    ])
    || value.schema_version !== 1
    || value.provider_id !== provider
    || value.doctor?.ready !== true
    || !canonicalTimestamp(value.doctor.checked_at)
    || checkedAt < nowMs - 5 * 60_000
    || checkedAt > nowMs + 5_000
    || value.acceptance?.accepted !== true
    || value.acceptance.runtime_mode !== 'native_cli'
    || value.acceptance.billing_mode !== 'personal_subscription'
    || !/^[a-f0-9]{40}$/.test(value.acceptance.source_commit)
    || !/^[a-f0-9]{64}$/.test(value.acceptance.matrix_sha256)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value.acceptance.executable_version)
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.acceptance.platform)) {
    throw new Error('lifecycle demo launch lacks exact doctor and provider-acceptance evidence')
  }
}

const demoScope = (projectRoot: string, requested?: string): {
  projectRoot: string
  relativePath: string
} => {
  if (!path.isAbsolute(projectRoot)) throw new Error('demo project root must be absolute')
  let canonicalRoot: string
  try {
    canonicalRoot = fs.realpathSync(projectRoot)
    if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('demo project directory does not exist')
  }
  const choices = requested
    ? [requested]
    : ['README.md', 'package.json', '.gitignore', 'docs/lifecycle-demo.md']
  for (const choice of choices) {
    if (!choice || path.isAbsolute(choice)) continue
    const resolved = path.resolve(canonicalRoot, choice)
    const relative = path.relative(canonicalRoot, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    try {
      if (!fs.lstatSync(resolved).isFile()) continue
      return { projectRoot: canonicalRoot, relativePath: relative.split(path.sep).join('/') }
    } catch {}
  }
  throw new Error('demo requires an existing safe sample file in the selected project')
}

const lifecycleStateRoot = (explicit?: string): string => {
  const environmentHasHome = Object.prototype.hasOwnProperty.call(process.env, 'ORCHESTRA_HOME')
  const configured = explicit !== undefined
    ? explicit
    : environmentHasHome
      ? process.env.ORCHESTRA_HOME
      : undefined
  if (configured !== undefined) {
    if (!configured || !path.isAbsolute(configured)) {
      throw new Error('ORCHESTRA_HOME must be a non-empty absolute path')
    }
    return path.resolve(configured)
  }
  const home = os.homedir()
  if (!home || !path.isAbsolute(home)) {
    throw new Error('HOME must resolve to an absolute path before using default ORCHESTRA_HOME')
  }
  return path.join(home, '.orchestra')
}

const acquireLifecycleDemoLock = (
  stateRoot: string,
  identity: string,
): (() => void) => {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const rootStat = fs.lstatSync(stateRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('ORCHESTRA_HOME must be a real directory for lifecycle locking')
  }
  const lockDirectory = path.join(stateRoot, 'lifecycle-demo-locks')
  fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 })
  const lockStat = fs.lstatSync(lockDirectory)
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw new Error('lifecycle demo lock directory must be a real directory')
  }
  fs.chmodSync(lockDirectory, 0o700)
  const lockId = createHash('sha256').update(identity).digest('hex')
  const lockPath = path.join(lockDirectory, `${lockId}.lock`)
  const token = `${process.pid}:${randomUUID()}\n`
  let descriptor: number
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600)
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      throw new Error('lifecycle demo is already running for this exact marker and provider')
    }
    throw error
  }
  try {
    fs.writeFileSync(descriptor, token)
    fs.fsyncSync(descriptor)
    if ((fs.fstatSync(descriptor).mode & 0o777) !== 0o600) {
      throw new Error('lifecycle demo lock mode did not verify as 600')
    }
  } catch (error) {
    fs.closeSync(descriptor)
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
    throw error
  } finally {
    try { fs.closeSync(descriptor) } catch {}
  }
  return () => {
    let current: string
    try { current = fs.readFileSync(lockPath, 'utf8') } catch {
      throw new Error('lifecycle demo lock disappeared before release')
    }
    if (current !== token) {
      throw new Error('lifecycle demo lock changed concurrently; refusing to remove it')
    }
    fs.unlinkSync(lockPath)
    if (fs.existsSync(lockPath)) throw new Error('lifecycle demo lock release did not verify')
  }
}

/**
 * Creates real Board + WorkContract records and optionally a real Job. The safe
 * default stops before provider execution so the demo cannot incur usage or
 * mutate a workspace without an explicit launch decision.
 */
export const runLifecycleDemo = async (
  api: AgentOsApi,
  input: {
    project_root: string
    launch?: boolean
    provider?: 'claude' | 'codex'
    idempotency_prefix?: string
    sample_path?: string
  },
  deps: LifecycleDemoDeps = {},
): Promise<LifecycleDemoResult> => {
  const prefix = input.idempotency_prefix?.trim() || 'orchestra-lifecycle-demo-v1'
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(prefix)) {
    throw new Error('demo idempotency prefix is invalid')
  }
  const provider = input.provider ?? 'codex'
  const scope = demoScope(input.project_root, input.sample_path)
  const stateRoot = lifecycleStateRoot(deps.orchestraHome)
  if (input.launch) {
    if (!deps.authorizeLaunch) {
      throw new Error('lifecycle demo launch gate is not registered')
    }
    const attestation = await deps.authorizeLaunch(provider, scope.projectRoot)
    validateLaunchAttestation(attestation, provider, (deps.nowMs ?? Date.now)())
  }
  const marker = `[orchestra-lifecycle-demo:${prefix}]`
  const description = `${marker} provider=${provider} sample=${scope.relativePath} A real, reviewable Create → Contract → Publish lifecycle sample.`
  const releaseLock = acquireLifecycleDemoLock(
    stateRoot,
    `${scope.projectRoot}\n${provider}\n${prefix}`,
  )
  try {
  const board = await api('POST', '/boards/resolve', { project_path: scope.projectRoot })
  const boardId = Number(objectId(board?.id ?? board?.board?.id, 'board id'))
  const snapshot = await api('GET', `/boards/${boardId}/snapshot`)
  const existing = Array.isArray(snapshot?.cards)
    ? snapshot.cards.find((card: any) =>
      card?.title === 'Orchestra lifecycle demo' && card?.description === description)
    : undefined
  const created = existing ?? await api('POST', '/cards', {
      board_id: boardId,
      title: 'Orchestra lifecycle demo',
      description,
      paths: [scope.relativePath],
      column: 'backlog',
    })
  const cardId = Number(objectId(created?.card?.id ?? created?.id, 'card id'))
  const current = await api('GET', `/os/cards/${cardId}/contract`)
  const marketVersion = Number(current?.job_market?.market_version ?? 0)
  const status = String(current?.job_market?.status ?? 'draft')
  if (status !== 'draft' && status !== 'open') {
    throw new Error(`demo contract already advanced to ${status}; refusing to rewrite it`)
  }
  const contractInput = {
    objective: 'Review the lifecycle demo and produce evidence without changing product code.',
    deliverables: [{
      id: 'demo-report',
      text: 'Lifecycle demo report',
      required: true,
      metadata: { sample: true },
    }],
    acceptance_criteria: [{
      id: 'demo-evidence',
      text: 'Observed evidence is attached',
      required: true,
      deliverable_ids: ['demo-report'],
      metadata: { sample: true },
      verifier: { kind: 'human' },
    }],
    non_goals: ['No provider API billing', 'No automatic shipping'],
    risks: ['Provider support may still be candidate or unsupported'],
    verify_commands: ['git status --short'],
    provider_constraints: [provider],
    access_needs: ['read_only'],
    budget_retries: 0,
    expected_market_version: marketVersion,
  }
  const updated = status === 'draft'
    ? await api('PUT', `/os/cards/${cardId}/contract`, contractInput)
    : current
  if (status === 'draft') {
    await api('POST', `/os/cards/${cardId}/contract/publish`, {
      actor: 'human',
      expected_market_version: Number(updated?.job_market?.market_version ?? marketVersion),
    })
  }
  const contractVersion = Number(updated?.contract?.version ?? updated?.version)
  if (!input.launch) {
    return {
      board_id: boardId,
      card_id: cardId,
      contract_version: Number.isSafeInteger(contractVersion) ? contractVersion : null,
      job_id: null,
      state: 'contract_published',
      next_step: `Run doctor, inspect contract ${cardId}, then explicitly create a native-subscription job when the provider gate is satisfied.`,
    }
  }
  const jobs = await api('GET', `/os/boards/${boardId}/jobs`)
  const existingJob = Array.isArray(jobs?.jobs)
    ? jobs.jobs.find((candidate: any) => Number(candidate?.card_id) === cardId)
    : undefined
  const job = existingJob ?? await api('POST', `/os/boards/${boardId}/jobs`, {
      card_id: cardId,
      provider,
      max_attempts: 1,
      budget_tokens: 8_000,
      idempotency_key: `${prefix}:job:${boardId}:${cardId}`,
    })
  return {
    board_id: boardId,
    card_id: cardId,
    contract_version: Number.isSafeInteger(contractVersion) ? contractVersion : null,
    job_id: String(objectId(job?.job?.id ?? job?.id, 'job id')),
    state: 'job_created',
    next_step: 'Inspect the immutable Asked snapshot, submit evidence, verify independently, then accept or reject the Delivery.',
  }
  } finally {
    releaseLock()
  }
}
