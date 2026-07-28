import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactStore,
  contextBuildId,
  contextManifestFingerprint,
  contextRequestFingerprint,
  contextUseId,
  DeliveryReportService,
  generateVerifiedDeliverySummary,
  knowledgeChunkId,
  knowledgeSourceId,
  knowledgeSourceSetFingerprint,
  KnowledgeStore,
  OrchestrationService,
  TaskContractService,
  type ContextBuild,
  type ContextBuildEntry,
  type ContextRequestIdentityInput,
  type ContextUse,
  type DeliveryReport,
  type KnowledgeChunk,
  type KnowledgeSource,
  type KnowledgeSourceSetEntry,
  type KnowledgeTargetLinks,
} from '../src/agent-os/index.js'
import {
  JobScheduler,
  type Job,
  type JobExecutionResult,
  type JobExecutor,
} from '../src/agent-os/scheduler.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'

const SOURCE_COMMIT = 'a'.repeat(40)
const servers: FastifyInstance[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
})

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

class CompletedAcceptanceExecutor implements JobExecutor {
  supportedProviders(): readonly string[] {
    return ['codex']
  }

  async execute(job: Job): Promise<JobExecutionResult> {
    return {
      status: 'succeeded',
      detail: {
        acceptance_stage: 'provider_result_recorded',
        job_id: job.id,
      },
    }
  }
}

interface CanonicalLaunch {
  contract: { version: number }
  job: { id: string; status: string }
  delivery: { id: string }
  workspace: { id: string }
  session: { id: string }
  dispatch: {
    started: string[]
    completed: string[]
    blocked: string[]
    deferred: string[]
  }
}

async function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/acceptance-repo', 'North-star acceptance')",
  ).run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Retain accepted delivery knowledge',
      'Carry a canonical request into exact, reusable knowledge evidence')`)
    .run(boardId).lastInsertRowid)
  new TaskContractService(db).put(cardId, {
    objective: 'Deliver and retain a verified request-to-knowledge result.',
    deliverables: ['Verified implementation', 'Reusable knowledge record'],
    acceptance_criteria: [
      'The requested work is supported by scoped evidence',
      'A later request cites the accepted delivery exactly',
    ],
    verify_commands: ['npm test'],
    non_goals: ['No provider-native network turn'],
    risks: ['Unverified claims must not become trusted knowledge'],
  })

  const executor = new CompletedAcceptanceExecutor()
  const scheduler = new JobScheduler(db, executor)
  const orchestration = new OrchestrationService(db, scheduler, {
    materialize: async (workspace) =>
      new WorkspaceStore(db).update(workspace.id, { status: 'active' }),
  })
  const conductor: ConductorLike = {
    isHired: () => false,
    hire: () => ({}),
    deliver: () => true,
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: () => {
      throw new Error('legacy launch must not run in north-star acceptance')
    },
    isLaunched: () => false,
    providerCatalog: async () => [],
  }
  const server = buildServer(db, () => conductor, {
    agentOs: {
      jobExecutor: executor,
      scheduler,
      orchestration,
      drivers: [{ id: 'codex', available: true, capabilities: ['launch'] }],
    },
  })
  servers.push(server)
  await server.ready()
  return { db, boardId, cardId, server }
}

async function launch(
  setup: Awaited<ReturnType<typeof fixture>>,
  idempotencyKey: string,
): Promise<CanonicalLaunch> {
  const response = await setup.server.inject({
    method: 'POST',
    url: `/api/v1/os/boards/${setup.boardId}/jobs`,
    payload: {
      card_id: setup.cardId,
      provider: 'codex',
      model: 'gpt-north-star-acceptance',
      idempotency_key: idempotencyKey,
    },
  })
  const body = response.json()
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(body.error ?? `HTTP ${response.statusCode}`)
  }
  return body as CanonicalLaunch
}

function acceptDelivery(
  setup: Awaited<ReturnType<typeof fixture>>,
  launched: CanonicalLaunch,
): DeliveryReport {
  const deliveries = new DeliveryReportService(setup.db)
  const draft = deliveries.get(launched.delivery.id)
  const submitted = deliveries.submit(draft.id, {
    actor: 'acceptance-agent',
    summary: 'Implemented the requested lifecycle and retained exact evidence.',
    deliveredItems: draft.asked.deliverables.map((item) => ({
      deliverableId: item.id,
      text: item.text,
    })),
    claims: draft.asked.acceptance_criteria.map((item) => ({
      criterionId: item.id,
      text: item.text,
    })),
    changedFiles: ['test/north-star-request-to-knowledge-acceptance.test.ts'],
    commits: ['base009-acceptance'],
  })
  return verifyAndAcceptDelivery(setup, launched, submitted)
}

function verifyAndAcceptDelivery(
  setup: Awaited<ReturnType<typeof fixture>>,
  launched: CanonicalLaunch,
  submitted: DeliveryReport,
): DeliveryReport {
  const deliveries = new DeliveryReportService(setup.db)
  const artifact = new ArtifactStore(setup.db).create({
    boardId: setup.boardId,
    cardId: setup.cardId,
    workspaceId: launched.workspace.id,
    kind: 'test_report',
    name: 'north-star-acceptance.txt',
    content: 'Observed request-to-knowledge acceptance evidence.',
  })
  const evidenceRefs = [{
    kind: 'artifact' as const,
    ref: artifact.id,
    label: 'North-star acceptance evidence',
  }]
  const verified = deliveries.verify(submitted.id, {
    actor: 'acceptance-verifier',
    deliverableResults: submitted.asked.deliverables.map((item) => ({
      deliverableId: item.id,
      outcome: 'met',
      evidenceRefs,
    })),
    results: submitted.asked.acceptance_criteria.map((item) => ({
      criterionId: item.id,
      outcome: 'met',
      evidenceRefs,
    })),
  })
  return deliveries.accept(verified.id, {
    actor: 'acceptance-reviewer',
    note: 'Every required result has exact scoped evidence.',
  })
}

function targetLinks(
  setup: Awaited<ReturnType<typeof fixture>>,
  launched: CanonicalLaunch,
  contractSnapshotSha256: string,
): KnowledgeTargetLinks {
  return {
    board_id: setup.boardId,
    workspace_id: launched.workspace.id,
    card_id: setup.cardId,
    contract_ref: `card:${setup.cardId}:v${launched.contract.version}`,
    contract_version: launched.contract.version,
    contract_snapshot_sha256: contractSnapshotSha256,
    job_id: launched.job.id,
    profile_id: null,
    session_id: launched.session.id,
    delivery_report_id: launched.delivery.id,
  }
}

function verifiedDeliveryKnowledge(
  setup: Awaited<ReturnType<typeof fixture>>,
  launched: CanonicalLaunch,
  report: DeliveryReport,
): { source: KnowledgeSource; chunk: KnowledgeChunk; summaryJson: string } {
  const generated = generateVerifiedDeliverySummary({
    latestAcceptedReport: report,
    currentReport: report,
  })
  const content = generated.json
  const contentSha256 = sha256(content)
  const locator = `deliveries/${report.id}/verified-summary.json`
  const at = report.accepted_at ?? report.updated_at
  const targets = targetLinks(setup, launched, sha256(JSON.stringify(report.asked)))
  const sourceWithoutId: Omit<KnowledgeSource, 'id'> = {
    source_kind: 'verified_delivery',
    trust_class: 'evidence',
    title: `Accepted delivery ${report.id}`,
    locator,
    normalized_locator: locator,
    source_revision: `delivery:${report.id}:revision:${report.sequence}`,
    content_sha256: contentSha256,
    freshness_policy: 'manual_until_superseded',
    freshness_state: 'fresh',
    redaction_state: 'none',
    content_state: 'present',
    ingest_state: 'active',
    access_scope: { kind: 'board' },
    targets,
    provenance: {
      repository_key: 'base009-acceptance',
      base_commit_sha: SOURCE_COMMIT,
      worktree_state_hash: null,
      relative_root: '.',
      adapter_id: 'verified-delivery-acceptance',
      adapter_version: '1.0.0',
      adapter_index_commit_sha: null,
      observed_at: at,
    },
    created_at: at,
    updated_at: at,
  }
  const source: KnowledgeSource = {
    ...sourceWithoutId,
    id: knowledgeSourceId({
      repository_key: sourceWithoutId.provenance.repository_key,
      source_kind: sourceWithoutId.source_kind,
      normalized_locator: sourceWithoutId.normalized_locator,
      source_revision: sourceWithoutId.source_revision,
      content_sha256: sourceWithoutId.content_sha256,
    }),
  }
  const sourceRange = {
    start_line: 1,
    end_line: content.trimEnd().split('\n').length,
    start_byte: 0,
    end_byte: Buffer.byteLength(content, 'utf8'),
  }
  const chunkWithoutId: Omit<KnowledgeChunk, 'id'> = {
    source_id: source.id,
    ordinal: 0,
    content,
    content_sha256: contentSha256,
    character_count: content.length,
    byte_count: Buffer.byteLength(content, 'utf8'),
    estimated_tokens: Math.max(1, Math.ceil(content.length / 4)),
    source_range: sourceRange,
    symbol: null,
    created_at: at,
  }
  return {
    source,
    chunk: {
      ...chunkWithoutId,
      id: knowledgeChunkId({
        source_id: source.id,
        ordinal: chunkWithoutId.ordinal,
        content_sha256: chunkWithoutId.content_sha256,
        source_range: chunkWithoutId.source_range,
      }),
    },
    summaryJson: generated.json,
  }
}

function followUpContext(
  setup: Awaited<ReturnType<typeof fixture>>,
  launched: CanonicalLaunch,
  source: KnowledgeSource,
  chunk: KnowledgeChunk,
): {
  build: ContextBuild
  request: ContextRequestIdentityInput
  sourceSet: KnowledgeSourceSetEntry[]
  use: ContextUse
  completedAt: string
} {
  const createdAt = new Date().toISOString()
  const injectedAt = new Date(Date.parse(createdAt) + 1).toISOString()
  const completedAt = new Date(Date.parse(createdAt) + 2).toISOString()
  const targets = targetLinks(
    setup,
    launched,
    sha256(JSON.stringify(
      new DeliveryReportService(setup.db).get(launched.delivery.id).asked,
    )),
  )
  const request: ContextRequestIdentityInput = {
    board_id: setup.boardId,
    access_scope: { kind: 'job', job_id: launched.job.id },
    targets,
    budget: {
      max_tokens: chunk.estimated_tokens + 16,
      max_characters: chunk.character_count + 256,
      sections: {
        verified_deliveries: {
          max_tokens: chunk.estimated_tokens + 16,
          max_characters: chunk.character_count + 256,
        },
      },
    },
    selection_request_sha256: sha256(
      `reuse:${launched.job.id}:${source.id}:${chunk.id}`,
    ),
  }
  const sourceSet: KnowledgeSourceSetEntry[] = [{
    source_id: source.id,
    source_revision: source.source_revision,
    content_sha256: source.content_sha256,
    freshness_state: source.freshness_state,
    redaction_state: source.redaction_state,
  }]
  const entry: ContextBuildEntry = {
    source_id: source.id,
    chunk_id: chunk.id,
    section: 'verified_deliveries',
    candidate_ordinal: 0,
    selected_ordinal: 0,
    decision: 'selected',
    reason: 'within_budget',
    score_components: {
      authority_micros: 1_000_000,
      relevance_micros: 1_000_000,
      freshness_micros: 1_000_000,
      recency_micros: 1_000_000,
      contract_micros: 1_000_000,
      pin_micros: 0,
    },
    score_micros: 5_000_000,
    rendering: 'full',
    estimated_tokens: chunk.estimated_tokens,
    character_count: chunk.character_count,
    source_kind: source.source_kind,
    trust_class: source.trust_class,
    freshness_state: source.freshness_state,
    redaction_state: source.redaction_state,
    normalized_locator: source.normalized_locator,
    source_range: chunk.source_range,
    content_sha256: chunk.content_sha256,
  }
  const manifestFingerprint = contextManifestFingerprint([entry])
  const sourceSetFingerprint = knowledgeSourceSetFingerprint(sourceSet)
  const build: ContextBuild = {
    id: contextBuildId({
      request,
      source_set_fingerprint: sourceSetFingerprint,
      manifest_fingerprint: manifestFingerprint,
    }),
    board_id: setup.boardId,
    access_scope: request.access_scope,
    targets: request.targets,
    request_fingerprint: contextRequestFingerprint(request),
    source_set_fingerprint: sourceSetFingerprint,
    manifest_fingerprint: manifestFingerprint,
    budget: request.budget,
    usage: {
      used_tokens: chunk.estimated_tokens,
      used_characters: chunk.character_count,
      sections: {
        verified_deliveries: {
          used_tokens: chunk.estimated_tokens,
          used_characters: chunk.character_count,
        },
      },
    },
    entries: [entry],
    status: 'built',
    created_at: createdAt,
    invalidated_at: null,
  }
  const useWithoutId: Omit<ContextUse, 'id'> = {
    context_build_id: build.id,
    board_id: setup.boardId,
    job_id: launched.job.id,
    session_id: launched.session.id,
    injection_ordinal: 0,
    manifest_fingerprint: build.manifest_fingerprint,
    estimated_tokens: build.usage.used_tokens,
    actual_tokens: null,
    cache_identity: `verified-delivery:${source.id}`,
    outcome: 'running',
    injected_at: injectedAt,
    completed_at: null,
  }
  return {
    build,
    request,
    sourceSet,
    use: {
      ...useWithoutId,
      id: contextUseId({
        context_build_id: useWithoutId.context_build_id,
        job_id: useWithoutId.job_id,
        session_id: useWithoutId.session_id,
        injection_ordinal: useWithoutId.injection_ordinal,
      }),
    },
    completedAt,
  }
}

describe('BASE-009 north-star request-to-knowledge acceptance', () => {
  it('carries one canonical request through accepted evidence into cited follow-up context', async () => {
    const setup = await fixture()
    const first = await launch(setup, 'base009-first-request')
    expect(first.job.status).toBe('succeeded')
    expect(first.dispatch).toMatchObject({
      started: [first.job.id],
      completed: [first.job.id],
      blocked: [],
      deferred: [],
    })

    const accepted = acceptDelivery(setup, first)
    const promoted = verifiedDeliveryKnowledge(setup, first, accepted)
    const store = new KnowledgeStore(setup.db)
    expect(store.putSource(promoted.source)).toEqual(promoted.source)
    expect(store.putChunk(setup.boardId, promoted.chunk)).toEqual(promoted.chunk)

    const followUp = await launch(setup, 'base009-follow-up-request')
    const context = followUpContext(
      setup,
      followUp,
      promoted.source,
      promoted.chunk,
    )
    expect(store.putContextBuild({
      build: context.build,
      request: context.request,
      source_set: context.sourceSet,
    })).toMatchObject({
      id: context.build.id,
      status: 'built',
      entries: [{
        source_id: promoted.source.id,
        chunk_id: promoted.chunk.id,
        section: 'verified_deliveries',
        decision: 'selected',
      }],
    })
    expect(store.putContextUse(context.use)).toEqual(context.use)
    const completed = store.finishContextUse({
      board_id: setup.boardId,
      context_use_id: context.use.id,
      outcome: 'completed',
      actual_tokens: promoted.chunk.estimated_tokens,
      completed_at: context.completedAt,
    })

    expect(accepted).toMatchObject({
      status: 'accepted',
      job_id: first.job.id,
      session_id: first.session.id,
      workspace_id: first.workspace.id,
    })
    expect(promoted.source).toMatchObject({
      source_kind: 'verified_delivery',
      trust_class: 'evidence',
      access_scope: { kind: 'board' },
      targets: {
        job_id: first.job.id,
        session_id: first.session.id,
        workspace_id: first.workspace.id,
        delivery_report_id: first.delivery.id,
      },
    })
    expect(JSON.parse(promoted.summaryJson)).toMatchObject({
      format: 'verified-delivery-summary',
      verification: { report_status: 'accepted' },
      provenance: { report_id: first.delivery.id },
    })
    expect(context.build.targets).toMatchObject({
      job_id: followUp.job.id,
      session_id: followUp.session.id,
      delivery_report_id: followUp.delivery.id,
    })
    expect(completed).toMatchObject({
      context_build_id: context.build.id,
      job_id: followUp.job.id,
      session_id: followUp.session.id,
      outcome: 'completed',
      actual_tokens: promoted.chunk.estimated_tokens,
    })

    expect(store.putSource(promoted.source)).toEqual(promoted.source)
    expect(store.putChunk(setup.boardId, promoted.chunk)).toEqual(promoted.chunk)
    expect(store.putContextBuild({
      build: context.build,
      request: context.request,
      source_set: context.sourceSet,
    })).toMatchObject({ id: context.build.id, status: 'used' })
    expect(store.putContextUse(context.use)).toEqual(completed)
    expect(setup.db.prepare(`SELECT
      (SELECT COUNT(*) FROM jobs) AS jobs,
      (SELECT COUNT(*) FROM agent_sessions) AS sessions,
      (SELECT COUNT(*) FROM delivery_reports) AS reports,
      (SELECT COUNT(*) FROM knowledge_sources) AS sources,
      (SELECT COUNT(*) FROM knowledge_chunks) AS chunks,
      (SELECT COUNT(*) FROM context_builds) AS builds,
      (SELECT COUNT(*) FROM context_uses) AS uses`).get()).toEqual({
      jobs: 2,
      sessions: 2,
      reports: 2,
      sources: 1,
      chunks: 1,
      builds: 1,
      uses: 1,
    })
    expect((setup.db.prepare(
      'SELECT kind FROM os_events WHERE board_id=? ORDER BY rowid',
    ).all(setup.boardId) as Array<{ kind: string }>).map((row) => row.kind))
      .toEqual(expect.arrayContaining([
        'orchestration.launch_requested',
        'job.succeeded',
        'delivery.submitted',
        'delivery.verified',
        'delivery.accepted',
      ]))
  })

  it('rejects unaccepted promotion and forged lifecycle scope without partial knowledge', async () => {
    const setup = await fixture()
    const launched = await launch(setup, 'base009-negative-request')
    const deliveries = new DeliveryReportService(setup.db)
    const draft = deliveries.get(launched.delivery.id)
    const submitted = deliveries.submit(draft.id, {
      actor: 'acceptance-agent',
      summary: 'Claimed work without verification.',
      deliveredItems: draft.asked.deliverables.map((item) => ({
        deliverableId: item.id,
        text: item.text,
      })),
    })

    expect(() => verifiedDeliveryKnowledge(setup, launched, submitted))
      .toThrow(/accepted status/)
    expect(setup.db.prepare(`SELECT
      (SELECT COUNT(*) FROM knowledge_sources) AS sources,
      (SELECT COUNT(*) FROM knowledge_chunks) AS chunks`).get())
      .toEqual({ sources: 0, chunks: 0 })

    const accepted = verifyAndAcceptDelivery(setup, launched, submitted)
    const promoted = verifiedDeliveryKnowledge(setup, launched, accepted)
    const forged = {
      ...promoted.source,
      targets: {
        ...promoted.source.targets,
        session_id: 'missing-session',
      },
    }
    const store = new KnowledgeStore(setup.db)
    expect(() => store.putSource(forged)).toThrow(/scope is invalid/)
    expect(setup.db.prepare(`SELECT
      (SELECT COUNT(*) FROM knowledge_sources) AS sources,
      (SELECT COUNT(*) FROM knowledge_chunks) AS chunks`).get())
      .toEqual({ sources: 0, chunks: 0 })
  })
})
