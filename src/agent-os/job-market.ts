import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'
import {
  TaskContractService,
  type ContractAcceptanceCriterion,
  type PutTaskContract,
  type TaskContract,
} from './task-contracts.js'

export const JOB_MARKET_STATUSES = [
  'draft',
  'open',
  'assigned',
  'running',
  'submitted',
  'accepted',
  'rejected',
  'cancelled',
  'archived',
] as const

export type JobMarketStatus = typeof JOB_MARKET_STATUSES[number]
export type DependencyCompletionCondition = 'card_done'
export type ContractAccessNeed = 'read_only' | 'workspace_write' | 'full_access'

export interface CriterionVerifier {
  kind: 'command' | 'artifact' | 'human' | 'custom'
  command?: string
  artifact_kind?: string
  instructions?: string
}

export interface RequiredArtifact {
  kind: string
  name: string | null
  description: string | null
}

export interface JobMarketCriterion extends ContractAcceptanceCriterion {
  description: string
  verifier: CriterionVerifier
  required_artifacts: RequiredArtifact[]
  priority: number
  owner: string | null
}

export interface JobMarketDependency {
  card_id: number
  blocking_reason: string
  completion_condition: DependencyCompletionCondition
}

export interface JobMarketConstraints {
  required_capabilities: string[]
  provider_constraints: string[]
  model_constraints: string[]
  access_needs: ContractAccessNeed[]
}

export interface JobMarketBudgets {
  tokens: number | null
  cost_cents: number | null
  time_seconds: number | null
  retries: number | null
  coordination_tokens: number | null
  coordination_messages: number | null
}

export interface JobMarketContract {
  card_id: number
  status: JobMarketStatus
  market_version: number
  contract: TaskContract
  criteria: JobMarketCriterion[]
  dependency_rules: JobMarketDependency[]
  constraints: JobMarketConstraints
  budgets: JobMarketBudgets
  published_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface ContractValidation {
  mode: 'publish' | 'launch'
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface LaunchContractContext {
  provider: string
  model: string | null
  accessProfile: ContractAccessNeed
}

interface MarketRow {
  card_id: number
  status: JobMarketStatus
  required_capabilities_json: string
  provider_constraints_json: string
  model_constraints_json: string
  access_needs_json: string
  budget_time_seconds: number | null
  budget_retries: number | null
  budget_coordination_tokens: number | null
  budget_coordination_messages: number | null
  version: number
  published_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface CriterionRow {
  criterion_id: string
  description: string
  verifier_json: string
  required_artifacts_json: string
  priority: number
  owner: string | null
}

interface DependencyRow {
  dependency_card_id: number
  blocking_reason: string
  completion_condition: DependencyCompletionCondition
}

const CORE_FIELDS = new Set<keyof PutTaskContract>([
  'objective',
  'deliverables',
  'acceptance_criteria',
  'dependencies',
  'base_ref',
  'verify_commands',
  'non_goals',
  'risks',
  'budget_tokens',
  'budget_cents',
  'priority',
  'policy_id',
  'workspace_id',
])

const STATUS_TRANSITIONS: Record<JobMarketStatus, readonly JobMarketStatus[]> = {
  draft: ['open', 'cancelled', 'archived'],
  open: ['assigned', 'cancelled', 'archived'],
  assigned: ['open', 'running', 'cancelled', 'archived'],
  running: ['submitted', 'cancelled'],
  submitted: ['running', 'accepted', 'rejected', 'cancelled'],
  accepted: ['archived'],
  rejected: ['draft', 'open', 'archived'],
  cancelled: ['draft', 'open', 'archived'],
  archived: [],
}

const ACCESS_RANK: Record<ContractAccessNeed, number> = {
  read_only: 0,
  workspace_write: 1,
  full_access: 2,
}

/**
 * Additive typed layer around the compatibility TaskContractService.
 *
 * Existing task-contract JSON remains the source for legacy fields. This service owns
 * only Job Market extensions, validation, lifecycle, and field-level audit events.
 */
export class JobMarketService {
  private readonly contracts: TaskContractService

  constructor(
    private readonly db: Database.Database,
    private readonly events?: EventStore,
  ) {
    this.contracts = new TaskContractService(db, events)
  }

  get(cardId: number): JobMarketContract {
    const contract = this.contracts.getOrCreate(cardId)
    this.ensureMarketRecord(contract)
    this.ensureCriterionRecords(contract)
    this.ensureDependencyRecords(contract)
    return this.read(contract)
  }

  update(cardId: number, input: Record<string, unknown>, actor = 'human'): JobMarketContract {
    const save = this.db.transaction(() => {
      if (input.status !== undefined) {
        throw new ValidationError('status is lifecycle-controlled; use the contract transition endpoint')
      }
      const before = this.get(cardId)
      const dependencyRules = input.dependency_rules === undefined && input.dependencyRules === undefined
        ? null
        : normalizeDependencyRules(input.dependency_rules ?? input.dependencyRules)
      const budgets = optionalRecordInput(input.budgets, 'budgets')
      const coreInput = Object.fromEntries(
        Object.entries(input).filter(([key]) => CORE_FIELDS.has(key as keyof PutTaskContract)),
      ) as PutTaskContract
      if (coreInput.budget_tokens === undefined && budgets.tokens !== undefined) {
        coreInput.budget_tokens = budgets.tokens
      }
      if (coreInput.budget_cents === undefined && budgets.cost_cents !== undefined) {
        coreInput.budget_cents = budgets.cost_cents
      }
      if (dependencyRules) coreInput.dependencies = dependencyRules.map((dependency) => dependency.card_id)
      const contract = this.contracts.put(cardId, coreInput)

      this.updateMarketRecord(contract, input)
      this.updateCriteria(contract, input.acceptance_criteria)
      this.updateDependencies(contract, dependencyRules)

      const after = this.read(contract)
      const changes = auditChanges(before, after)
      if (changes.length) {
        const at = timestamp()
        this.db.prepare('UPDATE job_market_contracts SET version=version+1, updated_at=? WHERE card_id=?')
          .run(at, cardId)
      }
      const result = changes.length ? this.read(contract) : after
      for (const change of changes) this.audit(result, change.kind, actor, change.before, change.after)
      return result
    })
    return save.immediate()
  }

  validate(
    cardId: number,
    mode: 'publish' | 'launch' = 'publish',
    launch?: LaunchContractContext,
  ): ContractValidation {
    const market = this.get(cardId)
    const errors: string[] = []
    const warnings: string[] = []
    const contract = market.contract

    if (!contract.objective.trim()) errors.push('objective is required')
    if (!contract.deliverables.length) errors.push('at least one deliverable is required')
    if (!market.criteria.length) errors.push('at least one acceptance criterion is required')
    for (const criterion of market.criteria) {
      if (!criterion.description.trim()) errors.push(`criterion ${criterion.id} needs a description`)
      if (!criterion.verifier.kind) errors.push(`criterion ${criterion.id} needs a verifier`)
      if (criterion.verifier.kind === 'command' && !criterion.verifier.command?.trim()) {
        errors.push(`criterion ${criterion.id} command verifier needs a command`)
      }
      if (criterion.verifier.kind === 'artifact' && !criterion.verifier.artifact_kind?.trim()) {
        errors.push(`criterion ${criterion.id} artifact verifier needs artifact_kind`)
      }
      for (const artifact of criterion.required_artifacts) {
        if (!artifact.kind.trim()) errors.push(`criterion ${criterion.id} has an artifact without a kind`)
      }
    }
    if (market.dependency_rules.length !== contract.dependencies.length) {
      errors.push('every dependency needs a blocking reason and completion condition')
    }
    const sourceBoardId = boardIdForCard(this.db, cardId)
    for (const dependency of market.dependency_rules) {
      if (!dependency.blocking_reason.trim()) {
        errors.push(`dependency ${dependency.card_id} needs a blocking reason`)
      }
      if (dependency.completion_condition !== 'card_done') {
        errors.push(`dependency ${dependency.card_id} has an unsupported completion condition`)
      }
      const dependencyCard = this.db.prepare('SELECT board_id, column_name FROM cards WHERE id=?')
        .get(dependency.card_id) as { board_id: number; column_name: string } | undefined
      if (!dependencyCard) {
        errors.push(`dependency ${dependency.card_id} does not exist`)
      } else if (dependencyCard.board_id !== sourceBoardId) {
        errors.push(`dependency ${dependency.card_id} belongs to a different board`)
      } else if (dependencyCard.column_name !== 'done') {
        errors.push(`dependency ${dependency.card_id} is not complete`)
      }
    }
    for (const [label, value] of [
      ['token budget', market.budgets.tokens],
      ['cost budget', market.budgets.cost_cents],
      ['time budget', market.budgets.time_seconds],
      ['coordination token budget', market.budgets.coordination_tokens],
      ['coordination message budget', market.budgets.coordination_messages],
    ] as const) {
      if (value !== null && value <= 0) errors.push(`${label} must be positive`)
    }
    if (market.budgets.retries !== null && market.budgets.retries < 0) {
      errors.push('retry budget must be non-negative')
    }
    if (market.constraints.required_capabilities.length) {
      warnings.push('required capabilities are declared; automatic capability matching is a later scheduler concern')
    }

    if (mode === 'launch') {
      if (!['open', 'assigned'].includes(market.status)) {
        errors.push(`contract status ${market.status} cannot launch`)
      }
      if (!launch) {
        errors.push('launch validation requires provider, model, and access profile')
      } else {
        if (!Object.hasOwn(ACCESS_RANK, launch.accessProfile)) {
          errors.push(`access profile ${launch.accessProfile} is invalid`)
        }
        if (market.constraints.provider_constraints.length
          && !market.constraints.provider_constraints.includes(launch.provider)) {
          errors.push(`provider ${launch.provider} is not allowed by the contract`)
        }
        if (market.constraints.model_constraints.length
          && (!launch.model || !market.constraints.model_constraints.includes(launch.model))) {
          errors.push(`model ${launch.model ?? '(default)'} is not allowed by the contract`)
        }
        const requiredAccess = market.constraints.access_needs.reduce(
          (rank, access) => Math.max(rank, ACCESS_RANK[access]),
          0,
        )
        if (ACCESS_RANK[launch.accessProfile] < requiredAccess) {
          errors.push(`access profile ${launch.accessProfile} does not satisfy contract access needs`)
        }
      }
    }

    return { mode, valid: errors.length === 0, errors, warnings }
  }

  assertLaunchable(cardId: number, launch: LaunchContractContext): void {
    const validation = this.validate(cardId, 'launch', launch)
    if (!validation.valid) {
      throw new ValidationError(`job contract is not launchable: ${validation.errors.join('; ')}`)
    }
  }

  publish(cardId: number, actor = 'human'): JobMarketContract {
    const publish = this.db.transaction(() => {
      const current = this.get(cardId)
      const validation = this.validate(cardId, 'publish')
      if (!validation.valid) {
        throw new ValidationError(`job contract is not publishable: ${validation.errors.join('; ')}`)
      }
      if (current.status === 'open') return current
      if (!['draft', 'rejected', 'cancelled'].includes(current.status)) {
        throw new ConflictError(`contract in ${current.status} cannot be published`)
      }
      return this.setStatus(current, 'open', actor, 'contract published')
    })
    return publish.immediate()
  }

  transition(cardId: number, status: JobMarketStatus, actor = 'human', reason?: string): JobMarketContract {
    if (!JOB_MARKET_STATUSES.includes(status)) throw new ValidationError('invalid job contract status')
    const transition = this.db.transaction(() => {
      const current = this.get(cardId)
      if (status === 'assigned') {
        throw new ConflictError(
          'use the canonical job assignment claim or assign command to assign this contract',
        )
      }
      if (current.status === status) return current
      if (!STATUS_TRANSITIONS[current.status].includes(status)) {
        throw new ConflictError(`contract cannot transition from ${current.status} to ${status}`)
      }
      if (status === 'open') {
        const validation = this.validate(cardId, 'publish')
        if (!validation.valid) {
          throw new ValidationError(`job contract is not publishable: ${validation.errors.join('; ')}`)
        }
      }
      return this.setStatus(current, status, actor, reason)
    })
    return transition.immediate()
  }

  private setStatus(
    current: JobMarketContract,
    status: JobMarketStatus,
    actor: string,
    reason?: string,
  ): JobMarketContract {
    if (
      ['open', 'draft'].includes(status)
      && this.db.prepare(`SELECT 1 FROM job_market_assignments
        WHERE card_id=? AND status='active' LIMIT 1`).get(current.card_id)
    ) {
      throw new ConflictError(
        'release the active job market assignment before reopening or drafting the contract',
      )
    }
    const at = timestamp()
    const updated = this.db.prepare(`UPDATE job_market_contracts SET status=?, version=version+1, updated_at=?,
      published_at=CASE WHEN ?='open' THEN COALESCE(published_at, ?) ELSE published_at END,
      archived_at=CASE WHEN ?='archived' THEN ? ELSE NULL END
      WHERE card_id=? AND status=? AND version=?`)
      .run(
        status,
        at,
        status,
        at,
        status,
        at,
        current.card_id,
        current.status,
        current.market_version,
      )
    if (updated.changes !== 1) {
      throw new ConflictError('contract lifecycle changed concurrently; reload and retry')
    }
    const result = this.get(current.card_id)
    this.audit(result, 'job_market.lifecycle_changed', actor, current.status, status, reason)
    return result
  }

  private ensureMarketRecord(contract: TaskContract): void {
    const at = timestamp()
    this.db.prepare(`INSERT OR IGNORE INTO job_market_contracts (
      card_id, status, required_capabilities_json, provider_constraints_json,
      model_constraints_json, access_needs_json, budget_time_seconds, budget_retries,
      budget_coordination_tokens, budget_coordination_messages, version,
      published_at, archived_at, created_at, updated_at
    ) VALUES (?, 'open', '[]', '[]', '[]', '[]', NULL, NULL, NULL, NULL, 1, ?, NULL, ?, ?)`)
      .run(contract.card_id, at, at, at)
  }

  private ensureCriterionRecords(contract: TaskContract): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO job_market_criteria (
      card_id, criterion_id, description, verifier_json, required_artifacts_json,
      priority, owner, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    const at = timestamp()
    for (const criterion of contract.acceptance_criteria) {
      const extension = criterionExtension(criterion, contract)
      insert.run(
        contract.card_id,
        criterion.id,
        extension.description,
        JSON.stringify(extension.verifier),
        JSON.stringify(extension.required_artifacts),
        extension.priority,
        extension.owner,
        at,
      )
    }
  }

  private ensureDependencyRecords(contract: TaskContract): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO job_market_dependencies (
      card_id, dependency_card_id, blocking_reason, completion_condition, updated_at
    ) VALUES (?, ?, ?, 'card_done', ?)`)
    const at = timestamp()
    const boardId = boardIdForCard(this.db, contract.card_id)
    const dependencyBoard = this.db.prepare('SELECT board_id FROM cards WHERE id=?')
    for (const dependency of contract.dependencies) {
      const row = dependencyBoard.get(dependency) as { board_id: number } | undefined
      if (!row || row.board_id !== boardId) continue
      insert.run(contract.card_id, dependency, 'Dependency card must be completed before this job starts.', at)
    }
  }

  private updateMarketRecord(contract: TaskContract, input: Record<string, unknown>): void {
    const current = this.marketRow(contract.card_id)
    const constraints = optionalRecordInput(input.constraints, 'constraints')
    const budgets = optionalRecordInput(input.budgets, 'budgets')
    const requiredCapabilities = optionalStringList(
      input.required_capabilities
        ?? input.requiredCapabilities
        ?? constraints.required_capabilities
        ?? constraints.requiredCapabilities,
      'required_capabilities',
      parseJson(current.required_capabilities_json, []),
    )
    const providers = optionalStringList(
      input.provider_constraints
        ?? input.providerConstraints
        ?? constraints.provider_constraints
        ?? constraints.providerConstraints
        ?? constraints.providers,
      'provider_constraints',
      parseJson(current.provider_constraints_json, []),
    )
    const models = optionalStringList(
      input.model_constraints
        ?? input.modelConstraints
        ?? constraints.model_constraints
        ?? constraints.modelConstraints
        ?? constraints.models,
      'model_constraints',
      parseJson(current.model_constraints_json, []),
    )
    const access = optionalAccessNeeds(
      input.access_needs
        ?? input.accessNeeds
        ?? constraints.access_needs
        ?? constraints.accessNeeds
        ?? constraints.access,
      parseJson(current.access_needs_json, []),
    )
    const time = optionalBudget(
      input.budget_time_seconds ?? input.budgetTimeSeconds ?? budgets.time_seconds,
      'budget_time_seconds',
      current.budget_time_seconds,
      false,
    )
    const retries = optionalBudget(
      input.budget_retries ?? input.budgetRetries ?? budgets.retries,
      'budget_retries',
      current.budget_retries,
      true,
    )
    const coordinationTokens = optionalBudget(
      input.budget_coordination_tokens ?? input.budgetCoordinationTokens ?? budgets.coordination_tokens,
      'budget_coordination_tokens',
      current.budget_coordination_tokens,
      false,
    )
    const coordinationMessages = optionalBudget(
      input.budget_coordination_messages ?? input.budgetCoordinationMessages ?? budgets.coordination_messages,
      'budget_coordination_messages',
      current.budget_coordination_messages,
      false,
    )
    this.db.prepare(`UPDATE job_market_contracts SET
      required_capabilities_json=?, provider_constraints_json=?, model_constraints_json=?,
      access_needs_json=?, budget_time_seconds=?, budget_retries=?,
      budget_coordination_tokens=?, budget_coordination_messages=?
      WHERE card_id=?`).run(
      JSON.stringify(requiredCapabilities),
      JSON.stringify(providers),
      JSON.stringify(models),
      JSON.stringify(access),
      time,
      retries,
      coordinationTokens,
      coordinationMessages,
      contract.card_id,
    )
  }

  private updateCriteria(contract: TaskContract, rawCriteria: unknown): void {
    if (rawCriteria === undefined) {
      this.deleteStaleCriteria(contract)
      this.ensureCriterionRecords(contract)
      return
    }
    if (!Array.isArray(rawCriteria)) throw new ValidationError('acceptance_criteria must be an array')
    const current = new Map(
      this.criterionRows(contract.card_id).map((row) => [row.criterion_id, row]),
    )
    const upsert = this.db.prepare(`INSERT INTO job_market_criteria (
      card_id, criterion_id, description, verifier_json, required_artifacts_json,
      priority, owner, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id, criterion_id) DO UPDATE SET
      description=excluded.description,
      verifier_json=excluded.verifier_json,
      required_artifacts_json=excluded.required_artifacts_json,
      priority=excluded.priority,
      owner=excluded.owner,
      updated_at=excluded.updated_at`)
    const at = timestamp()
    for (const [index, criterion] of contract.acceptance_criteria.entries()) {
      const input = recordInput(rawCriteria[index])
      const existing = current.get(criterion.id)
      const fallback = criterionExtension(criterion, contract)
      const description = boundedText(
        input.description,
        `acceptance_criteria[${index}].description`,
        existing?.description ?? fallback.description,
        4_000,
      )
      const verifier = input.verifier === undefined
        ? parseJson(existing?.verifier_json, fallback.verifier)
        : normalizeVerifier(input.verifier)
      const artifacts = input.required_artifacts === undefined && input.requiredArtifacts === undefined
        ? parseJson(existing?.required_artifacts_json, fallback.required_artifacts)
        : normalizeArtifacts(input.required_artifacts ?? input.requiredArtifacts)
      const priority = input.priority === undefined
        ? existing?.priority ?? fallback.priority
        : boundedInteger(input.priority, `acceptance_criteria[${index}].priority`, -1_000, 1_000)
      const owner = input.owner === undefined
        ? existing?.owner ?? fallback.owner
        : nullableText(input.owner, `acceptance_criteria[${index}].owner`, 200)
      upsert.run(
        contract.card_id,
        criterion.id,
        description,
        JSON.stringify(verifier),
        JSON.stringify(artifacts),
        priority,
        owner,
        at,
      )
    }
    this.deleteStaleCriteria(contract)
  }

  private updateDependencies(contract: TaskContract, rules: JobMarketDependency[] | null): void {
    const current = new Map(
      this.dependencyRows(contract.card_id).map((row) => [row.dependency_card_id, row]),
    )
    const byCard = new Map(rules?.map((rule) => [rule.card_id, rule]) ?? [])
    const upsert = this.db.prepare(`INSERT INTO job_market_dependencies (
      card_id, dependency_card_id, blocking_reason, completion_condition, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(card_id, dependency_card_id) DO UPDATE SET
      blocking_reason=excluded.blocking_reason,
      completion_condition=excluded.completion_condition,
      updated_at=excluded.updated_at`)
    const at = timestamp()
    for (const dependency of contract.dependencies) {
      const provided = byCard.get(dependency)
      const existing = current.get(dependency)
      upsert.run(
        contract.card_id,
        dependency,
        provided?.blocking_reason
          ?? existing?.blocking_reason
          ?? 'Dependency card must be completed before this job starts.',
        provided?.completion_condition ?? existing?.completion_condition ?? 'card_done',
        at,
      )
    }
    this.deleteStaleDependencies(contract)
  }

  private deleteStaleCriteria(contract: TaskContract): void {
    deleteMissing(
      this.db,
      'job_market_criteria',
      'criterion_id',
      contract.card_id,
      contract.acceptance_criteria.map((criterion) => criterion.id),
    )
  }

  private deleteStaleDependencies(contract: TaskContract): void {
    deleteMissing(
      this.db,
      'job_market_dependencies',
      'dependency_card_id',
      contract.card_id,
      contract.dependencies,
    )
  }

  private read(contract: TaskContract): JobMarketContract {
    const market = this.marketRow(contract.card_id)
    const criterionRows = new Map(
      this.criterionRows(contract.card_id).map((row) => [row.criterion_id, row]),
    )
    const criteria = contract.acceptance_criteria.map((criterion) => {
      const row = criterionRows.get(criterion.id)
      const fallback = criterionExtension(criterion, contract)
      return {
        ...criterion,
        description: row?.description ?? fallback.description,
        verifier: parseJson(row?.verifier_json, fallback.verifier),
        required_artifacts: parseJson(row?.required_artifacts_json, fallback.required_artifacts),
        priority: row?.priority ?? fallback.priority,
        owner: row?.owner ?? fallback.owner,
      }
    })
    const dependencies = new Map(
      this.dependencyRows(contract.card_id).map((row) => [row.dependency_card_id, row]),
    )
    return {
      card_id: contract.card_id,
      status: market.status,
      market_version: market.version,
      contract,
      criteria,
      dependency_rules: contract.dependencies.map((cardId) => {
        const row = dependencies.get(cardId)
        return {
          card_id: cardId,
          blocking_reason: row?.blocking_reason
            ?? 'Dependency card must be completed before this job starts.',
          completion_condition: row?.completion_condition ?? 'card_done',
        }
      }),
      constraints: {
        required_capabilities: parseJson(market.required_capabilities_json, []),
        provider_constraints: parseJson(market.provider_constraints_json, []),
        model_constraints: parseJson(market.model_constraints_json, []),
        access_needs: parseJson(market.access_needs_json, []),
      },
      budgets: {
        tokens: contract.budget_tokens,
        cost_cents: contract.budget_cents,
        time_seconds: market.budget_time_seconds,
        retries: market.budget_retries,
        coordination_tokens: market.budget_coordination_tokens,
        coordination_messages: market.budget_coordination_messages,
      },
      published_at: market.published_at,
      archived_at: market.archived_at,
      created_at: market.created_at,
      updated_at: market.updated_at,
    }
  }

  private marketRow(cardId: number): MarketRow {
    const row = this.db.prepare('SELECT * FROM job_market_contracts WHERE card_id=?')
      .get(cardId) as MarketRow | undefined
    if (!row) throw new NotFoundError('job market contract not found')
    return row
  }

  private criterionRows(cardId: number): CriterionRow[] {
    return this.db.prepare(`SELECT criterion_id, description, verifier_json,
      required_artifacts_json, priority, owner
      FROM job_market_criteria WHERE card_id=? ORDER BY rowid`).all(cardId) as CriterionRow[]
  }

  private dependencyRows(cardId: number): DependencyRow[] {
    return this.db.prepare(`SELECT dependency_card_id, blocking_reason, completion_condition
      FROM job_market_dependencies WHERE card_id=? ORDER BY rowid`).all(cardId) as DependencyRow[]
  }

  private audit(
    market: JobMarketContract,
    kind: string,
    actor: string,
    before: unknown,
    after: unknown,
    reason?: string,
  ): void {
    this.events?.append({
      boardId: boardIdForCard(this.db, market.card_id),
      workspaceId: market.contract.workspace_id,
      cardId: market.card_id,
      contractId: `card:${market.card_id}:v${market.contract.version}`,
      kind,
      source: 'job-market',
      payload: {
        actor: actor.trim() || 'human',
        reason: reason?.trim() || null,
        market_version: market.market_version,
        before,
        after,
      },
    })
  }
}

function criterionExtension(
  criterion: ContractAcceptanceCriterion,
  contract: TaskContract,
): Pick<JobMarketCriterion, 'description' | 'verifier' | 'required_artifacts' | 'priority' | 'owner'> {
  const metadata = criterion.metadata
  const description = typeof metadata.description === 'string' && metadata.description.trim()
    ? metadata.description.trim()
    : criterion.text
  let verifier = defaultVerifier(contract)
  if (metadata.verifier !== undefined) {
    try { verifier = normalizeVerifier(metadata.verifier) } catch { /* legacy metadata remains inert */ }
  }
  let requiredArtifacts: RequiredArtifact[] = []
  if (metadata.required_artifacts !== undefined) {
    try { requiredArtifacts = normalizeArtifacts(metadata.required_artifacts) } catch { /* compatibility default */ }
  }
  const priority = Number.isSafeInteger(metadata.priority) ? Number(metadata.priority) : 0
  const owner = typeof metadata.owner === 'string' && metadata.owner.trim()
    ? metadata.owner.trim()
    : null
  return {
    description,
    verifier,
    required_artifacts: requiredArtifacts,
    priority,
    owner,
  }
}

function defaultVerifier(contract: TaskContract): CriterionVerifier {
  const command = contract.verify_commands.find((candidate) => candidate.trim())
  return command ? { kind: 'command', command } : { kind: 'human' }
}

function normalizeVerifier(value: unknown): CriterionVerifier {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('criterion verifier must be an object')
  }
  const row = value as Record<string, unknown>
  const kind = boundedText(row.kind, 'criterion verifier kind', '', 40)
  if (!['command', 'artifact', 'human', 'custom'].includes(kind)) {
    throw new ValidationError('criterion verifier kind must be command, artifact, human, or custom')
  }
  const verifier: CriterionVerifier = { kind: kind as CriterionVerifier['kind'] }
  if (row.command !== undefined) verifier.command = boundedText(row.command, 'criterion verifier command', '', 8_000)
  if (row.artifact_kind !== undefined || row.artifactKind !== undefined) {
    verifier.artifact_kind = boundedText(
      row.artifact_kind ?? row.artifactKind,
      'criterion verifier artifact_kind',
      '',
      120,
    )
  }
  if (row.instructions !== undefined) {
    verifier.instructions = boundedText(row.instructions, 'criterion verifier instructions', '', 4_000)
  }
  return verifier
}

function normalizeArtifacts(value: unknown): RequiredArtifact[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ValidationError('required_artifacts must be an array of at most 100 records')
  }
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return { kind: boundedText(item, `required_artifacts[${index}]`, '', 120), name: null, description: null }
    }
    const row = recordInput(item)
    return {
      kind: boundedText(row.kind, `required_artifacts[${index}].kind`, '', 120),
      name: nullableText(row.name, `required_artifacts[${index}].name`, 240),
      description: nullableText(row.description, `required_artifacts[${index}].description`, 2_000),
    }
  })
}

function normalizeDependencyRules(value: unknown): JobMarketDependency[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new ValidationError('dependency_rules must be an array of at most 200 records')
  }
  const seen = new Set<number>()
  return value.map((item, index) => {
    const row = recordInput(item)
    const cardId = Number(row.card_id ?? row.cardId)
    if (!Number.isSafeInteger(cardId) || cardId <= 0) {
      throw new ValidationError(`dependency_rules[${index}].card_id must be a positive integer`)
    }
    if (seen.has(cardId)) throw new ValidationError('dependency_rules card ids must be unique')
    seen.add(cardId)
    const condition = boundedText(
      row.completion_condition ?? row.completionCondition,
      `dependency_rules[${index}].completion_condition`,
      '',
      80,
    )
    if (condition !== 'card_done') {
      throw new ValidationError('dependency completion_condition must be card_done')
    }
    return {
      card_id: cardId,
      blocking_reason: boundedText(
        row.blocking_reason ?? row.blockingReason,
        `dependency_rules[${index}].blocking_reason`,
        '',
        2_000,
      ),
      completion_condition: 'card_done',
    }
  })
}

function auditChanges(
  before: JobMarketContract,
  after: JobMarketContract,
): Array<{ kind: string; before: unknown; after: unknown }> {
  const groups = [
    {
      kind: 'job_market.scope_changed',
      before: {
        objective: before.contract.objective,
        deliverables: before.contract.deliverables,
        base_ref: before.contract.base_ref,
        verify_commands: before.contract.verify_commands,
        non_goals: before.contract.non_goals,
        risks: before.contract.risks,
        priority: before.contract.priority,
        policy_id: before.contract.policy_id,
        workspace_id: before.contract.workspace_id,
        constraints: before.constraints,
      },
      after: {
        objective: after.contract.objective,
        deliverables: after.contract.deliverables,
        base_ref: after.contract.base_ref,
        verify_commands: after.contract.verify_commands,
        non_goals: after.contract.non_goals,
        risks: after.contract.risks,
        priority: after.contract.priority,
        policy_id: after.contract.policy_id,
        workspace_id: after.contract.workspace_id,
        constraints: after.constraints,
      },
    },
    {
      kind: 'job_market.criterion_changed',
      before: before.criteria.map(withoutOwner),
      after: after.criteria.map(withoutOwner),
    },
    {
      kind: 'job_market.owner_changed',
      before: before.criteria.map((criterion) => ({ criterion_id: criterion.id, owner: criterion.owner })),
      after: after.criteria.map((criterion) => ({ criterion_id: criterion.id, owner: criterion.owner })),
    },
    {
      kind: 'job_market.dependency_changed',
      before: before.dependency_rules,
      after: after.dependency_rules,
    },
    {
      kind: 'job_market.budget_changed',
      before: before.budgets,
      after: after.budgets,
    },
  ]
  return groups.filter((group) => stable(group.before) !== stable(group.after))
}

function withoutOwner(criterion: JobMarketCriterion): Omit<JobMarketCriterion, 'owner'> {
  const { owner: _owner, ...rest } = criterion
  const { owner: _metadataOwner, ...metadata } = rest.metadata
  return { ...rest, metadata }
}

function optionalStringList(
  value: unknown,
  field: string,
  fallback: string[],
): string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${field} must be an array of at most 100 strings`)
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
}

function optionalAccessNeeds(value: unknown, fallback: ContractAccessNeed[]): ContractAccessNeed[] {
  const access = optionalStringList(value, 'access_needs', fallback)
  if (access.some((item) => !Object.hasOwn(ACCESS_RANK, item))) {
    throw new ValidationError('access_needs must contain read_only, workspace_write, or full_access')
  }
  return access as ContractAccessNeed[]
}

function optionalBudget(
  value: unknown,
  field: string,
  fallback: number | null,
  allowZero: boolean,
): number | null {
  if (value === undefined) return fallback
  if (value === null || value === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new ValidationError(`${field} must be ${allowZero ? 'a non-negative' : 'a positive'} integer or null`)
  }
  return parsed
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`${field} must be an integer from ${min} to ${max}`)
  }
  return parsed
}

function boundedText(
  value: unknown,
  field: string,
  fallback: string,
  max: number,
): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`)
  const text = value.trim()
  if (text.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  return text
}

function nullableText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string or null`)
  const text = value.trim()
  if (!text) return null
  if (text.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  return text
}

function recordInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function optionalRecordInput(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function deleteMissing(
  db: Database.Database,
  table: 'job_market_criteria' | 'job_market_dependencies',
  column: 'criterion_id' | 'dependency_card_id',
  cardId: number,
  values: Array<string | number>,
): void {
  if (!values.length) {
    db.prepare(`DELETE FROM ${table} WHERE card_id=?`).run(cardId)
    return
  }
  const placeholders = values.map(() => '?').join(',')
  db.prepare(`DELETE FROM ${table} WHERE card_id=? AND ${column} NOT IN (${placeholders})`)
    .run(cardId, ...values)
}

function boardIdForCard(db: Database.Database, cardId: number): number {
  const row = db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as { board_id: number } | undefined
  if (!row) throw new NotFoundError('card not found')
  return row.board_id
}

function stable(value: unknown): string {
  return JSON.stringify(sort(value))
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sort(item)]),
    )
  }
  return value
}
