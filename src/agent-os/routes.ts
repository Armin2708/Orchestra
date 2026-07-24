import { execFileSync } from 'node:child_process'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify'
import {
  AgentOsError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnsupportedError,
  ValidationError,
} from './errors.js'
import { ArtifactStore } from './artifact-store.js'
import { AttentionService } from './attention.js'
import { Checkpoint, CheckpointForker, CheckpointService } from './checkpoints.js'
import { ContextStore, PutContextItem } from './context-store.js'
import { DeliveryReportService } from './delivery-reports.js'
import { EvidenceService } from './evidence.js'
import { EventStore } from './event-store.js'
import { objectBody, positiveId, requiredString } from './json.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { LegacyBusEvent, LegacyEventProjection } from './legacy-projection.js'
import { orchestrationIdentity } from './orchestration-envelope.js'
import { OrchestrationService } from './orchestration-service.js'
import { PolicyEngine, PolicyKind } from './policy-engine.js'
import { JobExecutor, JobScheduler } from './scheduler.js'
import { TaskContractService } from './task-contracts.js'
import { CreateWorkspace, Workspace, WorkspaceStore } from './workspace-store.js'
import {
  AGENT_DEFAULT_EFFORT_LEVELS,
  AgentDefaultsValidationError,
  readAgentDefaults,
  writeAgentDefaults,
} from '../agent-defaults.js'
import { claudeProviderCatalog, type AgentProviderCatalog } from '../agent-providers.js'
import { agentHomePlugin } from './agent-home-routes.js'
import type { AgentHomeRuntimeControl } from './agent-home-lifecycle.js'

export interface ProcessRecord {
  id: string
  workspace_id: string
  name: string
  command: string
  cwd: string
  status: string
  pid: number | null
  exit_code: number | null
  cols: number
  rows: number
  restartable: boolean
  started_at: string | null
  ended_at: string | null
  ports?: number[]
}

/** Adapter boundary implemented by the PTY/worktree runtime, never by chat message simulation. */
export interface AgentOsRuntimeAdapter {
  createWorkspace?(input: CreateWorkspace): Promise<Workspace>
  updateWorkspace?(workspace: Workspace, patch: { name?: string; cardId?: number | null; baseRef?: string; env?: Record<string, string> }): Promise<Workspace>
  archiveWorkspace?(workspace: Workspace): Promise<Workspace>
  spawnProcess(input: {
    workspace: Workspace
    name: string
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
    restartable: boolean
  } & ({ interactive: true; command?: never } | { interactive?: false; command: string })): Promise<ProcessRecord>
  writeProcessInput(processId: string, data: string): Promise<void>
  resizeProcess(processId: string, cols: number, rows: number): Promise<void>
  signalProcess(processId: string, signal: string): Promise<void>
  restartProcess?(processId: string): Promise<ProcessRecord>
  listProcessPorts?(workspaceId: string): Promise<Array<{ processId: string; port: number }>>
  forkCheckpoint?: CheckpointForker
  captureCheckpoint?(input: { workspace: Workspace; name: string; sessionId: string | null; context: Record<string, unknown> }): Promise<{
    gitHead: string
    patchArtifactId?: string | null
    processRecipes?: unknown[]
    context?: Record<string, unknown>
  }>
}

export interface DriverDescriptor {
  id: string
  available: boolean
  capabilities: string[]
  detail?: string
}

export interface PluginDescriptor {
  id: string
  name: string
  version: string
  capabilities: string[]
}

export interface AgentOsRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  runtime?: AgentOsRuntimeAdapter
  jobExecutor?: JobExecutor
  scheduler?: JobScheduler
  orchestration?: OrchestrationService
  agentHomeLifecycle?: AgentHomeRuntimeControl
  drivers?: DriverDescriptor[] | (() => DriverDescriptor[])
  providers?: AgentProviderCatalog[] | (() => AgentProviderCatalog[] | Promise<AgentProviderCatalog[]>)
  plugins?: PluginDescriptor[] | (() => PluginDescriptor[])
  isOperator?: (request: FastifyRequest) => boolean
}

export function registerAgentOsRoutes(server: FastifyInstance, options: AgentOsRouteOptions): void {
  server.register(agentOsPlugin, { ...options, prefix: '/api/v1/os' })
  server.register(agentHomePlugin, {
    db: options.db,
    isOperator: options.isOperator,
    lifecycleRuntime: options.agentHomeLifecycle
      ?? (isAgentHomeRuntimeControl(options.jobExecutor) ? options.jobExecutor : undefined),
    orchestration: options.orchestration,
    scheduler: options.scheduler,
    prefix: '/api/v1/os',
  })
}

function isAgentHomeRuntimeControl(value: unknown): value is AgentHomeRuntimeControl {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AgentHomeRuntimeControl>
  return typeof candidate.agentHomeSessionCapabilities === 'function'
    && typeof candidate.pauseAgentHomeSession === 'function'
    && typeof candidate.resumeAgentHomeSession === 'function'
    && typeof candidate.stopAgentHomeSession === 'function'
}

export const agentOsPlugin: FastifyPluginAsync<AgentOsRouteOptions> = async (app, options) => {
  if (options.orchestration && !options.scheduler) {
    throw new Error('Agent OS orchestration requires its matching scheduler')
  }
  const db = options.db
  const workspaces = new WorkspaceStore(db)
  const events = new EventStore(db)
  const deliveries = new DeliveryReportService(db, events)
  const artifacts = new ArtifactStore(db)
  const contracts = new TaskContractService(db, events)
  const attention = new AttentionService(db)
  const policies = new PolicyEngine(db)
  const context = new ContextStore(db)
  const scheduler = options.scheduler ?? new JobScheduler(db, options.jobExecutor)
  const orchestration = options.orchestration ?? new OrchestrationService(db, scheduler)
  const isOperator = options.isOperator ?? (() => true)
  const requireOperator = (request: FastifyRequest) => {
    if (!isOperator(request)) throw new ForbiddenError('operator authorization is required for this action')
  }
  const checkpoints = new CheckpointService(db, options.runtime?.forkCheckpoint)
  const evidence = new EvidenceService(db)
  const projection = new LegacyEventProjection(db)
  const bus = (app as FastifyInstance & { bus?: { on(event: string, listener: (event: LegacyBusEvent) => void): unknown; off(event: string, listener: (event: LegacyBusEvent) => void): unknown } }).bus
  const onLegacyEvent = (event: LegacyBusEvent) => { try { projection.project(event) } catch { /* compatibility bridge stays fail-soft */ } }
  bus?.on('event', onLegacyEvent)
  app.addHook('onClose', async () => { bus?.off('event', onLegacyEvent) })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentOsError) return reply.code(error.statusCode).send({ error: error.message, code: error.code })
    if (error && typeof error === 'object' && 'validation' in error && error.validation) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'request validation failed', code: 'validation_error' })
    }
    return reply.send(error)
  })

  app.get('/providers', async () => ({ providers: await asyncDescriptors(options.providers, [
    claudeProviderCatalog({
      available: false,
      detail: 'Requires the daemon Conductor before Claude models can be discovered.',
    }),
  ]) }))

  app.get('/settings/agent-defaults', () => ({
    defaults: readAgentDefaults(db),
    effort_levels: AGENT_DEFAULT_EFFORT_LEVELS,
  }))
  app.put<{ Body: unknown }>('/settings/agent-defaults', (request) => {
    try {
      return {
        defaults: writeAgentDefaults(db, request.body),
        effort_levels: AGENT_DEFAULT_EFFORT_LEVELS,
      }
    } catch (error) {
      if (error instanceof AgentDefaultsValidationError) throw new ValidationError(error.message)
      throw error
    }
  })

  app.get<{ Params: { id: string }; Querystring: { archived?: string; status?: string } }>('/boards/:id/workspaces', (request) => {
    const boardId = board(db, request.params.id)
    const status = request.query.status
    if (status && !['active', 'archived', 'missing'].includes(status)) throw new ValidationError('workspace status must be active, archived, or missing')
    const includeArchived = Boolean(status) || request.query.archived === '1' || request.query.archived === 'true'
    const rows = workspaces.listBoard(boardId, includeArchived)
    return { workspaces: status ? rows.filter((workspace) => workspace.status === status) : rows }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/boards/:id/workspaces', async (request, reply) => {
    const boardId = board(db, request.params.id)
    const body = objectBody(request.body)
    const cardId = optionalPositiveId(body.card_id ?? body.cardId, 'card_id')
    const projectPath = (db.prepare('SELECT project_path FROM boards WHERE id=?').get(boardId) as { project_path: string }).project_path
    const input: CreateWorkspace = {
      boardId, cardId, name: requiredString(body.name, 'name'),
      kind: stringValue(body.kind) ?? 'shared', rootPath: requiredString(body.root_path ?? body.rootPath ?? projectPath, 'root_path'),
      worktreePath: nullableValue(body.worktree_path ?? body.worktreePath), branch: nullableValue(body.branch),
      baseRef: nullableValue(body.base_ref ?? body.baseRef), status: stringValue(body.status), env: envObject(body.env ?? body.env_json),
    }
    const workspace = options.runtime?.createWorkspace ? await options.runtime.createWorkspace(input) : workspaces.create(input)
    if (!workspaces.get(workspace.id)) throw new ValidationError('workspace runtime did not persist the returned workspace')
    if (!options.runtime?.createWorkspace) events.append({ boardId, workspaceId: workspace.id, cardId: workspace.card_id,
      kind: 'workspace.created', source: 'api', payload: { kind: workspace.kind, root_path: workspace.root_path } })
    return reply.code(201).send({ workspace })
  })

  app.get<{ Params: { id: string } }>('/workspaces/:id', (request) => ({ workspace: requireWorkspace(workspaces, request.params.id) }))

  app.patch<{ Params: { id: string }; Body: unknown }>('/workspaces/:id', async (request) => {
    const body = objectBody(request.body)
    const allowed = new Set(['name', 'card_id', 'cardId', 'base_ref', 'baseRef', 'env'])
    for (const key of Object.keys(body)) if (!allowed.has(key)) {
      throw new ValidationError(`workspace field ${key} is immutable; use the archive endpoint for lifecycle changes`)
    }
    const current = requireWorkspace(workspaces, request.params.id)
    const changesCard = Object.hasOwn(body, 'card_id') || Object.hasOwn(body, 'cardId')
    const patch = {
      ...(body.name !== undefined ? { name: requiredString(body.name, 'name') } : {}),
      ...(changesCard ? { cardId: optionalPositiveId(body.card_id ?? body.cardId, 'card_id') } : {}),
      ...(body.base_ref !== undefined || body.baseRef !== undefined
        ? { baseRef: requiredString(body.base_ref ?? body.baseRef, 'base_ref') } : {}),
      ...(body.env !== undefined ? { env: envObject(body.env) } : {}),
    }
    const workspace = options.runtime?.updateWorkspace
      ? await options.runtime.updateWorkspace(current, patch)
      : workspaces.update(current.id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.cardId !== undefined || changesCard ? { card_id: patch.cardId ?? null } : {}),
          ...(patch.baseRef !== undefined ? { base_ref: patch.baseRef } : {}),
          ...(patch.env !== undefined ? { env: patch.env } : {}),
        })
    if (!options.runtime?.updateWorkspace) events.append({ boardId: workspace.board_id, workspaceId: workspace.id, cardId: workspace.card_id,
      kind: 'workspace.updated', source: 'api', payload: body })
    return { workspace }
  })

  app.delete<{ Params: { id: string } }>('/workspaces/:id', async (request) => {
    const current = requireWorkspace(workspaces, request.params.id)
    const workspace = options.runtime?.archiveWorkspace ? await options.runtime.archiveWorkspace(current) : workspaces.archive(current.id)
    if (workspaces.get(workspace.id)?.status !== 'archived') throw new ValidationError('workspace runtime did not persist the archived state')
    if (!options.runtime?.archiveWorkspace) events.append({ boardId: workspace.board_id, workspaceId: workspace.id, cardId: workspace.card_id,
      kind: 'workspace.archived', source: 'api' })
    return { workspace }
  })

  app.get<{ Params: { id: string } }>('/workspaces/:id/processes', async (request) => {
    requireWorkspace(workspaces, request.params.id)
    const processes = listProcesses(db, request.params.id)
    const ports = await options.runtime?.listProcessPorts?.(request.params.id) ?? []
    const byProcess = new Map<string, number[]>()
    for (const entry of ports) byProcess.set(entry.processId, [...(byProcess.get(entry.processId) ?? []), entry.port])
    return { processes: processes.map((process) => ({ ...process, ports: byProcess.get(process.id) ?? [] })) }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/workspaces/:id/processes', async (request, reply) => {
    requireOperator(request)
    if (!options.runtime) throw new UnsupportedError('process spawning requires the PTY runtime')
    const workspace = requireWorkspace(workspaces, request.params.id)
    const body = objectBody(request.body)
    const interactive = body.interactive === true
    const requestedCommand = interactive ? null : requiredString(body.command, 'command')
    const launch = interactive
      ? { interactive: true as const }
      : { interactive: false as const, command: requestedCommand! }
    const process = await options.runtime.spawnProcess({ workspace, ...launch,
      name: stringValue(body.name) ?? requestedCommand?.split(/\s+/)[0] ?? 'shell',
      cwd: stringValue(body.cwd) ?? workspace.worktree_path ?? workspace.root_path,
      env: envObject(body.env), cols: boundedInteger(body.cols, 80, 20, 500, 'cols'),
      rows: boundedInteger(body.rows, 24, 5, 300, 'rows'), restartable: body.restartable === true })
    events.append({ boardId: workspace.board_id, workspaceId: workspace.id, cardId: workspace.card_id,
      processId: process.id, kind: 'process.spawned', source: 'api',
      payload: { command: process.command, name: process.name, interactive } })
    return reply.code(201).send({ process })
  })

  app.get<{ Params: { id: string } }>('/processes/:id', (request) => ({ process: requireProcess(db, request.params.id) }))

  app.post<{ Params: { id: string } }>('/processes/:id/restart', async (request, reply) => {
    requireOperator(request)
    if (!options.runtime?.restartProcess) throw new UnsupportedError('process restart requires the PTY runtime')
    const current = requireProcess(db, request.params.id)
    if (!current.restartable) throw new ValidationError('process does not have a restart recipe')
    const process = await options.runtime.restartProcess(current.id)
    const workspace = requireWorkspace(workspaces, process.workspace_id)
    events.append({ boardId: workspace.board_id, workspaceId: workspace.id, cardId: workspace.card_id,
      processId: process.id, kind: 'process.restart_requested', source: 'human', payload: { previous_process_id: current.id } })
    return reply.code(201).send({ process })
  })

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/processes/:id/output', (request) => {
    requireProcess(db, request.params.id)
    const after = Math.max(0, Number(request.query.after) || 0)
    const limit = Math.min(2000, Math.max(1, Number(request.query.limit) || 500))
    const output = db.prepare(`SELECT seq, stream, data, created_at FROM process_output
      WHERE process_id=? AND seq>? ORDER BY seq ASC LIMIT ?`).all(request.params.id, after, limit) as any[]
    return { output, next_seq: output.length ? output[output.length - 1].seq : after }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/processes/:id/input', async (request) => {
    requireOperator(request)
    if (!options.runtime) throw new UnsupportedError('process input requires the PTY runtime')
    const process = requireProcess(db, request.params.id)
    const body = objectBody(request.body)
    const data = body.data ?? body.input
    if (typeof data !== 'string') throw new ValidationError('data must be a string')
    if (Buffer.byteLength(data) > 1024 * 1024) throw new ValidationError('process input exceeds the 1 MiB limit')
    await options.runtime.writeProcessInput(process.id, data)
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/processes/:id/resize', async (request) => {
    requireOperator(request)
    if (!options.runtime) throw new UnsupportedError('process resize requires the PTY runtime')
    const process = requireProcess(db, request.params.id)
    const body = objectBody(request.body)
    const cols = boundedInteger(body.cols, process.cols, 20, 500, 'cols')
    const rows = boundedInteger(body.rows, process.rows, 5, 300, 'rows')
    await options.runtime.resizeProcess(process.id, cols, rows)
    return { ok: true, cols, rows }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/processes/:id/signal', async (request) => {
    requireOperator(request)
    if (!options.runtime) throw new UnsupportedError('process signals require the PTY runtime')
    const process = requireProcess(db, request.params.id)
    const body = objectBody(request.body)
    const signal = requiredString(body.signal, 'signal').toUpperCase()
    await options.runtime.signalProcess(process.id, signal)
    return { ok: true, signal }
  })

  app.get<{ Params: { id: string }; Querystring: {
    workspace?: string
    card?: string
    job?: string
    kind?: string
    after?: string
    limit?: string
  } }>(
    '/boards/:id/events', (request) => {
      const boardId = board(db, request.params.id)
      const page = events.listBoard(boardId, { workspaceId: request.query.workspace,
        cardId: request.query.card ? positiveId(request.query.card, 'card') : undefined,
        jobId: request.query.job, kind: request.query.kind,
        after: request.query.after, limit: Number(request.query.limit) || undefined })
      const cursorEvent = request.query.after ? page.at(-1) : page[0]
      return { events: page, next_cursor: cursorEvent?.id ?? request.query.after ?? null }
    })

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/boards/:id/attention', (request) => {
    const boardId = board(db, request.params.id)
    return { attention: attention.listBoard(boardId, request.query.status ?? 'open') }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/attention/:id/resolve', (request) => {
    const resolution = request.body == null ? null : nullableValue(objectBody(request.body).resolution)
    const previous = attention.get(request.params.id)
    const item = attention.resolve(request.params.id)
    if (previous?.status === 'open') {
      events.append({ boardId: item.board_id, workspaceId: item.workspace_id, cardId: item.card_id,
        kind: 'attention.resolved', source: 'human', payload: { attention_id: item.id, resolution } })
    }
    return { attention: item }
  })

  app.get<{ Params: { id: string } }>('/cards/:id/contract', (request) => ({ contract: contracts.getOrCreate(positiveId(request.params.id)) }))
  app.put<{ Params: { id: string }; Body: unknown }>('/cards/:id/contract', (request) =>
    ({ contract: contracts.put(positiveId(request.params.id), objectBody(request.body)) }))

  app.get<{ Params: { id: string } }>('/cards/:id/evidence', (request) => {
    const bundle = evidence.assemble(positiveId(request.params.id))
    return { evidence: bundle, artifacts: bundle.artifacts }
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/cards/:id/evidence', (request, reply) => {
    const cardId = positiveId(request.params.id)
    const body = request.body == null ? {} : objectBody(request.body)
    if (Object.keys(body).length === 0 || body.generate === true) {
      const result = evidence.persist(cardId)
      return reply.code(201).send({ ...result, artifacts: [result.artifact] })
    }
    const card = db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as { board_id: number } | undefined
    if (!card) throw new NotFoundError('card not found')
    const artifact = artifacts.create({ boardId: card.board_id, cardId,
      workspaceId: nullableValue(body.workspace_id ?? body.workspaceId), kind: requiredString(body.kind, 'kind'),
      name: requiredString(body.name, 'name'), content: body.content == null ? null : String(body.content),
      path: nullableValue(body.path), mimeType: stringValue(body.mime_type ?? body.mimeType),
      metadata: recordValue(body.metadata, 'metadata') })
    events.append({ boardId: card.board_id, workspaceId: artifact.workspace_id, cardId,
      kind: 'artifact.created', source: 'api', payload: { artifact_id: artifact.id, kind: artifact.kind, name: artifact.name } })
    const bundle = evidence.assemble(cardId)
    return reply.code(201).send({ artifact, artifacts: [artifact], evidence: bundle })
  })

  app.get<{ Params: { id: string } }>('/cards/:id/deliveries', (request) => {
    const cardId = positiveId(request.params.id, 'card id')
    return { deliveries: deliveries.listCard(cardId), current: deliveries.currentForCard(cardId) }
  })
  app.post<{ Params: { id: string } }>('/jobs/:id/deliveries/prepare', (request, reply) =>
    reply.code(201).send({ delivery: deliveries.prepareForJob(request.params.id) }))
  app.post<{ Params: { id: string }; Body: unknown }>('/jobs/:id/deliveries/submit', (request) => {
    const body = objectBody(request.body)
    const actor = requiredString(body.actor, 'actor')
    const evidenceInput = Array.isArray(body.evidence)
      ? { artifact_ids: body.evidence }
      : recordValue(body.evidence, 'evidence')
    const prepared = deliveries.prepareForJob(request.params.id)
    let delivery = deliveries.submit(prepared.id, {
      actor,
      summary: requiredString(body.summary, 'summary'),
      deliveredItems: arrayValue(body.delivered_items ?? body.deliveredItems ?? body.items, 'delivered_items') as any,
      claims: arrayValue(body.claims, 'claims') as any,
      changedFiles: arrayValue(body.changed_files ?? body.changedFiles ?? evidenceInput.changed_files, 'changed_files') as string[],
      commits: arrayValue(body.commits ?? evidenceInput.commits, 'commits') as string[],
      artifactIds: arrayValue(
        body.artifact_ids ?? body.artifactIds ?? evidenceInput.artifact_ids ?? evidenceInput.artifacts,
        'artifact_ids',
      ) as string[],
      gaps: arrayValue(body.gaps ?? evidenceInput.gaps, 'gaps') as string[],
    })
    if (body.criteria !== undefined || body.criterion_results !== undefined || body.deliverable_results !== undefined) {
      const criterionResults = arrayValue(body.criteria ?? body.criterion_results, 'criteria')
      const deliverableResults = arrayValue(body.deliverable_results, 'deliverable_results')
      const hasOverride = [...criterionResults, ...deliverableResults].some(resultHasOverride)
      if (hasOverride) requireOperator(request)
      delivery = deliveries.verifySubmission(delivery.id, {
        actor,
        results: operatorizeOverrides(criterionResults) as any,
        deliverableResults: operatorizeOverrides(deliverableResults) as any,
      })
    }
    return { delivery }
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/verify', (request) => {
    const body = objectBody(request.body)
    const results = arrayValue(body.results ?? body.criteria ?? body.criterion_results, 'results')
    const deliverableResults = arrayValue(body.deliverable_results ?? body.deliverableResults, 'deliverable_results')
    const hasOverride = [...results, ...deliverableResults].some(resultHasOverride)
    if (hasOverride) requireOperator(request)
    return { delivery: deliveries.verify(request.params.id, {
      actor: requiredString(body.actor, 'actor'),
      results: operatorizeOverrides(results) as any,
      deliverableResults: operatorizeOverrides(deliverableResults) as any,
    }) }
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/accept', (request) => {
    requireOperator(request)
    const body = objectBody(request.body)
    return { delivery: deliveries.accept(request.params.id, {
      actor: 'human',
      note: stringValue(body.note),
    }) }
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/reject', (request) => {
    requireOperator(request)
    const body = objectBody(request.body)
    return { delivery: deliveries.reject(request.params.id, {
      actor: 'human',
      reason: requiredString(body.reason, 'reason'),
    }) }
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/revise', (request) => {
    const body = objectBody(request.body)
    return { delivery: deliveries.revise(request.params.id, { actor: requiredString(body.actor, 'actor') }) }
  })
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/deliveries/:id/export', (request, reply) => {
    const format = request.query.format ?? 'human'
    if (format === 'json') return { delivery: deliveries.get(request.params.id) }
    if (format !== 'human') throw new ValidationError('format must be human or json')
    return reply.type('text/plain; charset=utf-8').send(deliveries.renderHuman(request.params.id))
  })

  app.get<{ Params: { id: string } }>('/workspaces/:id/context', (request) => ({ context: context.listWorkspace(request.params.id) }))
  app.put<{ Params: { id: string }; Body: unknown }>('/workspaces/:id/context', (request) => {
    const bodyObject = Array.isArray(request.body) ? null : objectBody(request.body)
    const body = Array.isArray(request.body) ? request.body : bodyObject!.context ?? bodyObject!.items
    if (!Array.isArray(body)) throw new ValidationError('items must be an array')
    return { context: context.putWorkspace(request.params.id, body as PutContextItem[]) }
  })

  app.get<{ Params: { id: string } }>('/boards/:id/policies', (request) => {
    const boardId = board(db, request.params.id)
    return { policies: policies.listBoard(boardId) }
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/boards/:id/policies', (request, reply) => {
    const boardId = board(db, request.params.id)
    const body = objectBody(request.body)
    const policy = policies.create({ boardId, name: requiredString(body.name, 'name'),
      fileGlobs: body.file_globs ?? body.fileGlobs, commandGlobs: body.command_globs ?? body.commandGlobs,
      networkHosts: body.network_hosts ?? body.networkHosts, secretNames: body.secret_names ?? body.secretNames,
      approvalScope: stringValue(body.approval_scope ?? body.approvalScope) })
    return reply.code(201).send({ policy })
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/policies/:id/evaluate', (request) => {
    const body = objectBody(request.body)
    const evaluation = policies.evaluate(request.params.id, {
      kind: requiredString(body.kind ?? body.operation, 'kind') as PolicyKind,
      value: requiredString(body.value ?? body.target, 'value'),
      actor: body.actor === 'human' ? 'human' : 'agent',
    })
    const policy = policies.get(request.params.id)!
    events.append({ boardId: policy.board_id, kind: 'policy.evaluated', source: 'policy', payload: evaluation })
    if (evaluation.decision === 'ask') attention.create({ boardId: policy.board_id, kind: 'policy.approval', severity: 'critical',
      title: `Policy approval needed: ${evaluation.kind}`, detail: `${evaluation.value}\n${evaluation.reason}` })
    return { evaluation }
  })

  app.get<{ Params: { id: string } }>('/workspaces/:id/checkpoints', (request) =>
    ({ checkpoints: checkpoints.listWorkspace(request.params.id) }))
  app.post<{ Params: { id: string }; Body: unknown }>('/workspaces/:id/checkpoints', async (request, reply) => {
    const body = objectBody(request.body)
    const workspace = requireWorkspace(workspaces, request.params.id)
    const name = requiredString(body.name, 'name')
    const sessionId = nullableValue(body.session_id ?? body.sessionId)
    const hasContext = body.context !== undefined || body.context_json !== undefined
    const contextValue = recordValue(body.context ?? body.context_json, 'context')
    const captured = options.runtime?.captureCheckpoint && body.git_head === undefined && body.gitHead === undefined
      ? await options.runtime.captureCheckpoint({ workspace, name, sessionId, context: contextValue }) : null
    const checkpoint = checkpoints.create({ workspaceId: request.params.id, sessionId, name,
      gitHead: stringValue(body.git_head ?? body.gitHead) ?? captured?.gitHead ?? gitHead(workspace),
      patchArtifactId: nullableValue(body.patch_artifact_id ?? body.patchArtifactId ?? captured?.patchArtifactId),
      context: hasContext ? contextValue : captured?.context ?? contextValue,
      processRecipes: body.process_recipes !== undefined || body.processRecipes !== undefined
        ? arrayValue(body.process_recipes ?? body.processRecipes, 'process_recipes') : captured?.processRecipes ?? [] })
    events.append({ boardId: workspace.board_id, workspaceId: workspace.id, cardId: workspace.card_id,
      kind: 'checkpoint.created', source: 'api', payload: { checkpoint_id: checkpoint.id, git_head: checkpoint.git_head } })
    return reply.code(201).send({ checkpoint })
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/checkpoints/:id/fork', async (request, reply) => {
    const body = objectBody(request.body)
    const workspace = await checkpoints.fork(request.params.id, { name: requiredString(body.name, 'name'),
      branch: stringValue(body.branch),
      targetPath: stringValue(body.target_path ?? body.targetPath ?? body.worktree_path ?? body.worktreePath) })
    events.append({ boardId: workspace.board_id, workspaceId: workspace.id, cardId: workspace.card_id,
      kind: 'checkpoint.forked', source: 'runtime', payload: { checkpoint_id: request.params.id, workspace_id: workspace.id } })
    return reply.code(201).send({ workspace })
  })

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/boards/:id/jobs', (request) => {
    const boardId = board(db, request.params.id)
    return { jobs: scheduler.listBoard(boardId, request.query.status) }
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/boards/:id/jobs', async (request, reply) => {
    requireOperator(request)
    const boardId = board(db, request.params.id)
    const body = objectBody(request.body)
    const cardId = optionalPositiveId(body.card_id ?? body.cardId, 'card_id')
    const workspaceValue = cardId && Object.prototype.hasOwnProperty.call(body, 'workspace_id')
      ? body.workspace_id : body.workspace_id ?? body.workspaceId
    const workspaceId = cardId && workspaceValue === undefined ? undefined : nullableValue(workspaceValue)
    const provider = requiredString(body.provider, 'provider')
    const model = nullableValue(body.model)
    const priority = cardId && body.priority === undefined
      ? undefined : optionalSignedInteger(body.priority, 0, 'priority')
    const maxAttempts = boundedInteger(body.max_attempts ?? body.maxAttempts, 1, 1, 100, 'max_attempts')
    const budgetTokensValue = cardId && Object.prototype.hasOwnProperty.call(body, 'budget_tokens')
      ? body.budget_tokens : body.budget_tokens ?? body.budgetTokens
    const budgetCentsValue = cardId && Object.prototype.hasOwnProperty.call(body, 'budget_cents')
      ? body.budget_cents : body.budget_cents ?? body.budgetCents
    const budgetTokens = cardId && budgetTokensValue === undefined
      ? undefined : optionalNonNegative(budgetTokensValue, 'budget_tokens')
    const budgetCents = cardId && budgetCentsValue === undefined
      ? undefined : optionalNonNegative(budgetCentsValue, 'budget_cents')
    const scheduledAt = stringValue(body.scheduled_at ?? body.scheduledAt)
    if (cardId) {
      const scopedCard = db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as { board_id: number } | undefined
      if (!scopedCard) throw new NotFoundError('card not found')
      if (scopedCard.board_id !== boardId) throw new ValidationError('card belongs to a different board')
      const idempotencyKey = resolveIdempotencyKey({
        header: request.headers['idempotency-key'],
        rawHeaders: request.raw.rawHeaders,
        snake: body.idempotency_key,
        camel: body.idempotencyKey,
      })
      const launchInput = { cardId, expectedBoardId: boardId, workspaceId,
        provider, model, effort: null, priority, maxAttempts, budgetTokens, budgetCents, scheduledAt,
        idempotencyKey }
      const launched = await orchestration.launchCard(launchInput)
      const identity = orchestrationIdentity('canonical', launched)
      return reply.code(201).send({
        mode: 'canonical',
        orchestration: identity,
        contract: launched.contract,
        job: launched.job,
        delivery: { ...launched.delivery, contract_id: identity.contract_id },
        workspace: launched.workspace,
        session: launched.session,
        dispatch: launched.dispatch,
        dispatch_error: launched.dispatch_error,
      })
    }
    const created = scheduler.create({ boardId, cardId, workspaceId, provider, model, priority,
      maxAttempts, budgetTokens, budgetCents, scheduledAt })
    await scheduler.tick()
    return reply.code(201).send({ job: scheduler.get(created.id) })
  })
  app.get<{ Params: { id: string } }>('/jobs/:id', (request) => {
    const snapshot = orchestration.getJobSnapshot(request.params.id)
    const identity = orchestrationIdentity('canonical', snapshot)
    const jobEvents = events.listBoard(snapshot.job.board_id, { jobId: snapshot.job.id, limit: 500 })
    if (!identity.contract_id || !identity.correlation_id || !jobEvents.length
      || jobEvents.some((event) =>
        event.workspace_id !== snapshot.workspace?.id
        || event.card_id !== snapshot.job.card_id
        || event.contract_id !== identity.contract_id
        || event.correlation_id !== identity.correlation_id
        || (event.session_id !== null && event.session_id !== snapshot.session?.id))) {
      throw new ConflictError('canonical job event scope is missing or inconsistent')
    }
    return {
      mode: 'canonical',
      orchestration: identity,
      contract: snapshot.contract,
      delivery: { ...snapshot.delivery, contract_id: identity.contract_id },
      job: snapshot.job,
      workspace: snapshot.workspace,
      session: snapshot.session,
      events: jobEvents,
    }
  })
  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (request) => {
    requireOperator(request)
    return { job: await scheduler.cancel(request.params.id) }
  })

  app.get<{ Params: { id: string } }>('/boards/:id/conflicts', (request) => {
    const boardId = board(db, request.params.id)
    return { conflicts: workspaces.conflicts(boardId) }
  })

  app.get('/drivers', () => ({ drivers: descriptors(options.drivers, [
    { id: 'claude', available: false, capabilities: ['launch', 'attach', 'send', 'interrupt', 'events'], detail: 'requires the Conductor driver adapter' },
    { id: 'shell', available: !!options.runtime, capabilities: ['launch', 'input', 'resize', 'signal', 'events'], detail: options.runtime ? undefined : 'requires the PTY runtime' },
  ]) }))
  app.get('/plugins', () => ({ plugins: descriptors(options.plugins, [
    { id: 'agent-os-core', name: 'Agent OS Core', version: '1', capabilities: ['events', 'artifacts', 'contracts', 'attention', 'policies', 'checkpoints', 'jobs', 'evidence', 'deliveries'] },
  ]) }))

  // Keep the store referenced: artifacts are deliberately durable and never receive a delete route.
  void artifacts
}

function board(db: Database.Database, value: string): number {
  const id = positiveId(value, 'board id')
  if (!db.prepare('SELECT 1 FROM boards WHERE id=?').get(id)) throw new NotFoundError('board not found')
  return id
}

function requireWorkspace(store: WorkspaceStore, id: string): Workspace {
  const workspace = store.get(id)
  if (!workspace) throw new NotFoundError('workspace not found')
  return workspace
}

function listProcesses(db: Database.Database, workspaceId: string): ProcessRecord[] {
  return (db.prepare('SELECT * FROM processes WHERE workspace_id=? ORDER BY started_at DESC, rowid DESC').all(workspaceId) as Record<string, unknown>[])
    .map(mapProcess)
}

function requireProcess(db: Database.Database, id: string): ProcessRecord {
  const row = db.prepare('SELECT * FROM processes WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!row) throw new NotFoundError('process not found')
  return mapProcess(row)
}

function mapProcess(row: Record<string, unknown>): ProcessRecord {
  return {
    id: String(row.id), workspace_id: String(row.workspace_id), name: String(row.name), command: String(row.command),
    cwd: String(row.cwd), status: String(row.status), pid: row.pid == null ? null : Number(row.pid),
    exit_code: row.exit_code == null ? null : Number(row.exit_code), cols: Number(row.cols), rows: Number(row.rows),
    restartable: Number(row.restartable) === 1, started_at: row.started_at == null ? null : String(row.started_at),
    ended_at: row.ended_at == null ? null : String(row.ended_at),
  }
}

function optionalPositiveId(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null
  return positiveId(value, field)
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ValidationError('value must be a string')
  return value
}

function nullableValue(value: unknown): string | null {
  return stringValue(value) ?? null
}

function envObject(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { throw new ValidationError('env must be an object') }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('env must be an object')
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new ValidationError('env values must be strings')
    env[key] = item
  }
  return env
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ValidationError(`${field} must be an integer from ${min} to ${max}`)
  return number
}

function optionalSignedInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new ValidationError(`${field} must be an integer`)
  return number
}

function optionalNonNegative(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new ValidationError(`${field} must be a non-negative integer`)
  return number
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} must be an object`)
  return value as Record<string, unknown>
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`)
  return value
}

function resultHasOverride(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && ('override' in value || (value as Record<string, unknown>).outcome === 'overridden')
}

function operatorizeOverrides(values: unknown[]): unknown[] {
  return values.map((value) => {
    if (!resultHasOverride(value)) return value
    const row = value as Record<string, unknown>
    const raw = row.override
    const override = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}
    return { ...row, override: { reason: override.reason, actor: 'human' } }
  })
}

function descriptors<T>(source: T[] | (() => T[]) | undefined, fallback: T[]): T[] {
  return typeof source === 'function' ? source() : source ?? fallback
}

async function asyncDescriptors<T>(
  source: T[] | (() => T[] | Promise<T[]>) | undefined,
  fallback: T[],
): Promise<T[]> {
  return typeof source === 'function' ? await source() : source ?? fallback
}

function gitHead(workspace: Workspace): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace.worktree_path ?? workspace.root_path,
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new ValidationError('git head could not be captured from the workspace; provide git_head or enable the runtime capture hook')
  }
}
