import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http, { type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'
import { openDb } from '../../src/db.js'
import { acquireDaemonLease, type DaemonLease } from '../../src/agent-os/daemon-lease.js'
import {
  OperationsRecoveryService,
  classifyOperationsFailure,
  installOperationsRecoverySchema,
} from '../../src/agent-os/operations-recovery.js'
import { JobScheduler } from '../../src/agent-os/scheduler.js'
import type {
  AdversarialAction,
  AdversarialObservation,
  RemoteOpsAdversarialTarget,
} from './remote-ops-adversarial-contract.js'

const FIXED_NOW = Date.parse('2026-08-02T12:00:00.000Z')
const DEAD_PID = 2_147_483_647
const LIFECYCLE_TRANSITIONS = new Set([
  'contract-created',
  'job-queued',
  'job-claimed',
  'session-created',
  'provider-launching',
  'provider-running',
  'delivery-submitted',
  'outbox-pending',
])

type Fault = 'disk-full' | 'database-locked' | 'provider-unavailable' | 'git-conflict'

type ActiveFixture = {
  jobId: string | null
  cardId: number
  sessionId: string | null
  processId: string | null
  child: ChildProcess | null
}

type LifecycleEvidence = {
  contracts: number
  queuedJobs: number
  runningJobs: number
  startingSessions: number
  runningSessions: number
  startingProcesses: number
  runningProcesses: number
  submittedDeliveries: number
  pendingOutbox: number
}

/**
 * Deterministic adapter for the repository's OPS-CHAOS-01..04 contract.
 *
 * It deliberately uses the same SQLite migrations, scheduler, daemon lease, orphan recovery,
 * transactional outbox and stable failure classifier as the production daemon. Network loss is
 * exercised against a real loopback socket, database locking uses a second SQLite connection,
 * disk-full uses SQLite's page limit, and the Git case executes the Git merge engine. No user
 * state, provider credentials, shared checkout, or external network are touched.
 */
export class ProductionOperationsChaosTarget implements RemoteOpsAdversarialTarget {
  private root = ''
  private databasePath = ''
  private projectPath = ''
  private db!: Database.Database
  private recovery!: OperationsRecoveryService
  private scheduler!: JobScheduler
  private boardId = 0
  private workspaceId = ''
  private lease: DaemonLease | null = null
  private staleLease: DaemonLease | null = null
  private currentLeaseOwner: string | null = null
  private staleLeaseOwner: string | null = null
  private fixtures: ActiveFixture[] = []
  private expectedCardIds = new Set<number>()
  private expectedContractCardIds = new Set<number>()
  private expectedJobIds = new Set<string>()
  private expectedSessionIds = new Set<string>()
  private expectedProcessIds = new Set<string>()
  private expectedOutboxIds = new Set<string>()
  private expectedDeliveryReportIds = new Set<string>()
  private fault: Fault | null = null
  private lockDb: BetterSqlite3.Database | null = null
  private networkServer: Server | null = null
  private networkPort = 0
  private clockMs = FIXED_NOW
  private crashed = false
  private runtimeGeneration = 0

  async reset(): Promise<void> {
    await this.disposeRuntime()
    if (this.root) fs.rmSync(this.root, { recursive: true, force: true })
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-production-chaos-'))
    this.databasePath = path.join(this.root, 'orchestra.db')
    this.projectPath = path.join(this.root, 'project')
    fs.mkdirSync(this.projectPath, { recursive: true })
    this.expectedCardIds.clear()
    this.expectedContractCardIds.clear()
    this.expectedJobIds.clear()
    this.expectedSessionIds.clear()
    this.expectedProcessIds.clear()
    this.expectedOutboxIds.clear()
    this.expectedDeliveryReportIds.clear()
    this.fixtures = []
    this.fault = null
    this.networkPort = 0
    this.clockMs = FIXED_NOW
    this.crashed = false
    this.runtimeGeneration = 0
    this.staleLease = null
    this.staleLeaseOwner = null
    this.openRuntime()
    this.db.exec(`CREATE TABLE IF NOT EXISTS qa16_network_effects (
      idempotency_key TEXT PRIMARY KEY,
      delivered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa16_fault_pressure (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa16_critical_mutations (
      idempotency_key TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      outbox_id TEXT NOT NULL REFERENCES ops_outbox(id),
      prepared_at TEXT NOT NULL,
      applied_at TEXT
    );
    CREATE TABLE IF NOT EXISTS qa16_critical_effects (
      idempotency_key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`)
  }

  async close(): Promise<void> {
    await this.disposeRuntime()
    if (this.root) fs.rmSync(this.root, { recursive: true, force: true })
    this.root = ''
  }

  async perform(action: AdversarialAction): Promise<AdversarialObservation> {
    switch (action.op) {
      case 'chaos.seed-active-work':
        return this.seedActiveWork(Number(action.agents), String(action.transition))
      case 'chaos.crash':
        return this.crashRuntime(String(action.transition))
      case 'chaos.restart':
        return this.restartRuntime()
      case 'chaos.inspect':
        return this.inspect()
      case 'chaos.block-old-shutdown-writes':
        return this.blockOldShutdownWrites()
      case 'chaos.restart-replacement':
        return this.restartReplacement()
      case 'chaos.release-old-shutdown-writes':
        return this.releaseOldShutdownWrites()
      case 'outbox.seed':
        return this.seedOutbox(Number(action.events))
      case 'outbox.deliver-and-crash-before-ack':
        return this.deliverAndInterrupt(Number(action.eventIndex))
      case 'outbox.drain':
        return this.drainOutbox()
      case 'outbox.inspect':
        return this.inspectOutbox()
      case 'chaos.inject-fault':
        return this.injectFault(String(action.fault), String(action.idempotencyKey ?? ''))
      case 'chaos.clear-fault':
        return this.clearFault(String(action.fault))
      case 'chaos.run-critical-mutation':
        return this.runCriticalMutation(String(action.idempotencyKey))
      default:
        return { status: 501, error: 'unsupported production chaos operation' }
    }
  }

  private openRuntime(): void {
    this.db = openDb(this.databasePath)
    this.db.pragma('busy_timeout = 1')
    installOperationsRecoverySchema(this.db)
    this.recovery = new OperationsRecoveryService(this.db)
    this.scheduler = new JobScheduler(this.db)
    const board = this.db.prepare(`INSERT INTO boards (project_path, name)
      VALUES (?, 'QA-016 production chaos')`).run(this.projectPath)
    this.boardId = Number(board.lastInsertRowid)
    this.workspaceId = `qa16-workspace-${this.boardId}`
    this.db.prepare(`INSERT INTO workspaces (
      id, board_id, name, kind, root_path, status
    ) VALUES (?, ?, 'QA-016 isolated workspace', 'shared', ?, 'active')`)
      .run(this.workspaceId, this.boardId, this.projectPath)
    this.lease = acquireDaemonLease(this.db)
    this.currentLeaseOwner = this.lease.ownerId
    this.runtimeGeneration += 1
  }

  private reopenRuntime(): void {
    this.db = openDb(this.databasePath)
    this.db.pragma('busy_timeout = 1')
    installOperationsRecoverySchema(this.db)
    this.recovery = new OperationsRecoveryService(this.db)
    this.scheduler = new JobScheduler(this.db)
    this.lease = acquireDaemonLease(this.db)
    this.currentLeaseOwner = this.lease.ownerId
    this.crashed = false
    this.runtimeGeneration += 1
  }

  private async disposeRuntime(): Promise<void> {
    await this.stopNetworkServer()
    if (this.lockDb) {
      try { this.lockDb.exec('ROLLBACK') } catch { /* no open lock transaction */ }
      try { this.lockDb.close() } catch { /* already closed */ }
      this.lockDb = null
    }
    await Promise.all(this.fixtures.map((fixture) => this.stopChild(fixture.child)))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.fixtures = []
    try { this.lease?.release() } catch { /* crash simulation may have closed SQLite */ }
    try { this.staleLease?.release() } catch { /* stale handle is intentionally fenced */ }
    this.lease = null
    this.staleLease = null
    try { this.db?.close() } catch { /* already closed */ }
  }

  private seedActiveWork(agents: number, transition: string): AdversarialObservation {
    if (!Number.isSafeInteger(agents) || agents < 1 || agents > 16 || !LIFECYCLE_TRANSITIONS.has(transition)) {
      return { status: 422, error: 'invalid active-work fixture' }
    }
    for (let index = 0; index < agents; index += 1) {
      const key = `qa16:${transition}:${index}`
      const card = this.db.prepare(`INSERT INTO cards (board_id, title, description)
        VALUES (?, ?, 'QA-016 isolated lifecycle fixture')`).run(
        this.boardId,
        `Lifecycle ${transition} ${index}`,
      )
      const cardId = Number(card.lastInsertRowid)
      this.expectedCardIds.add(cardId)
      this.db.prepare(`INSERT INTO task_contracts (
        card_id, objective, acceptance_criteria, verify_commands, workspace_id
      ) VALUES (?, ?, '["preserve durable work"]', '["qa16"]', ?)`).run(
        cardId,
        `Preserve ${transition}`,
        this.workspaceId,
      )
      this.expectedContractCardIds.add(cardId)

      let jobId: string | null = null
      let child: ChildProcess | null = null
      let sessionId: string | null = null
      let processId: string | null = null
      if (transition !== 'contract-created') {
        const job = this.scheduler.create({
          boardId: this.boardId,
          cardId,
          workspaceId: this.workspaceId,
          provider: 'codex',
          driverId: 'codex',
          contractVersion: 1,
          idempotencyKey: key,
          maxAttempts: 3,
        })
        jobId = job.id
        this.expectedJobIds.add(job.id)
      }
      if (jobId && transition !== 'job-queued') {
        this.db.prepare(`UPDATE jobs SET status='running', attempts=1, started_at=? WHERE id=?`)
          .run(this.now().toISOString(), jobId)
      }
      if (jobId && !['job-queued', 'job-claimed'].includes(transition)) {
        const sessionStatus = ['session-created', 'provider-launching'].includes(transition)
          ? 'starting'
          : 'running'
        sessionId = `qa16-session-${transition}-${index}`
        this.db.prepare(`INSERT INTO agent_sessions (
          id, workspace_id, provider, status, context_json, job_id, control_state,
          recovery_state, history_state, created_at, updated_at
        ) VALUES (?, ?, 'codex', ?, '{}', ?, 'active', 'attachable', 'complete', ?, ?)`)
          .run(
            sessionId,
            this.workspaceId,
            sessionStatus,
            jobId,
            this.now().toISOString(),
            this.now().toISOString(),
          )
        this.expectedSessionIds.add(sessionId)
      }
      if (jobId && !['job-queued', 'job-claimed', 'session-created'].includes(transition)) {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: this.projectPath,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          stdio: 'ignore',
        })
        if (!child.pid) throw new Error('supervised helper did not expose a pid')
        processId = `qa16-process-${transition}-${index}`
        const processStatus = transition === 'provider-launching' ? 'starting' : 'running'
        this.db.prepare(`INSERT INTO processes (
          id, workspace_id, name, command, cwd, status, pid, restartable
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
          .run(
            processId,
            this.workspaceId,
            `qa16-supervised-helper-${index}`,
            process.execPath,
            this.projectPath,
            processStatus,
            child.pid,
          )
        this.expectedProcessIds.add(processId)
      }
      if (jobId && (transition === 'delivery-submitted' || transition === 'outbox-pending')) {
        const reportId = `qa16-delivery-${transition}-${index}`
        this.db.prepare(`INSERT INTO delivery_reports (
          id, lineage_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
          status, asked_snapshot, summary, created_by, submitted_by, created_at, updated_at, submitted_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'submitted', ?, 'QA-016 fixture',
          'qa16', 'qa16', ?, ?, ?)`)
          .run(
            reportId,
            reportId,
            this.boardId,
            cardId,
            jobId,
            sessionId,
            this.workspaceId,
            JSON.stringify({ transition, card_id: cardId }),
            this.now().toISOString(),
            this.now().toISOString(),
            this.now().toISOString(),
          )
        this.expectedDeliveryReportIds.add(reportId)
      }
      if (jobId && transition === 'outbox-pending') {
        const row = this.recovery.enqueue({
          boardId: this.boardId,
          eventId: `qa16-delivery:${jobId}`,
          destination: 'attention',
          dedupeKey: `qa16-delivery:${jobId}`,
          payload: { job_id: jobId, transition },
          availableAt: this.now().toISOString(),
        })
        this.expectedOutboxIds.add(row.id)
      }
      this.fixtures.push({ jobId, cardId, sessionId, processId, child })
    }
    return {
      status: 201,
      transition,
      lifecycleEvidence: this.lifecycleEvidence(),
      durableIdentities: this.preservedDurableIdentities(),
    }
  }

  private crashRuntime(transition: string): AdversarialObservation {
    if (!LIFECYCLE_TRANSITIONS.has(transition)) return { status: 422, error: 'invalid transition' }
    this.closeDatabaseForCrash()
    return { status: 204, transition, databaseClosed: true, runtimeGeneration: this.runtimeGeneration }
  }

  private restartRuntime(): AdversarialObservation {
    const reopened = this.crashed
    if (reopened) this.reopenRuntime()
    const activeProcesses = new Set(this.fixtures.flatMap((fixture) =>
      fixture.processId && fixture.child?.pid && fixture.child.exitCode === null ? [fixture.processId] : []))
    const report = this.recovery.reconcileOrphans({
      ownerId: this.currentLeaseOwner!,
      now: this.now(),
      ownsProcess: ({ id }) => activeProcesses.has(id),
      ownsDaemonLease: (candidate) => candidate.ownerId === this.currentLeaseOwner,
    })
    return { status: 200, recoveryRunId: report.runId, reopened, runtimeGeneration: this.runtimeGeneration }
  }

  private blockOldShutdownWrites(): AdversarialObservation {
    if (!this.lease) return { status: 409, error: 'no active daemon lease' }
    this.staleLease = this.lease
    this.staleLeaseOwner = this.lease.ownerId
    return { status: 200, ownerId: this.staleLeaseOwner }
  }

  private restartReplacement(): AdversarialObservation {
    if (!this.staleLease || !this.staleLeaseOwner) return { status: 409, error: 'old shutdown is not blocked' }
    this.db.prepare(`UPDATE daemon_leases SET pid=? WHERE name='orchestra-daemon' AND owner_id=?`)
      .run(DEAD_PID, this.staleLeaseOwner)
    this.lease = acquireDaemonLease(this.db)
    this.currentLeaseOwner = this.lease.ownerId
    return { status: 200, ownerId: this.currentLeaseOwner }
  }

  private releaseOldShutdownWrites(): AdversarialObservation {
    if (!this.staleLease) return { status: 409, error: 'old shutdown is not blocked' }
    this.staleLease.release()
    this.staleLease = null
    return { status: 200 }
  }

  private inspect(): AdversarialObservation {
    const jobRows = this.db.prepare(`SELECT id, idempotency_key FROM jobs WHERE board_id=?`)
      .all(this.boardId) as Array<{ id: string; idempotency_key: string | null }>
    const duplicateJobs = Number((this.db.prepare(`SELECT count(*) AS count FROM (
      SELECT idempotency_key FROM jobs WHERE board_id=? AND idempotency_key IS NOT NULL
      GROUP BY idempotency_key HAVING count(*)>1
    )`).get(this.boardId) as { count: number }).count)
    const missingJobs = [...this.expectedJobIds].filter((id) => !jobRows.some((row) => row.id === id)).length
    const missingSessions = [...this.expectedSessionIds].filter((id) => !this.db.prepare(
      'SELECT 1 FROM agent_sessions WHERE id=?',
    ).get(id)).length
    const missingProcesses = [...this.expectedProcessIds].filter((id) => !this.db.prepare(
      'SELECT 1 FROM processes WHERE id=?',
    ).get(id)).length
    const missingCards = [...this.expectedCardIds].filter((id) => !this.db.prepare(
      'SELECT 1 FROM cards WHERE id=?',
    ).get(id)).length
    const missingContracts = [...this.expectedContractCardIds].filter((id) => !this.db.prepare(
      'SELECT 1 FROM task_contracts WHERE card_id=?',
    ).get(id)).length
    const missingOutbox = [...this.expectedOutboxIds].filter((id) => !this.db.prepare(
      'SELECT 1 FROM ops_outbox WHERE id=?',
    ).get(id)).length
    const missingDeliveryReports = [...this.expectedDeliveryReportIds].filter((id) => !this.db.prepare(
      'SELECT 1 FROM delivery_reports WHERE id=?',
    ).get(id)).length
    const orphanAuthority = Number((this.db.prepare(`SELECT count(*) AS count
      FROM agent_sessions session LEFT JOIN jobs job ON job.id=session.job_id
      WHERE session.status IN ('starting','running','idle')
        AND (job.id IS NULL OR job.status NOT IN ('running','cancelling'))`)
      .get() as { count: number }).count)
    const leases = this.db.prepare(`SELECT owner_id FROM daemon_leases
      WHERE name='orchestra-daemon'`).all() as Array<{ owner_id: string }>
    const staleGenerationWritesAccepted = this.staleLeaseOwner && leases[0]?.owner_id === this.staleLeaseOwner ? 1 : 0
    const activeAgents = Number((this.db.prepare(`SELECT count(*) AS count FROM agent_sessions
      WHERE status IN ('starting','running','idle')`).get() as { count: number }).count)
    const liveHelperProcesses = this.fixtures.filter((fixture) => fixture.child?.exitCode === null).length
    const preparedCriticalMutations = Number((this.db.prepare(`SELECT count(*) AS count
      FROM qa16_critical_mutations`).get() as { count: number }).count)
    const appliedCriticalMutations = Number((this.db.prepare(`SELECT count(*) AS count
      FROM qa16_critical_mutations WHERE applied_at IS NOT NULL`).get() as { count: number }).count)
    const criticalEffects = Number((this.db.prepare(`SELECT count(*) AS count
      FROM qa16_critical_effects`).get() as { count: number }).count)
    const criticalMutationIdentities = (this.db.prepare(`SELECT idempotency_key, job_id, outbox_id
      FROM qa16_critical_mutations ORDER BY idempotency_key`).all() as Array<{
        idempotency_key: string
        job_id: string
        outbox_id: string
      }>).map((row) => ({
        idempotencyKey: row.idempotency_key,
        jobId: row.job_id,
        outboxId: row.outbox_id,
      }))
    return {
      status: 200,
      duplicateJobs,
      orphanAuthority,
      silentDataLoss: missingCards + missingContracts + missingJobs + missingSessions
        + missingProcesses + missingOutbox + missingDeliveryReports,
      invalidLeases: leases.length === 1 && leases[0]?.owner_id === this.currentLeaseOwner ? 0 : 1,
      activeAgents,
      staleGenerationWritesAccepted,
      liveHelperProcesses,
      preparedCriticalMutations,
      appliedCriticalMutations,
      criticalEffects,
      criticalMutationIdentities,
      lifecycleEvidence: this.lifecycleEvidence(),
      durableIdentities: this.preservedDurableIdentities(),
    }
  }

  private seedOutbox(events: number): AdversarialObservation {
    if (!Number.isSafeInteger(events) || events < 1 || events > 100) return { status: 422 }
    for (let index = 0; index < events; index += 1) {
      const row = this.recovery.enqueue({
        boardId: this.boardId,
        eventId: `qa16-outbox-event-${index}`,
        destination: 'network',
        dedupeKey: `qa16-outbox-event-${index}`,
        payload: { index },
        maxAttempts: 4,
        availableAt: this.now().toISOString(),
      })
      this.expectedOutboxIds.add(row.id)
    }
    return { status: 201, events }
  }

  private async deliverAndInterrupt(eventIndex: number): Promise<AdversarialObservation> {
    let index = 0
    const result = await this.recovery.dispatch({
      ownerId: this.currentLeaseOwner!,
      now: this.now(),
      limit: 100,
      deliver: async (delivery) => {
        this.recovery.consumeIdempotently({
          consumer: 'qa16-network-side-effect',
          eventId: delivery.idempotencyKey,
          payload: delivery.payload,
        }, () => this.db.prepare(`INSERT INTO qa16_network_effects
          (idempotency_key, delivered_at) VALUES (?, ?)`)
          .run(delivery.idempotencyKey, this.now().toISOString()))
        if (index === eventIndex) {
          index += 1
          throw Object.assign(new Error('connection reset after remote side effect'), { code: 'ECONNRESET' })
        }
        index += 1
      },
    })
    this.closeDatabaseForCrash()
    return {
      status: 200,
      delivered: result.delivered.length,
      ambiguous: result.retried.length,
      databaseClosed: true,
      runtimeGeneration: this.runtimeGeneration,
    }
  }

  private async drainOutbox(): Promise<AdversarialObservation> {
    this.clockMs += 5_000
    const result = await this.recovery.dispatch({
      ownerId: this.currentLeaseOwner!,
      now: this.now(),
      limit: 100,
      deliver: async (delivery) => {
        this.recovery.consumeIdempotently({
          consumer: 'qa16-network-side-effect',
          eventId: delivery.idempotencyKey,
          payload: delivery.payload,
        }, () => this.db.prepare(`INSERT INTO qa16_network_effects
          (idempotency_key, delivered_at) VALUES (?, ?)`)
          .run(delivery.idempotencyKey, this.now().toISOString()))
      },
    })
    return { status: 200, delivered: result.delivered.length }
  }

  private inspectOutbox(): AdversarialObservation {
    const counts = Object.fromEntries((this.db.prepare(`SELECT status, count(*) AS count
      FROM ops_outbox GROUP BY status`).all() as Array<{ status: string; count: number }>)
      .map((row) => [row.status, Number(row.count)]))
    const logicalDeliveries = Number((this.db.prepare(`SELECT count(*) AS count
      FROM qa16_network_effects`).get() as { count: number }).count)
    const duplicateSideEffects = Number((this.db.prepare(`SELECT count(*) AS count FROM (
      SELECT idempotency_key FROM qa16_network_effects GROUP BY idempotency_key HAVING count(*)>1
    )`).get() as { count: number }).count)
    return {
      status: 200,
      pending: Number(counts.pending ?? 0) + Number(counts.delivering ?? 0),
      logicalDeliveries,
      duplicateSideEffects,
      projectionLag: Number(counts.pending ?? 0) + Number(counts.delivering ?? 0),
    }
  }

  private async injectFault(candidate: string, idempotencyKey: string): Promise<AdversarialObservation> {
    if (!['disk-full', 'database-locked', 'provider-unavailable', 'git-conflict'].includes(candidate)) {
      return { status: 422, error: 'unknown fault' }
    }
    if (!idempotencyKey || idempotencyKey.length > 256) {
      return { status: 422, error: 'idempotency key is required before fault injection' }
    }
    const prepared = this.prepareCriticalMutation(idempotencyKey)
    this.fault = candidate as Fault
    if (this.fault === 'disk-full') {
      const pageCount = Number(this.db.pragma('page_count', { simple: true }))
      this.db.pragma(`max_page_count = ${pageCount}`)
    } else if (this.fault === 'database-locked') {
      this.lockDb = new BetterSqlite3(this.databasePath)
      this.lockDb.pragma('busy_timeout = 1')
      this.lockDb.exec('BEGIN EXCLUSIVE')
    } else if (this.fault === 'provider-unavailable') {
      this.networkPort = await this.reserveNetworkPort()
    }
    return {
      status: 200,
      fault: this.fault,
      preparedCriticalMutations: 1,
      preservedJobId: prepared.jobId,
      preservedOutboxId: prepared.outboxId,
    }
  }

  private async clearFault(candidate: string): Promise<AdversarialObservation> {
    if (candidate !== this.fault) return { status: 409, error: 'fault identity mismatch' }
    if (this.fault === 'disk-full') {
      const pageCount = Number(this.db.pragma('page_count', { simple: true }))
      this.db.pragma(`max_page_count = ${pageCount + 10_000}`)
    } else if (this.fault === 'database-locked' && this.lockDb) {
      this.lockDb.exec('ROLLBACK')
      this.lockDb.close()
      this.lockDb = null
    } else if (this.fault === 'provider-unavailable') {
      await this.startNetworkServer()
    }
    this.fault = null
    return { status: 200 }
  }

  private async runCriticalMutation(idempotencyKey: string): Promise<AdversarialObservation> {
    if (!idempotencyKey || idempotencyKey.length > 256) return { status: 422 }
    const prepared = this.db.prepare(`SELECT job_id, outbox_id FROM qa16_critical_mutations
      WHERE idempotency_key=?`).get(idempotencyKey) as { job_id: string; outbox_id: string } | undefined
    if (!prepared) return { status: 409, error: 'critical mutation was not durably prepared' }
    if (this.fault === 'git-conflict') {
      const base = path.join(this.root, 'git-base.txt')
      const current = path.join(this.root, 'git-current.txt')
      const other = path.join(this.root, 'git-other.txt')
      fs.writeFileSync(base, 'line\n')
      fs.writeFileSync(current, 'current\n')
      fs.writeFileSync(other, 'other\n')
      const merge = spawnSync('git', ['merge-file', '--stdout', current, base, other], {
        cwd: this.root,
        encoding: 'utf8',
      })
      if (merge.status !== 0) return this.failure(Object.assign(new Error('git conflict'), { code: 'GIT_CONFLICT' }))
    }
    if (this.fault === 'disk-full') {
      try {
        this.db.prepare(`INSERT INTO qa16_fault_pressure(payload) VALUES (zeroblob(?))`)
          .run(1024 * 1024)
      } catch (error) {
        return this.failure(error)
      }
      return { status: 500, error: 'disk-full fault did not activate' }
    }

    try {
      const job = this.scheduler.create({
        boardId: this.boardId,
        workspaceId: this.workspaceId,
        provider: 'codex',
        driverId: 'codex',
        idempotencyKey,
        maxAttempts: 3,
      })
      this.expectedJobIds.add(job.id)
      const row = this.recovery.enqueue({
        boardId: this.boardId,
        eventId: `qa16-critical:${job.id}`,
        destination: 'network',
        dedupeKey: `qa16-critical:${idempotencyKey}`,
        payload: { job_id: job.id },
        maxAttempts: 4,
        availableAt: this.now().toISOString(),
      })
      this.expectedOutboxIds.add(row.id)
      if (this.fault === 'provider-unavailable' || this.networkServer) {
        const result = await this.recovery.dispatch({
          ownerId: this.currentLeaseOwner!,
          now: this.now(),
          limit: 100,
          deliver: async () => {
            try {
              const response = await fetch(`http://127.0.0.1:${this.networkPort}/deliver`, {
                method: 'POST',
                body: idempotencyKey,
                signal: AbortSignal.timeout(1_000),
              })
              if (!response.ok) throw new Error(`provider returned ${response.status}`)
            } catch (error) {
              throw Object.assign(new Error('provider unavailable', { cause: error }), {
                operationsCode: 'PROVIDER_UNAVAILABLE',
              })
            }
          },
        })
        if (result.retried.length || result.dead.length) {
          const stored = this.db.prepare(`SELECT last_error FROM ops_outbox WHERE id=?`)
            .get(prepared.outbox_id) as { last_error: string | null }
          const mode = stored.last_error?.replace(/^delivery_failed:/u, '') ?? 'unknown'
          const disposition = classifyOperationsFailure({ operationsCode: mode.toUpperCase() })
          this.clockMs += 5_000
          return { status: 503, failure: mode, failClosed: disposition.failClosed }
        }
      }
      const applied = this.db.transaction(() => {
        const effect = this.db.prepare(`INSERT INTO qa16_critical_effects
          (idempotency_key, applied_at) VALUES (?, ?) ON CONFLICT(idempotency_key) DO NOTHING`)
          .run(idempotencyKey, this.now().toISOString())
        this.db.prepare(`UPDATE qa16_critical_mutations SET applied_at=coalesce(applied_at, ?)
          WHERE idempotency_key=?`).run(this.now().toISOString(), idempotencyKey)
        return effect.changes
      }).immediate()
      return { status: 200, jobId: job.id, outboxId: row.id, replayed: applied === 0 }
    } catch (error) {
      return this.failure(error)
    }
  }

  private prepareCriticalMutation(idempotencyKey: string): { jobId: string; outboxId: string } {
    const job = this.scheduler.create({
      boardId: this.boardId,
      workspaceId: this.workspaceId,
      provider: 'codex',
      driverId: 'codex',
      idempotencyKey,
      maxAttempts: 3,
    })
    const row = this.recovery.enqueue({
      boardId: this.boardId,
      eventId: `qa16-critical:${job.id}`,
      destination: 'network',
      dedupeKey: `qa16-critical:${idempotencyKey}`,
      payload: { job_id: job.id },
      maxAttempts: 4,
      availableAt: this.now().toISOString(),
    })
    this.db.prepare(`INSERT INTO qa16_critical_mutations
      (idempotency_key, job_id, outbox_id, prepared_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`).run(
      idempotencyKey,
      job.id,
      row.id,
      this.now().toISOString(),
    )
    this.expectedJobIds.add(job.id)
    this.expectedOutboxIds.add(row.id)
    return { jobId: job.id, outboxId: row.id }
  }

  private lifecycleEvidence(): LifecycleEvidence {
    const scalar = (sql: string) => Number((this.db.prepare(sql).get(this.boardId) as { count: number }).count)
    return {
      contracts: scalar(`SELECT count(*) AS count FROM task_contracts contract
        JOIN cards card ON card.id=contract.card_id WHERE card.board_id=?`),
      queuedJobs: scalar(`SELECT count(*) AS count FROM jobs WHERE board_id=? AND status='queued'`),
      runningJobs: scalar(`SELECT count(*) AS count FROM jobs WHERE board_id=? AND status='running'`),
      startingSessions: scalar(`SELECT count(*) AS count FROM agent_sessions session
        JOIN workspaces workspace ON workspace.id=session.workspace_id
        WHERE workspace.board_id=? AND session.status='starting'`),
      runningSessions: scalar(`SELECT count(*) AS count FROM agent_sessions session
        JOIN workspaces workspace ON workspace.id=session.workspace_id
        WHERE workspace.board_id=? AND session.status='running'`),
      startingProcesses: scalar(`SELECT count(*) AS count FROM processes process
        JOIN workspaces workspace ON workspace.id=process.workspace_id
        WHERE workspace.board_id=? AND process.status='starting'`),
      runningProcesses: scalar(`SELECT count(*) AS count FROM processes process
        JOIN workspaces workspace ON workspace.id=process.workspace_id
        WHERE workspace.board_id=? AND process.status='running'`),
      submittedDeliveries: scalar(`SELECT count(*) AS count FROM delivery_reports
        WHERE board_id=? AND status='submitted'`),
      pendingOutbox: scalar(`SELECT count(*) AS count FROM ops_outbox
        WHERE board_id=? AND status='pending'`),
    }
  }

  private preservedDurableIdentities(): Record<string, readonly (number | string)[]> {
    const existing = <T extends number | string>(
      values: ReadonlySet<T>,
      table: string,
      column: string,
    ): T[] => [...values].filter((value) => this.db.prepare(
      `SELECT 1 FROM ${table} WHERE ${column}=?`,
    ).get(value)).sort((left, right) => String(left).localeCompare(String(right)))
    return {
      cards: existing(this.expectedCardIds, 'cards', 'id'),
      contracts: existing(this.expectedContractCardIds, 'task_contracts', 'card_id'),
      jobs: existing(this.expectedJobIds, 'jobs', 'id'),
      sessions: existing(this.expectedSessionIds, 'agent_sessions', 'id'),
      processes: existing(this.expectedProcessIds, 'processes', 'id'),
      deliveries: existing(this.expectedDeliveryReportIds, 'delivery_reports', 'id'),
      outbox: existing(this.expectedOutboxIds, 'ops_outbox', 'id'),
    }
  }

  private closeDatabaseForCrash(): void {
    this.db.prepare(`UPDATE daemon_leases SET pid=? WHERE name='orchestra-daemon' AND owner_id=?`)
      .run(DEAD_PID, this.currentLeaseOwner)
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.close()
    this.lease = null
    this.crashed = true
  }

  private failure(error: unknown): AdversarialObservation {
    const disposition = classifyOperationsFailure(error)
    const status = disposition.mode === 'git_conflict' ? 409
      : disposition.mode === 'disk_full' ? 507
        : disposition.mode === 'database_locked' ? 503 : 500
    return { status, failure: disposition.mode, failClosed: disposition.failClosed }
  }

  private now(): Date {
    return new Date(this.clockMs)
  }

  private async stopChild(child: ChildProcess | null): Promise<void> {
    if (!child?.pid || child.exitCode !== null) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('close', finish)
        child.off('error', fail)
        if (error) reject(error)
        else resolve()
      }
      const fail = (error: Error) => finish(error)
      const timer = setTimeout(
        () => finish(new Error(`supervised helper ${child.pid} did not close after SIGKILL`)),
        2_000,
      )
      timer.unref()
      child.once('close', finish)
      child.once('error', fail)
      try {
        if (!child.kill('SIGKILL')) finish(new Error(`supervised helper ${child.pid} rejected SIGKILL`))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private async reserveNetworkPort(): Promise<number> {
    const server = http.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback server did not bind a TCP port')
    const reserved = address.port
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    return reserved
  }

  private async startNetworkServer(): Promise<void> {
    this.networkServer = http.createServer((_request, response) => {
      response.statusCode = 204
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      this.networkServer!.once('error', reject)
      this.networkServer!.listen(this.networkPort, '127.0.0.1', () => resolve())
    })
  }

  private async stopNetworkServer(): Promise<void> {
    const server = this.networkServer
    this.networkServer = null
    if (!server?.listening) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
