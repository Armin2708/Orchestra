import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ActorIdentity } from './agent-home-support.js'
import {
  renderAgentBrief,
  type AgentBriefBlockerPath,
  type AgentBriefDependency,
  type AgentBriefSelection,
} from './agent-brief.js'
import { ConflictError, NotFoundError, UnsupportedError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import {
  JobAssignmentService,
  type JobAssignmentCommandResult,
  type JobMarketAssignment,
} from './job-assignments.js'
import {
  JOB_MARKET_STATUSES,
  JobMarketService,
  type ContractAccessNeed,
  type ContractValidation,
  type CriterionVerifier,
  type JobMarketBudgets,
  type JobMarketConstraints,
  type JobMarketContract,
  type JobMarketCriterion,
  type JobMarketDependency,
  type JobMarketStatus,
  type RequiredArtifact,
} from './job-market.js'
import type {
  LaunchCardJobResult,
  OrchestrationService,
} from './orchestration-service.js'
import type {
  ContractAcceptanceCriterion,
  ContractDeliverable,
  TaskContract,
} from './task-contracts.js'
import type { RenderedAgentBrief } from './agent-brief.js'

export type DependencyReadiness = 'ready' | 'blocked'

export interface OpenWorkQuery {
  boardId?: number
  repository?: string
  capabilities?: readonly string[]
  priority?: number
  dependencyReadiness?: DependencyReadiness
  maxTokens?: number
  maxCostCents?: number
  maxTimeSeconds?: number
}

export interface OpenWorkDependency extends AgentBriefDependency {
  completion_condition: 'card_done'
}

export interface OpenWorkGraphNode {
  card_id: number
  board_id: number
  title: string
  state: string
  readiness: DependencyReadiness
  blocking_reasons: string[]
}

export interface OpenWorkGraphEdge {
  from_card_id: number
  to_card_id: number
  blocking_reason: string
  completion_condition: 'card_done'
  readiness: DependencyReadiness
}

export interface OpenWorkGraph {
  nodes: OpenWorkGraphNode[]
  edges: OpenWorkGraphEdge[]
}

export interface CapacityEvidence {
  active: number
  limit: number
  available: number
}

export interface OpenWorkAgentCandidate {
  profile_id: string
  name: string
  provider: string | null
  model: string | null
  access_profile: ContractAccessNeed | null
  workspace_id: string | null
  capabilities: string[]
  eligible: boolean
  ineligibility_reasons: string[]
  capacity: CapacityEvidence
}

export interface OpenWorkMatch {
  card_id: number
  board_id: number
  market_version: number
  eligible: boolean
  eligible_agent_count: number
  selected_agent: OpenWorkAgentCandidate | null
  candidates: OpenWorkAgentCandidate[]
  global_capacity: CapacityEvidence
  agent_brief_sha256: string | null
  decision_sha256: string | null
}

export interface OpenWorkDispatchMatch {
  card_id: number
  market_version: number
  profile_id: string
  provider: string
  model: string
  access_profile: ContractAccessNeed
  workspace_id: string
  agent_brief_sha256: string
  decision_sha256: string
}

export interface OpenWorkItem {
  card_id: number
  board_id: number
  title: string
  repository: string
  status: 'open'
  market_version: number
  priority: number
  constraints: JobMarketConstraints
  budgets: JobMarketBudgets
  dependency_readiness: DependencyReadiness
  dependencies: OpenWorkDependency[]
  critical_path: AgentBriefBlockerPath[]
  eligible_agent_count: number
  selected_agent: OpenWorkAgentCandidate | null
}

export interface OpenWorkResult {
  items: OpenWorkItem[]
  graph: OpenWorkGraph
}

export interface OpenWorkPreview {
  job_market: JobMarketContract
  validation: ContractValidation
  agent_brief: string
  agent_brief_sha256: string
}

export interface OpenWorkDispatchResult {
  replayed: boolean
  match: OpenWorkDispatchMatch
  assignment: JobMarketAssignment
  job: LaunchCardJobResult['job']
  dispatch: LaunchCardJobResult['dispatch'] & { error: string | null }
  agent_brief: string
  agent_brief_sha256: string
}

export interface OpenWorkServiceOptions {
  orchestration?: Pick<OrchestrationService, 'createCardJob' | 'launchCard'>
  supportedProviders?: readonly string[]
  globalCapacity?: number
  perProfileCapacity?: number
}

interface CardScope {
  card_id: number
  board_id: number
  title: string
  state: string
  owner_agent_id: number | null
  repository: string
}

interface LoadedMarket {
  scope: CardScope
  market: JobMarketContract
}

interface GraphCard {
  card_id: number
  board_id: number
  title: string
  state: string
}

interface GraphDependency {
  from_card_id: number
  to_card_id: number
  blocking_reason: string
  completion_condition: 'card_done'
}

interface GraphState {
  cards: Map<number, GraphCard>
  edges: GraphDependency[]
  edgesBySource: Map<number, GraphDependency[]>
}

interface ProfileRow {
  id: string
  name: string
  default_provider: string | null
  default_model: string | null
  default_access_profile: string | null
  capabilities_json: string
}

interface AssignmentReplayRow {
  assigned_market_version: number
}

const ACCESS_RANK: Record<ContractAccessNeed, number> = {
  read_only: 0,
  workspace_write: 1,
  full_access: 2,
}

const DEFAULT_GLOBAL_CAPACITY = 3
const DEFAULT_PROFILE_CAPACITY = 1

export class OpenWorkService {
  private readonly assignments: JobAssignmentService
  private readonly market: JobMarketService
  private readonly orchestration?: Pick<OrchestrationService, 'createCardJob' | 'launchCard'>
  private readonly supportedProviders: ReadonlySet<string>
  private readonly globalCapacityOverride: number | undefined
  private readonly perProfileCapacity: number

  constructor(
    private readonly db: Database.Database,
    options: OpenWorkServiceOptions = {},
  ) {
    this.assignments = new JobAssignmentService(db)
    this.market = new JobMarketService(db, new EventStore(db))
    this.orchestration = options.orchestration
    this.supportedProviders = new Set(
      (options.supportedProviders ?? []).map((provider) => provider.trim()).filter(Boolean),
    )
    this.globalCapacityOverride = optionalPositiveInteger(
      options.globalCapacity,
      'global capacity',
    )
    this.perProfileCapacity = optionalPositiveInteger(
      options.perProfileCapacity,
      'per-profile capacity',
    ) ?? DEFAULT_PROFILE_CAPACITY
  }

  query(input: OpenWorkQuery = {}): OpenWorkResult {
    const filters = normalizeQuery(input)
    const scopedBoardIds = this.resolveBoardScope(filters.boardId, filters.repository)
    const rows = this.openCardIds(scopedBoardIds)
    const loaded: LoadedMarket[] = []
    for (const row of rows) {
      try {
        const candidate = this.loadMarket(row.card_id)
        if (candidate.market.status !== 'open' || !candidate.market.published_at) continue
        assertStructurallyValid(this.db, candidate)
        loaded.push(candidate)
      } catch {
        // Open Work is fail-closed: malformed or stale contracts are never advertised.
      }
    }

    const graphBoardIds = scopedBoardIds
      ?? [...new Set(loaded.map((candidate) => candidate.scope.board_id))].sort(numberOrder)
    const graphState = this.graphState(graphBoardIds)
    const items = loaded
      .map((candidate) => this.openWorkItem(candidate, graphState))
      .filter((item) => matchesQuery(item, filters))
      .sort(itemOrder)
    return {
      items,
      graph: this.publicGraph(graphState),
    }
  }

  matchCard(
    cardId: number,
    expectedMarketVersion: number,
  ): OpenWorkMatch {
    const normalizedCardId = positiveInteger(cardId, 'card id')
    const loaded = this.requireMarket(normalizedCardId)
    if (loaded.market.status !== 'open' || !loaded.market.published_at) {
      throw new ConflictError('contract must be published and open before matching')
    }
    if (positiveInteger(expectedMarketVersion, 'expected market version')
      !== loaded.market.market_version) {
      throw new ConflictError(
        `job market version is stale; expected ${expectedMarketVersion},`
        + ` current ${loaded.market.market_version}`,
      )
    }
    const graph = this.graphState([loaded.scope.board_id])
    return this.matchLoaded(loaded, graph)
  }

  preview(
    cardId: number,
    draft: Record<string, unknown>,
    expectedMarketVersion: number,
  ): OpenWorkPreview {
    const normalizedCardId = positiveInteger(cardId, 'card id')
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new ValidationError('contract draft must be an object')
    }
    const expectedVersion = positiveInteger(
      expectedMarketVersion,
      'expected_market_version',
    )
    const rollback = Symbol('open-work-preview-rollback')
    let result: OpenWorkPreview | undefined
    try {
      const preview = this.db.transaction(() => {
        const current = this.market.get(normalizedCardId)
        if (expectedVersion !== current.market_version) {
          throw new ConflictError(
            `job market version is stale; expected ${expectedVersion}, current ${current.market_version}`,
          )
        }
        const jobMarket = Object.keys(draft).length
          ? this.market.update(normalizedCardId, draft, 'preview')
          : current
        const validation = this.market.validate(normalizedCardId, 'publish')
        const loaded = this.requireMarket(normalizedCardId)
        const graph = this.graphState([loaded.scope.board_id])
        const rendered = renderAgentBrief({
          job_market: jobMarket,
          repository: loaded.scope.repository,
          workspace_id: jobMarket.contract.workspace_id,
          dependencies: this.dependencies(normalizedCardId, graph),
          critical_path: criticalPaths(normalizedCardId, graph),
        })
        result = {
          job_market: jobMarket,
          validation,
          ...rendered,
        }
        throw rollback
      })
      preview.immediate()
    } catch (error) {
      if (error !== rollback) throw error
    }
    if (!result) throw new ConflictError('contract preview did not produce a result')
    return result
  }

  async dispatch(input: {
    match: OpenWorkDispatchMatch
    confirm: boolean
    actor: ActorIdentity
    idempotencyKey: string
  }): Promise<OpenWorkDispatchResult> {
    if (!this.orchestration) {
      throw new UnsupportedError('Open Work dispatch requires the canonical OrchestrationService')
    }
    if (input.confirm !== true) {
      throw new ValidationError('confirm must be true before dispatch')
    }
    const match = normalizeDispatchMatch(input.match)
    if (match.decision_sha256 !== decisionDigest(withoutDecision(match))) {
      throw new ConflictError('Open Work match decision digest is invalid')
    }
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const assignmentKey = derivedKey('assignment', idempotencyKey)
    const launchKey = derivedKey('launch', idempotencyKey)
    const assignmentReason = 'deterministic Open Work dispatch'
    let assignmentResult: JobAssignmentCommandResult | undefined
    let reservedBrief: RenderedAgentBrief | undefined

    const reserve = this.db.transaction(() => {
      const replay = this.assignmentReplay(match.card_id, assignmentKey)
      if (replay) {
        assignmentResult = this.assignments.assign({
          cardId: match.card_id,
          profileId: match.profile_id,
          workspaceId: match.workspace_id,
          expectedMarketVersion: replay.assigned_market_version - 1,
          actor: input.actor,
          idempotencyKey: assignmentKey,
          reason: assignmentReason,
        })
      } else {
        const loaded = this.requireMarket(match.card_id)
        if (loaded.market.status !== 'open' || !loaded.market.published_at) {
          throw new ConflictError('contract must be published and open before dispatch')
        }
        if (loaded.market.market_version !== match.market_version) {
          throw new ConflictError(
            `job market version is stale; expected ${match.market_version},`
            + ` current ${loaded.market.market_version}`,
          )
        }
        const currentMatch = this.matchLoaded(
          loaded,
          this.graphState([loaded.scope.board_id]),
        )
        const selected = currentMatch.selected_agent
        if (!selected || !currentMatch.decision_sha256) {
          throw new ConflictError('contract has no eligible agent at current capacity')
        }
        const expected = dispatchMatch(currentMatch)
        if (stable(expected) !== stable(match)) {
          throw new ConflictError('Open Work match is stale or no longer the deterministic winner')
        }
        assignmentResult = this.assignments.assign({
          cardId: match.card_id,
          profileId: match.profile_id,
          workspaceId: match.workspace_id,
          expectedMarketVersion: loaded.market.market_version,
          actor: input.actor,
          idempotencyKey: assignmentKey,
          reason: assignmentReason,
        })
      }

      const assignment = assignmentResult.assignment
      const created = this.orchestration!.createCardJob({
        cardId: match.card_id,
        expectedBoardId: assignment.board_id,
        requireLaunchable: true,
        provider: match.provider,
        model: match.model,
        accessProfile: match.access_profile,
        workspaceId: match.workspace_id,
        idempotencyKey: launchKey,
        expectedJobAssignment: {
          jobAssignmentId: assignment.id,
          assignedProfileId: assignment.profile_id,
          assignmentMarketVersion: assignment.assigned_market_version,
        },
      })
      const storedBrief = created.job.agent_brief
        && created.job.agent_brief_sha256
        ? {
            agent_brief: created.job.agent_brief,
            agent_brief_sha256: created.job.agent_brief_sha256,
          }
        : null
      if (storedBrief) {
        if (storedBrief.agent_brief_sha256 !== match.agent_brief_sha256
          || createHash('sha256').update(storedBrief.agent_brief).digest('hex')
            !== storedBrief.agent_brief_sha256) {
          throw new ConflictError('persisted Agent OS brief does not match dispatch evidence')
        }
        reservedBrief = storedBrief
      } else {
        const rendered = this.renderBrief(match.card_id, {
          job_id: created.job.id,
          delivery_id: created.delivery.id,
          workspace_id: created.workspace?.id ?? match.workspace_id,
          selection: selectionFromMatch(match),
        })
        if (rendered.agent_brief_sha256 !== match.agent_brief_sha256) {
          throw new ConflictError('Open Work brief preview is stale')
        }
        const persisted = this.db.prepare(`UPDATE jobs
          SET agent_brief=?, agent_brief_sha256=?
          WHERE id=? AND agent_brief IS NULL AND agent_brief_sha256 IS NULL`)
          .run(rendered.agent_brief, rendered.agent_brief_sha256, created.job.id)
        if (persisted.changes !== 1) {
          throw new ConflictError('Open Work brief persistence raced')
        }
        reservedBrief = rendered
      }
    })
    reserve.immediate()
    if (!assignmentResult) throw new ConflictError('Open Work assignment reservation failed')

    const assignment = assignmentResult.assignment
    const launched = await this.orchestration.launchCard({
      cardId: match.card_id,
      expectedBoardId: assignment.board_id,
      requireLaunchable: true,
      provider: match.provider,
      model: match.model,
      accessProfile: match.access_profile,
      workspaceId: match.workspace_id,
      idempotencyKey: launchKey,
      expectedJobAssignment: {
        jobAssignmentId: assignment.id,
        assignedProfileId: assignment.profile_id,
        assignmentMarketVersion: assignment.assigned_market_version,
      },
    })
    const rendered = launched.job.agent_brief && launched.job.agent_brief_sha256
      ? {
          agent_brief: launched.job.agent_brief,
          agent_brief_sha256: launched.job.agent_brief_sha256,
        }
      : reservedBrief ?? this.renderBrief(match.card_id, {
          job_id: launched.job.id,
          delivery_id: launched.delivery.id,
          workspace_id: launched.workspace?.id ?? match.workspace_id,
          selection: selectionFromMatch(match),
        })
    return {
      replayed: assignmentResult.replayed,
      match,
      assignment,
      job: launched.job,
      dispatch: {
        ...launched.dispatch,
        error: launched.dispatch_error,
      },
      ...rendered,
    }
  }

  renderBrief(
    cardId: number,
    input: {
      job_id: string
      delivery_id: string
      workspace_id: string | null
      selection: AgentBriefSelection | null
      contract?: TaskContract
    },
  ): RenderedAgentBrief {
    const normalizedCardId = positiveInteger(cardId, 'card id')
    const currentMarket = this.market.get(normalizedCardId)
    const loaded = input.contract
      ? {
          scope: this.cardScope(normalizedCardId),
          market: currentMarket,
        }
      : this.requireMarket(normalizedCardId)
    const graph = this.graphState([loaded.scope.board_id])
    const frozenContract = input.contract
    const jobMarket = frozenContract ? {
      ...loaded.market,
      contract: frozenContract,
      criteria: frozenContract.acceptance_criteria.map((criterion) => {
        return {
          ...criterion,
          description: criterion.text,
          verifier: { kind: 'human' as const },
          required_artifacts: [],
          priority: 0,
          owner: null,
        }
      }),
      dependency_rules: frozenContract.dependencies.map((dependency) => ({
        card_id: dependency,
        blocking_reason: 'Declared frozen dependency',
        completion_condition: 'card_done' as const,
      })),
      constraints: {
        required_capabilities: [],
        provider_constraints: [],
        model_constraints: [],
        access_needs: [],
      },
      budgets: {
        tokens: frozenContract.budget_tokens,
        cost_cents: frozenContract.budget_cents,
        time_seconds: null,
        retries: null,
        coordination_tokens: null,
        coordination_messages: null,
      },
    } : loaded.market
    const dependencies = frozenContract
      ? frozenContract.dependencies.map((dependency) => ({
          card_id: dependency,
          title: `Card ${dependency}`,
          state: 'frozen',
          blocking_reason: 'Declared frozen dependency',
          readiness: 'blocked' as const,
        }))
      : this.dependencies(cardId, graph)
    return renderAgentBrief({
      job_market: jobMarket,
      repository: loaded.scope.repository,
      ...input,
      dependencies,
      critical_path: frozenContract ? [] : criticalPaths(cardId, graph),
    })
  }

  private cardScope(cardId: number): CardScope {
    const scope = this.db.prepare(`SELECT card.id AS card_id, card.board_id, card.title,
      card.column_name AS state, card.owner_agent_id, board.project_path AS repository
      FROM cards card JOIN boards board ON board.id=card.board_id WHERE card.id=?`)
      .get(cardId) as CardScope | undefined
    if (!scope) throw new NotFoundError('card not found')
    return scope
  }

  private resolveBoardScope(
    boardId: number | undefined,
    repository: string | undefined,
  ): number[] | null {
    const normalizedBoardId = boardId === undefined
      ? undefined
      : positiveInteger(boardId, 'board id')
    const normalizedRepository = repository?.trim()
    let repositoryBoardId: number | undefined
    if (normalizedRepository) {
      const row = this.db.prepare('SELECT id FROM boards WHERE project_path=?')
        .get(normalizedRepository) as { id: number } | undefined
      if (!row) throw new NotFoundError('repository board not found')
      repositoryBoardId = row.id
    }
    if (normalizedBoardId !== undefined
      && !this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(normalizedBoardId)) {
      throw new NotFoundError('board not found')
    }
    if (normalizedBoardId !== undefined && repositoryBoardId !== undefined
      && normalizedBoardId !== repositoryBoardId) {
      throw new ValidationError('board_id and repository identify different boards')
    }
    const resolved = normalizedBoardId ?? repositoryBoardId
    return resolved === undefined ? null : [resolved]
  }

  private openCardIds(boardIds: number[] | null): Array<{ card_id: number }> {
    const where = [
      "market.status='open'",
      'market.published_at IS NOT NULL',
      "card.column_name!='done'",
      'card.owner_agent_id IS NULL',
      `NOT EXISTS (
        SELECT 1 FROM job_market_assignments assignment
        WHERE assignment.card_id=card.id AND assignment.status='active'
      )`,
      `NOT EXISTS (
        SELECT 1 FROM jobs job
        WHERE job.card_id=card.id AND job.status IN ('queued','running','cancelling')
      )`,
    ]
    const params: number[] = []
    if (boardIds) {
      where.push(`card.board_id IN (${boardIds.map(() => '?').join(',')})`)
      params.push(...boardIds)
    }
    return this.db.prepare(`SELECT card.id AS card_id
      FROM job_market_contracts market
      JOIN task_contracts contract ON contract.card_id=market.card_id
      JOIN cards card ON card.id=market.card_id
      WHERE ${where.join(' AND ')}
      ORDER BY card.board_id, card.id`).all(...params) as Array<{ card_id: number }>
  }

  private requireMarket(cardId: number): LoadedMarket {
    try {
      return this.loadMarket(cardId)
    } catch (error) {
      if (error instanceof NotFoundError) throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new ConflictError(`job market state is malformed or stale: ${detail}`)
    }
  }

  private loadMarket(cardId: number): LoadedMarket {
    const scope = this.cardScope(cardId)
    const contractRow = this.db.prepare('SELECT * FROM task_contracts WHERE card_id=?')
      .get(cardId) as Record<string, unknown> | undefined
    const marketRow = this.db.prepare('SELECT * FROM job_market_contracts WHERE card_id=?')
      .get(cardId) as Record<string, unknown> | undefined
    if (!contractRow || !marketRow) throw new Error('contract records are missing')
    const contract = mapTaskContract(contractRow)
    const criteriaRows = this.db.prepare(`SELECT criterion_id, description, verifier_json,
      required_artifacts_json, priority, owner
      FROM job_market_criteria WHERE card_id=? ORDER BY criterion_id`).all(cardId) as
      Array<Record<string, unknown>>
    const dependencyRows = this.db.prepare(`SELECT dependency_card_id, blocking_reason,
      completion_condition FROM job_market_dependencies
      WHERE card_id=? ORDER BY dependency_card_id`).all(cardId) as Array<Record<string, unknown>>
    const criteria = mapCriteria(contract, criteriaRows)
    const dependencyRules = mapDependencies(
      this.db,
      scope.board_id,
      contract.dependencies,
      dependencyRows,
    )
    const status = requiredStatus(marketRow.status)
    const market: JobMarketContract = {
      card_id: cardId,
      status,
      market_version: positiveInteger(marketRow.version, 'market version'),
      contract,
      criteria,
      dependency_rules: dependencyRules,
      constraints: {
        required_capabilities: stringArray(
          marketRow.required_capabilities_json,
          'required capabilities',
        ),
        provider_constraints: stringArray(
          marketRow.provider_constraints_json,
          'provider constraints',
        ),
        model_constraints: stringArray(
          marketRow.model_constraints_json,
          'model constraints',
        ),
        access_needs: accessArray(marketRow.access_needs_json),
      },
      budgets: {
        tokens: nullablePositiveInteger(contract.budget_tokens, 'token budget'),
        cost_cents: nullablePositiveInteger(contract.budget_cents, 'cost budget'),
        time_seconds: nullablePositiveInteger(marketRow.budget_time_seconds, 'time budget'),
        retries: nullableNonNegativeInteger(marketRow.budget_retries, 'retry budget'),
        coordination_tokens: nullablePositiveInteger(
          marketRow.budget_coordination_tokens,
          'coordination token budget',
        ),
        coordination_messages: nullablePositiveInteger(
          marketRow.budget_coordination_messages,
          'coordination message budget',
        ),
      },
      published_at: nullableText(marketRow.published_at, 'published_at'),
      archived_at: nullableText(marketRow.archived_at, 'archived_at'),
      created_at: requiredText(marketRow.created_at, 'market created_at'),
      updated_at: requiredText(marketRow.updated_at, 'market updated_at'),
    }
    return { scope, market }
  }

  private graphState(boardIds: number[]): GraphState {
    if (!boardIds.length) {
      return { cards: new Map(), edges: [], edgesBySource: new Map() }
    }
    const placeholders = boardIds.map(() => '?').join(',')
    const cards = new Map(
      (this.db.prepare(`SELECT id AS card_id, board_id, title, column_name AS state
        FROM cards WHERE board_id IN (${placeholders}) ORDER BY board_id, id`)
        .all(...boardIds) as GraphCard[])
        .map((card) => [card.card_id, card]),
    )
    const rawEdges = this.db.prepare(`SELECT dependency.card_id AS from_card_id,
      dependency.dependency_card_id AS to_card_id, dependency.blocking_reason,
      dependency.completion_condition
      FROM job_market_dependencies dependency
      JOIN cards source ON source.id=dependency.card_id
      JOIN cards target ON target.id=dependency.dependency_card_id
      WHERE source.board_id IN (${placeholders}) AND target.board_id=source.board_id
      ORDER BY dependency.card_id, dependency.dependency_card_id`)
      .all(...boardIds) as GraphDependency[]
    const edges = rawEdges.filter((edge) =>
      edge.completion_condition === 'card_done'
      && typeof edge.blocking_reason === 'string'
      && !!edge.blocking_reason.trim()
      && cards.has(edge.from_card_id)
      && cards.has(edge.to_card_id))
    const edgesBySource = new Map<number, GraphDependency[]>()
    for (const edge of edges) {
      const list = edgesBySource.get(edge.from_card_id) ?? []
      list.push(edge)
      edgesBySource.set(edge.from_card_id, list)
    }
    return { cards, edges, edgesBySource }
  }

  private publicGraph(graph: GraphState): OpenWorkGraph {
    const nodes = [...graph.cards.values()]
      .sort((left, right) => left.board_id - right.board_id || left.card_id - right.card_id)
      .map((card): OpenWorkGraphNode => {
        const blockers = card.state === 'done' ? [] : criticalPaths(card.card_id, graph)
        return {
          ...card,
          readiness: blockers.length ? 'blocked' : 'ready',
          blocking_reasons: [...new Set(
            blockers.flatMap((chain) =>
              chain.path.map((node) => node.blocking_reason).filter(isText)),
          )].sort(textOrder),
        }
      })
    const edges = graph.edges.map((edge): OpenWorkGraphEdge => ({
      ...edge,
      readiness: graph.cards.get(edge.to_card_id)?.state === 'done' ? 'ready' : 'blocked',
    }))
    return { nodes, edges }
  }

  private openWorkItem(loaded: LoadedMarket, graph: GraphState): OpenWorkItem {
    const match = this.matchLoaded(loaded, graph)
    const criticalPath = criticalPaths(loaded.scope.card_id, graph)
    return {
      card_id: loaded.scope.card_id,
      board_id: loaded.scope.board_id,
      title: loaded.scope.title,
      repository: loaded.scope.repository,
      status: 'open',
      market_version: loaded.market.market_version,
      priority: loaded.market.contract.priority,
      constraints: loaded.market.constraints,
      budgets: loaded.market.budgets,
      dependency_readiness: criticalPath.length ? 'blocked' : 'ready',
      dependencies: this.dependencies(loaded.scope.card_id, graph),
      critical_path: criticalPath,
      eligible_agent_count: match.candidates.filter((candidate) => candidate.eligible).length,
      selected_agent: match.selected_agent,
    }
  }

  private dependencies(cardId: number, graph: GraphState): OpenWorkDependency[] {
    return (graph.edgesBySource.get(cardId) ?? []).map((edge) => {
      const target = graph.cards.get(edge.to_card_id)
      if (!target) throw new Error(`dependency card ${edge.to_card_id} is missing`)
      return {
        card_id: target.card_id,
        title: target.title,
        state: target.state,
        blocking_reason: edge.blocking_reason,
        completion_condition: edge.completion_condition,
        readiness: target.state === 'done' ? 'ready' : 'blocked',
      }
    })
  }

  private matchLoaded(loaded: LoadedMarket, graph: GraphState): OpenWorkMatch {
    const globalCapacity = this.globalCapacity()
    const blockers = contractBlockers(this.db, loaded, graph)
    const rows = this.db.prepare(`SELECT id, name, default_provider, default_model,
      default_access_profile, capabilities_json
      FROM agent_profiles WHERE board_id=? AND status='active'
      ORDER BY name COLLATE BINARY, id COLLATE BINARY`).all(loaded.scope.board_id) as ProfileRow[]
    const candidates = rows.map((profile) =>
      this.candidate(loaded, profile, blockers, globalCapacity))
      .sort(candidateOrder)
    const selected = candidates.find((candidate) => candidate.eligible) ?? null
    const compact = selected
      ? {
          card_id: loaded.scope.card_id,
          market_version: loaded.market.market_version,
          profile_id: selected.profile_id,
          provider: selected.provider!,
          model: selected.model!,
          access_profile: selected.access_profile!,
          workspace_id: selected.workspace_id!,
          agent_brief_sha256: renderAgentBrief({
            job_market: loaded.market,
            repository: loaded.scope.repository,
            dependencies: this.dependencies(loaded.scope.card_id, graph),
            critical_path: criticalPaths(loaded.scope.card_id, graph),
          }).agent_brief_sha256,
        }
      : null
    return {
      card_id: loaded.scope.card_id,
      board_id: loaded.scope.board_id,
      market_version: loaded.market.market_version,
      eligible: selected !== null,
      eligible_agent_count: candidates.filter((candidate) => candidate.eligible).length,
      selected_agent: selected,
      candidates,
      global_capacity: globalCapacity,
      agent_brief_sha256: compact?.agent_brief_sha256 ?? null,
      decision_sha256: compact ? decisionDigest(compact) : null,
    }
  }

  private candidate(
    loaded: LoadedMarket,
    profile: ProfileRow,
    contractReasons: readonly string[],
    globalCapacity: CapacityEvidence,
  ): OpenWorkAgentCandidate {
    const reasons = [...contractReasons]
    const capabilities = parseProfileCapabilities(profile.capabilities_json, reasons)
    const missing = loaded.market.constraints.required_capabilities
      .filter((capability) => !capabilities.includes(capability))
      .sort(textOrder)
    if (missing.length) reasons.push(`missing required capabilities: ${missing.join(', ')}`)
    const provider = normalizedNullableText(profile.default_provider)
    if (!provider) {
      reasons.push('profile has no declared default provider')
    } else {
      if (!this.supportedProviders.has(provider)) {
        reasons.push(`provider ${provider} is not currently supported by the scheduler`)
      }
      if (loaded.market.constraints.provider_constraints.length
        && !loaded.market.constraints.provider_constraints.includes(provider)) {
        reasons.push(`provider ${provider} is not allowed by the contract`)
      }
    }
    const model = normalizedNullableText(profile.default_model)
    if (!model) {
      reasons.push('profile has no declared default model; model fallback is disabled')
    } else if (loaded.market.constraints.model_constraints.length
      && !loaded.market.constraints.model_constraints.includes(model)) {
      reasons.push(`model ${model} is not allowed by the contract`)
    }
    const access = normalizedAccess(profile.default_access_profile)
    if (!access) {
      reasons.push('profile has no declared default access profile')
    } else {
      const required = requiredAccess(loaded.market.constraints.access_needs)
      if (ACCESS_RANK[access] < ACCESS_RANK[required]) {
        reasons.push(`access profile ${access} does not satisfy required ${required}`)
      }
    }
    const active = this.profileActive(profile.id)
    const capacity = {
      active,
      limit: this.perProfileCapacity,
      available: Math.max(0, this.perProfileCapacity - active),
    }
    if (capacity.available === 0) reasons.push('profile capacity is exhausted')
    if (globalCapacity.available === 0) reasons.push('global scheduler capacity is exhausted')
    const workspace = access
      ? this.compatibleWorkspace(loaded, access, reasons)
      : null
    return {
      profile_id: profile.id,
      name: profile.name,
      provider,
      model,
      access_profile: access,
      workspace_id: workspace,
      capabilities,
      eligible: reasons.length === 0,
      ineligibility_reasons: [...new Set(reasons)],
      capacity,
    }
  }

  private compatibleWorkspace(
    loaded: LoadedMarket,
    access: ContractAccessNeed,
    reasons: string[],
  ): string | null {
    const requested = loaded.market.contract.workspace_id
    const rows = requested
      ? this.db.prepare(`SELECT id, board_id, card_id, kind, status
          FROM workspaces WHERE id=?`).all(requested)
      : this.db.prepare(`SELECT id, board_id, card_id, kind, status
          FROM workspaces WHERE board_id=? AND card_id=? AND status='active'
          ORDER BY id COLLATE BINARY`).all(loaded.scope.board_id, loaded.scope.card_id)
    const compatible = (rows as Array<Record<string, unknown>>).filter((row) =>
      Number(row.board_id) === loaded.scope.board_id
      && (row.card_id === null || Number(row.card_id) === loaded.scope.card_id)
      && row.status === 'active'
      && (access === 'read_only' || row.kind === 'worktree'))
    const first = compatible[0]
    if (!first) {
      reasons.push(
        requested
          ? 'contract workspace is missing, inactive, out of scope, or incompatible with access'
          : 'dispatch requires a compatible active card workspace',
      )
      return null
    }
    return String(first.id)
  }

  private profileActive(profileId: string): number {
    const assignmentCount = (this.db.prepare(`SELECT COUNT(*) AS count
      FROM job_market_assignments WHERE profile_id=? AND status='active'`)
      .get(profileId) as { count: number }).count
    const jobCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE assigned_profile_id=? AND status IN ('queued','running','cancelling')`)
      .get(profileId) as { count: number }).count
    const sessionCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM agent_sessions
      WHERE profile_id=? AND status IN ('reserved','starting','running','idle','stopping')`)
      .get(profileId) as { count: number }).count
    return Math.max(assignmentCount, jobCount, sessionCount)
  }

  private globalCapacity(): CapacityEvidence {
    // Open Work treats every durable scheduler reservation as capacity already
    // consumed. This is intentionally stricter than the scheduler's launch-time
    // running count so serialized dispatches cannot both reserve the final slot.
    const reserved = (this.db.prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE status IN ('queued','running','cancelling')`).get() as { count: number }).count
    const legacy = (this.db.prepare(`SELECT COUNT(DISTINCT agent.id) AS count
      FROM agents agent JOIN cards card ON card.owner_agent_id=agent.id
      WHERE agent.kind='hired' AND agent.status NOT IN ('gone','paused_limit')
        AND card.column_name='in_progress'
        AND NOT EXISTS (
          SELECT 1 FROM agent_sessions session
          WHERE session.agent_id=agent.id
            AND session.status IN ('starting','running','idle')
        )`).get() as { count: number }).count
    const limit = this.globalCapacityOverride ?? configuredGlobalCapacity()
    const active = reserved + legacy
    return { active, limit, available: Math.max(0, limit - active) }
  }

  private assignmentReplay(cardId: number, assignmentKey: string): AssignmentReplayRow | null {
    const row = this.db.prepare(`SELECT assigned_market_version
      FROM job_market_assignments WHERE card_id=? AND idempotency_key=?`)
      .get(cardId, assignmentKey) as AssignmentReplayRow | undefined
    if (!row) return null
    if (!Number.isSafeInteger(row.assigned_market_version) || row.assigned_market_version < 2) {
      throw new ConflictError('Open Work assignment replay state is invalid')
    }
    return row
  }
}

export function dispatchMatch(match: OpenWorkMatch): OpenWorkDispatchMatch {
  const selected = match.selected_agent
  if (!selected
    || !selected.provider
    || !selected.model
    || !selected.access_profile
    || !selected.workspace_id
    || !match.decision_sha256) {
    throw new ConflictError('match has no dispatchable selected agent')
  }
  return {
    card_id: match.card_id,
    market_version: match.market_version,
    profile_id: selected.profile_id,
    provider: selected.provider,
    model: selected.model,
    access_profile: selected.access_profile,
    workspace_id: selected.workspace_id,
    agent_brief_sha256: match.agent_brief_sha256!,
    decision_sha256: match.decision_sha256,
  }
}

function mapTaskContract(row: Record<string, unknown>): TaskContract {
  const deliverables = recordArray(row.deliverables, 'deliverables')
    .map((item, index): ContractDeliverable => ({
      id: requiredText(item.id, `deliverables[${index}].id`),
      text: requiredText(item.text, `deliverables[${index}].text`),
      required: requiredBoolean(item.required, `deliverables[${index}].required`),
      metadata: requiredRecord(item.metadata, `deliverables[${index}].metadata`),
    }))
  unique(deliverables.map((item) => item.id), 'deliverable ids')
  const criteria = recordArray(row.acceptance_criteria, 'acceptance criteria')
    .map((item, index): ContractAcceptanceCriterion => ({
      id: requiredText(item.id, `acceptance_criteria[${index}].id`),
      text: requiredText(item.text, `acceptance_criteria[${index}].text`),
      required: requiredBoolean(item.required, `acceptance_criteria[${index}].required`),
      deliverable_ids: stringArrayValue(
        item.deliverable_ids,
        `acceptance_criteria[${index}].deliverable_ids`,
      ),
      metadata: requiredRecord(item.metadata, `acceptance_criteria[${index}].metadata`),
    }))
  unique(criteria.map((item) => item.id), 'acceptance criterion ids')
  const deliverableIds = new Set(deliverables.map((item) => item.id))
  if (criteria.some((criterion) =>
    criterion.deliverable_ids.some((id) => !deliverableIds.has(id)))) {
    throw new Error('acceptance criterion references an unknown deliverable')
  }
  const dependencies = integerArray(row.dependencies, 'dependencies')
  unique(dependencies, 'dependency ids')
  return {
    card_id: positiveInteger(row.card_id, 'contract card id'),
    objective: requiredText(row.objective, 'objective'),
    deliverables,
    acceptance_criteria: criteria,
    dependencies,
    base_ref: nullableText(row.base_ref, 'base_ref'),
    verify_commands: stringArray(row.verify_commands, 'verify commands'),
    non_goals: stringArray(row.non_goals, 'non-goals'),
    risks: stringArray(row.risks, 'risks'),
    budget_tokens: nullablePositiveInteger(row.budget_tokens, 'contract token budget'),
    budget_cents: nullablePositiveInteger(row.budget_cents, 'contract cost budget'),
    priority: safeInteger(row.priority, 'priority'),
    policy_id: nullableText(row.policy_id, 'policy_id'),
    workspace_id: nullableText(row.workspace_id, 'workspace_id'),
    version: positiveInteger(row.version, 'contract version'),
    updated_at: requiredText(row.updated_at, 'contract updated_at'),
  }
}

function mapCriteria(
  contract: TaskContract,
  rows: Array<Record<string, unknown>>,
): JobMarketCriterion[] {
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const id = requiredText(row.criterion_id, 'criterion id')
    if (byId.has(id)) throw new Error('duplicate Job Market criterion')
    byId.set(id, row)
  }
  if (byId.size !== contract.acceptance_criteria.length
    || contract.acceptance_criteria.some((criterion) => !byId.has(criterion.id))) {
    throw new Error('Job Market criteria do not match the contract criteria')
  }
  return contract.acceptance_criteria.map((criterion): JobMarketCriterion => {
    const row = byId.get(criterion.id)!
    return {
      ...criterion,
      description: requiredText(row.description, `criterion ${criterion.id} description`),
      verifier: mapVerifier(
        requiredRecord(parseJson(row.verifier_json, 'criterion verifier'), 'criterion verifier'),
      ),
      required_artifacts: mapArtifacts(row.required_artifacts_json),
      priority: safeInteger(row.priority, `criterion ${criterion.id} priority`),
      owner: nullableText(row.owner, `criterion ${criterion.id} owner`),
    }
  })
}

function mapDependencies(
  db: Database.Database,
  boardId: number,
  ids: number[],
  rows: Array<Record<string, unknown>>,
): JobMarketDependency[] {
  const byId = new Map<number, Record<string, unknown>>()
  for (const row of rows) {
    const id = positiveInteger(row.dependency_card_id, 'dependency card id')
    if (byId.has(id)) throw new Error('duplicate Job Market dependency')
    byId.set(id, row)
  }
  if (byId.size !== ids.length || ids.some((id) => !byId.has(id))) {
    throw new Error('Job Market dependencies do not match the contract dependencies')
  }
  return ids.map((id) => {
    const target = db.prepare('SELECT board_id FROM cards WHERE id=?').get(id) as
      { board_id: number } | undefined
    if (!target || target.board_id !== boardId) {
      throw new Error(`dependency ${id} is missing or belongs to a different board`)
    }
    const row = byId.get(id)!
    if (row.completion_condition !== 'card_done') {
      throw new Error(`dependency ${id} has an unsupported completion condition`)
    }
    return {
      card_id: id,
      blocking_reason: requiredText(row.blocking_reason, `dependency ${id} blocking reason`),
      completion_condition: 'card_done',
    }
  })
}

function mapVerifier(row: Record<string, unknown>): CriterionVerifier {
  const kind = requiredText(row.kind, 'verifier kind')
  if (!['command', 'artifact', 'human', 'custom'].includes(kind)) {
    throw new Error('verifier kind is invalid')
  }
  const verifier: CriterionVerifier = { kind: kind as CriterionVerifier['kind'] }
  const command = nullableText(row.command, 'verifier command')
  const artifactKind = nullableText(row.artifact_kind, 'verifier artifact kind')
  const instructions = nullableText(row.instructions, 'verifier instructions')
  if (command) verifier.command = command
  if (artifactKind) verifier.artifact_kind = artifactKind
  if (instructions) verifier.instructions = instructions
  if (verifier.kind === 'command' && !verifier.command) {
    throw new Error('command verifier has no command')
  }
  if (verifier.kind === 'artifact' && !verifier.artifact_kind) {
    throw new Error('artifact verifier has no artifact kind')
  }
  return verifier
}

function mapArtifacts(value: unknown): RequiredArtifact[] {
  return recordArray(value, 'required artifacts').map((row, index) => ({
    kind: requiredText(row.kind, `required_artifacts[${index}].kind`),
    name: nullableText(row.name, `required_artifacts[${index}].name`),
    description: nullableText(row.description, `required_artifacts[${index}].description`),
  }))
}

function assertStructurallyValid(db: Database.Database, loaded: LoadedMarket): void {
  const { contract } = loaded.market
  if (!contract.objective.trim()) throw new Error('objective is empty')
  if (!contract.deliverables.length) throw new Error('contract has no deliverables')
  if (!loaded.market.criteria.length) throw new Error('contract has no acceptance criteria')
  if (contract.card_id !== loaded.scope.card_id) throw new Error('contract card scope is inconsistent')
  if (contract.policy_id) {
    const policy = db.prepare('SELECT board_id FROM policies WHERE id=?')
      .get(contract.policy_id) as { board_id: number } | undefined
    if (!policy || policy.board_id !== loaded.scope.board_id) {
      throw new Error('contract policy is missing or out of scope')
    }
  }
  if (contract.workspace_id) {
    const workspace = db.prepare('SELECT board_id, card_id FROM workspaces WHERE id=?')
      .get(contract.workspace_id) as { board_id: number; card_id: number | null } | undefined
    if (!workspace
      || workspace.board_id !== loaded.scope.board_id
      || (workspace.card_id !== null && workspace.card_id !== loaded.scope.card_id)) {
      throw new Error('contract workspace is missing or out of scope')
    }
  }
}

function contractBlockers(
  db: Database.Database,
  loaded: LoadedMarket,
  graph: GraphState,
): string[] {
  const reasons: string[] = []
  try {
    assertStructurallyValid(db, loaded)
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error))
  }
  if (loaded.market.status !== 'open' || !loaded.market.published_at) {
    reasons.push('contract must be published and open before matching')
  }
  if (loaded.scope.state === 'done') reasons.push('card is already done')
  if (loaded.scope.owner_agent_id !== null) reasons.push('card has a legacy owner')
  if (db.prepare(`SELECT 1 FROM job_market_assignments
    WHERE card_id=? AND status='active' LIMIT 1`).get(loaded.scope.card_id)) {
    reasons.push('card already has an active Job Market assignment')
  }
  if (db.prepare(`SELECT 1 FROM jobs
    WHERE card_id=? AND status IN ('queued','running','cancelling') LIMIT 1`)
    .get(loaded.scope.card_id)) {
    reasons.push('card already has an active job')
  }
  if (criticalPaths(loaded.scope.card_id, graph).length) {
    reasons.push('contract dependencies are not ready')
  }
  if (loaded.market.contract.policy_id) {
    const policy = db.prepare('SELECT board_id FROM policies WHERE id=?')
      .get(loaded.market.contract.policy_id) as { board_id: number } | undefined
    if (!policy || policy.board_id !== loaded.scope.board_id) {
      reasons.push('contract policy is missing or out of scope')
    }
  }
  return reasons
}

function criticalPaths(cardId: number, graph: GraphState): AgentBriefBlockerPath[] {
  const root = graph.cards.get(cardId)
  if (!root) return []
  const paths: AgentBriefBlockerPath[] = []
  const walk = (
    currentId: number,
    path: AgentBriefBlockerPath['path'],
    visiting: Set<number>,
  ): void => {
    const edges = graph.edgesBySource.get(currentId) ?? []
    for (const edge of edges) {
      const target = graph.cards.get(edge.to_card_id)
      if (!target) {
        paths.push({ path: [...path], terminal: 'invalid' })
        continue
      }
      if (target.state === 'done') continue
      const next = {
        card_id: target.card_id,
        title: target.title,
        state: target.state,
        blocking_reason: edge.blocking_reason,
      }
      if (visiting.has(target.card_id)) {
        paths.push({ path: [...path, next], terminal: 'cycle' })
        continue
      }
      const nested = graph.edgesBySource.get(target.card_id) ?? []
      const unresolvedNested = nested.some((candidate) =>
        graph.cards.get(candidate.to_card_id)?.state !== 'done')
      if (!unresolvedNested) {
        paths.push({ path: [...path, next], terminal: 'incomplete' })
        continue
      }
      const nextVisiting = new Set(visiting)
      nextVisiting.add(target.card_id)
      walk(target.card_id, [...path, next], nextVisiting)
    }
  }
  walk(
    cardId,
    [{
      card_id: root.card_id,
      title: root.title,
      state: root.state,
      blocking_reason: null,
    }],
    new Set([cardId]),
  )
  return paths.sort((left, right) => textOrder(pathKey(left), pathKey(right)))
}

function normalizeQuery(input: OpenWorkQuery): Required<Omit<OpenWorkQuery, 'boardId' | 'repository'>>
& Pick<OpenWorkQuery, 'boardId' | 'repository'> {
  const dependencyReadiness = input.dependencyReadiness
  if (dependencyReadiness !== undefined && !['ready', 'blocked'].includes(dependencyReadiness)) {
    throw new ValidationError('dependency_readiness must be ready or blocked')
  }
  const capabilities = [...new Set(
    (input.capabilities ?? []).map((value) => boundedText(value, 'capability', 120)),
  )].sort(textOrder)
  return {
    boardId: input.boardId,
    repository: input.repository?.trim() || undefined,
    capabilities,
    priority: input.priority === undefined ? undefined : safeInteger(input.priority, 'priority'),
    dependencyReadiness,
    maxTokens: optionalNonNegativeInteger(input.maxTokens, 'max_tokens'),
    maxCostCents: optionalNonNegativeInteger(input.maxCostCents, 'max_cost_cents'),
    maxTimeSeconds: optionalNonNegativeInteger(input.maxTimeSeconds, 'max_time_seconds'),
  } as Required<Omit<OpenWorkQuery, 'boardId' | 'repository'>>
    & Pick<OpenWorkQuery, 'boardId' | 'repository'>
}

function matchesQuery(
  item: OpenWorkItem,
  filters: ReturnType<typeof normalizeQuery>,
): boolean {
  if (filters.repository !== undefined && item.repository !== filters.repository) return false
  if (filters.capabilities.length
    && filters.capabilities
      .some((capability) => !item.constraints.required_capabilities.includes(capability))) {
    return false
  }
  if (filters.priority !== undefined && item.priority !== filters.priority) return false
  if (filters.dependencyReadiness !== undefined
    && item.dependency_readiness !== filters.dependencyReadiness) return false
  if (!withinBudget(item.budgets.tokens, filters.maxTokens)) return false
  if (!withinBudget(item.budgets.cost_cents, filters.maxCostCents)) return false
  if (!withinBudget(item.budgets.time_seconds, filters.maxTimeSeconds)) return false
  return true
}

function withinBudget(value: number | null, maximum: number | undefined): boolean {
  return maximum === undefined || (value !== null && value <= maximum)
}

function normalizeDispatchMatch(value: OpenWorkDispatchMatch): OpenWorkDispatchMatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('match must be an object')
  }
  const access = normalizedAccess(value.access_profile)
  if (!access) throw new ValidationError('match access_profile is invalid')
  const decision = boundedText(value.decision_sha256, 'match decision_sha256', 64)
  if (!/^[0-9a-f]{64}$/.test(decision)) {
    throw new ValidationError('match decision_sha256 must be a lowercase SHA-256 digest')
  }
  const brief = boundedText(value.agent_brief_sha256, 'match agent_brief_sha256', 64)
  if (!/^[0-9a-f]{64}$/.test(brief)) {
    throw new ValidationError('match agent_brief_sha256 must be a lowercase SHA-256 digest')
  }
  return {
    card_id: positiveInteger(value.card_id, 'match card_id'),
    market_version: positiveInteger(value.market_version, 'match market_version'),
    profile_id: boundedText(value.profile_id, 'match profile_id', 200),
    provider: boundedText(value.provider, 'match provider', 80),
    model: boundedText(value.model, 'match model', 200),
    access_profile: access,
    workspace_id: boundedText(value.workspace_id, 'match workspace_id', 200),
    agent_brief_sha256: brief,
    decision_sha256: decision,
  }
}

function withoutDecision(match: OpenWorkDispatchMatch): Omit<OpenWorkDispatchMatch, 'decision_sha256'> {
  const { decision_sha256: _decision, ...rest } = match
  return rest
}

function selectionFromMatch(match: OpenWorkDispatchMatch): AgentBriefSelection {
  return {
    profile_id: match.profile_id,
    provider: match.provider,
    model: match.model,
    access_profile: match.access_profile,
  }
}

function requiredAccess(values: readonly ContractAccessNeed[]): ContractAccessNeed {
  return values.reduce<ContractAccessNeed>(
    (highest, value) => ACCESS_RANK[value] > ACCESS_RANK[highest] ? value : highest,
    'read_only',
  )
}

function parseProfileCapabilities(value: unknown, reasons: string[]): string[] {
  try {
    return stringArray(value, 'profile capabilities').sort(textOrder)
  } catch {
    reasons.push('profile capabilities are malformed')
    return []
  }
}

function normalizedAccess(value: unknown): ContractAccessNeed | null {
  return typeof value === 'string' && Object.hasOwn(ACCESS_RANK, value)
    ? value as ContractAccessNeed
    : null
}

function accessArray(value: unknown): ContractAccessNeed[] {
  const values = stringArray(value, 'access needs')
  if (values.some((item) => !Object.hasOwn(ACCESS_RANK, item))) {
    throw new Error('access needs contain an unsupported value')
  }
  return values as ContractAccessNeed[]
}

function configuredGlobalCapacity(): number {
  const configured = Number(process.env.ORCHESTRA_MAX_LAUNCHED ?? DEFAULT_GLOBAL_CAPACITY)
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_GLOBAL_CAPACITY
}

function derivedKey(kind: 'assignment' | 'launch', idempotencyKey: string): string {
  return `open-work:${kind}:${createHash('sha256').update(idempotencyKey).digest('hex')}`
}

function decisionDigest(value: Omit<OpenWorkDispatchMatch, 'decision_sha256'>): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${field} is malformed JSON`)
  }
}

function recordArray(value: unknown, field: string): Array<Record<string, unknown>> {
  const parsed = parseJson(value, field)
  if (!Array.isArray(parsed) || parsed.some((item) =>
    !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`${field} must be an array of objects`)
  }
  return parsed as Array<Record<string, unknown>>
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringArray(value: unknown, field: string): string[] {
  const parsed = parseJson(value, field)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`)
  }
  const values = parsed.map((item) => String(item).trim())
  unique(values, field)
  return values
}

function stringArrayValue(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`)
  }
  const values = value.map((item) => String(item).trim())
  unique(values, field)
  return values
}

function integerArray(value: unknown, field: string): number[] {
  const parsed = parseJson(value, field)
  if (!Array.isArray(parsed)) throw new Error(`${field} must be an array`)
  return parsed.map((item) => positiveInteger(item, field))
}

function requiredStatus(value: unknown): JobMarketStatus {
  if (typeof value !== 'string'
    || !JOB_MARKET_STATUSES.includes(value as JobMarketStatus)) {
    throw new Error('Job Market status is invalid')
  }
  return value as JobMarketStatus
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
  return value
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function boundedText(value: unknown, field: string, max: number): string {
  const text = requiredText(value, field)
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ValidationError(`${field} must be at most ${max} printable characters`)
  }
  return text
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error(`${field} must be a string or null`)
  const text = value.trim()
  return text || null
}

function normalizedNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return parsed
}

function safeInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be an integer`)
  return parsed
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  return positiveInteger(value, field)
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`)
  }
  return parsed
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return positiveInteger(value, field)
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} must be non-negative`)
  return parsed
}

function unique<T>(values: readonly T[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`)
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => textOrder(left, right))
        .map(([key, item]) => [key, sortValue(item)]),
    )
  }
  return value
}

function pathKey(path: AgentBriefBlockerPath): string {
  return path.path.map((node) => String(node.card_id).padStart(16, '0')).join('/')
    + `/${path.terminal}`
}

function candidateOrder(left: OpenWorkAgentCandidate, right: OpenWorkAgentCandidate): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
  if (left.capacity.active !== right.capacity.active) {
    return left.capacity.active - right.capacity.active
  }
  return textOrder(left.name, right.name) || textOrder(left.profile_id, right.profile_id)
}

function itemOrder(left: OpenWorkItem, right: OpenWorkItem): number {
  return right.priority - left.priority
    || left.board_id - right.board_id
    || left.card_id - right.card_id
}

function numberOrder(left: number, right: number): number {
  return left - right
}

function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isText(value: string | null): value is string {
  return value !== null
}
