import React, { useEffect, useState } from 'react'
import { AgentHome } from './AgentHome'
import { CommandCenterStatus } from './CommandCenter'
import { MessageThread } from './MessageThread'
import { OsIcon } from './OsIcon'
import { TrackbookPane } from './TrackbookPane'
import { WorkspaceTerminal } from './WorkspaceTerminal'
import type { Card, Snapshot, Thread } from './api'
import type {
  CanonicalLifecycleRecord,
  DeliveryCollection,
  EvidenceBundle,
  Job,
  TaskContract,
} from './osApi'
import { osApi } from './osApi'
import { commandCenterStatus } from './commandCenterModel'

type Resource<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T
  error: string | null
}

export type CommandCenterStateKind = 'loading' | 'empty' | 'stale' | 'offline' | 'error' | 'unsupported'

const STATE_COPY: Record<CommandCenterStateKind, { title: string; icon: 'refresh' | 'attention' | 'search' | 'policy' }> = {
  loading: { title: 'Loading canonical records', icon: 'refresh' },
  empty: { title: 'Nothing is recorded here yet', icon: 'search' },
  stale: { title: 'Showing the last durable state', icon: 'refresh' },
  offline: { title: 'The daemon is offline', icon: 'attention' },
  error: { title: 'This surface could not load', icon: 'attention' },
  unsupported: { title: 'This capability is unavailable', icon: 'policy' },
}

const browserSearch = () => typeof location === 'undefined' ? '' : location.search

export function CommandCenterState({
  kind,
  title,
  detail,
  action,
}: {
  kind: CommandCenterStateKind
  title?: string
  detail: string
  action?: { label: string; onClick: () => void; disabled?: boolean }
}) {
  const copy = STATE_COPY[kind]
  const role = kind === 'error' || kind === 'offline' ? 'alert' : 'status'
  return (
    <section className={`cc-state cc-state-${kind}`} role={role} aria-live="polite">
      <span className="cc-state-icon"><OsIcon name={copy.icon} /></span>
      <div><h2>{title ?? copy.title}</h2><p>{detail}</p></div>
      {action && <button type="button" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}
    </section>
  )
}

export function CanonicalAgentHome({ snaps, onChange, locationSearch = browserSearch(), readOnly = false }: {
  snaps: Snapshot[]
  onChange: () => void
  locationSearch?: string
  readOnly?: boolean
}) {
  const workspaceId = new URLSearchParams(locationSearch).get('workspace')
  if (workspaceId) {
    // the cockpit this used to open is deleted (#162); the deep link still lands on
    // the addressed workspace, now as the plain terminal
    localStorage.setItem('orchestra-terminal-workspace', workspaceId)
    return (
      <section className="cc-canonical-surface" aria-label="Canonical workspace terminal">
        <header className="cc-surface-context">
          <div><p>Canonical surface</p><h2>Workspace</h2></div>
          <span>Exact PTY · durable process</span>
        </header>
        <WorkspaceTerminal snaps={snaps} />
      </section>
    )
  }
  return (
    <section className="cc-canonical-surface" aria-label="Canonical Agent Home">
      <header className="cc-surface-context">
        <div><p>Canonical surface</p><h2>Agent Home</h2></div>
        <span>Durable identity · provider session · exact PTY</span>
      </header>
      <AgentHome snaps={snaps} onChange={onChange} readOnly={readOnly} />
    </section>
  )
}

export function CanonicalJobRoute({ jobId, snaps, stale = false, onOpenAgent, onOpenTerminal }: {
  jobId: string
  snaps: Snapshot[]
  stale?: boolean
  onOpenAgent?: (lifecycle: CanonicalLifecycleRecord) => void
  onOpenTerminal?: (lifecycle: CanonicalLifecycleRecord) => void
}) {
  const [lifecycle, setLifecycle] = useState<CanonicalLifecycleRecord | null>(null)
  const [deliveries, setDeliveries] = useState<Resource<DeliveryCollection>>({ status: 'loading', data: { deliveries: [], current: null }, error: null })
  const [evidence, setEvidence] = useState<Resource<EvidenceBundle | null>>({ status: 'loading', data: null, error: null })
  const [contract, setContract] = useState<Resource<TaskContract | null>>({ status: 'loading', data: null, error: null })

  useEffect(() => {
    let alive = true
    setLifecycle(null)
    setDeliveries({ status: 'loading', data: { deliveries: [], current: null }, error: null })
    setEvidence({ status: 'loading', data: null, error: null })
    setContract({ status: 'loading', data: null, error: null })
    void osApi.getJobLifecycle(jobId).then(async (next) => {
      if (!alive) return
      setLifecycle(next)
      const cardId = next.contract.card_id
      const [nextDeliveries, nextEvidence, nextContract] = await Promise.allSettled([
        osApi.getDeliveries(cardId),
        osApi.getEvidence(cardId),
        osApi.getContract(cardId),
      ])
      if (!alive) return
      setDeliveries(nextDeliveries.status === 'fulfilled'
        ? { status: 'ready', data: nextDeliveries.value, error: null }
        : { status: 'error', data: { deliveries: [], current: null }, error: String(nextDeliveries.reason) })
      setEvidence(nextEvidence.status === 'fulfilled'
        ? { status: 'ready', data: nextEvidence.value, error: null }
        : { status: 'error', data: null, error: String(nextEvidence.reason) })
      setContract(nextContract.status === 'fulfilled'
        ? { status: 'ready', data: nextContract.value, error: null }
        : { status: 'error', data: null, error: String(nextContract.reason) })
    }).catch((error) => {
      if (!alive) return
      setDeliveries({ status: 'error', data: { deliveries: [], current: null }, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { alive = false }
  }, [jobId])

  const cardId = lifecycle?.contract.card_id
  const card = cardId === undefined
    ? undefined
    : snaps.flatMap((snapshot) => snapshot.cards).find((candidate) => candidate.id === cardId)
  return <CanonicalJobDetail lifecycle={lifecycle} deliveries={deliveries} evidence={evidence}
    contract={contract} card={card} stale={stale}
    onOpenAgent={lifecycle && onOpenAgent ? () => onOpenAgent(lifecycle) : undefined}
    onOpenTerminal={lifecycle && onOpenTerminal ? () => onOpenTerminal(lifecycle) : undefined} />
}

export function CanonicalJobDetail({
  lifecycle,
  deliveries,
  evidence,
  contract,
  card,
  stale = false,
  onOpenAgent,
  onOpenTerminal,
}: {
  lifecycle: CanonicalLifecycleRecord | null
  deliveries: Resource<DeliveryCollection>
  evidence: Resource<EvidenceBundle | null>
  contract: Resource<TaskContract | null>
  card: Card | undefined
  stale?: boolean
  onOpenAgent?: () => void
  onOpenTerminal?: () => void
}) {
  if (!lifecycle && deliveries.status === 'loading') {
    return <CommandCenterState kind="loading" detail="Reading the durable job, frozen request, and delivery evidence." />
  }
  if (!lifecycle && deliveries.status === 'error') {
    return <CommandCenterState kind="error" detail={deliveries.error ?? 'The canonical Job Detail endpoint failed.'} />
  }
  if (!lifecycle) {
    return <CommandCenterState kind="empty" detail="Select a canonical job. A card without a Job record is not represented as a managed run." />
  }
  const job = lifecycle.job
  const session = lifecycle.session
  const workspace = lifecycle.workspace
  return (
    <article className="cc-job-detail" aria-labelledby="cc-job-detail-title">
      {stale && <CommandCenterState kind="stale" detail="New events could not be loaded. The exact durable job snapshot below may be behind the daemon." />}
      <header className="cc-detail-header">
        <div className="cc-detail-heading">
          <p>Job {job.id} · Contract v{job.contract_version ?? lifecycle.contract.version ?? '—'}</p>
          <h2 id="cc-job-detail-title">{card?.title ?? lifecycle.contract.objective}</h2>
          <span>{lifecycle.contract.objective}</span>
        </div>
        <CommandCenterStatus value={commandCenterStatus('job', job.status)} />
        <nav aria-label="Job context actions">
          <button type="button" onClick={onOpenAgent} disabled={!onOpenAgent || !session.profile_id}>
            Agent Home
          </button>
          <button type="button" onClick={onOpenTerminal} disabled={!onOpenTerminal || !workspace.id}>
            <OsIcon name="terminal" /> Terminal
          </button>
        </nav>
      </header>
      <dl className="cc-job-facts">
        <div><dt>Provider</dt><dd>{job.provider || 'Unavailable'}</dd></div>
        <div><dt>Model</dt><dd>{job.model || 'Provider default'}</dd></div>
        <div><dt>Workspace</dt><dd>{workspace.name}<small>{workspace.branch || workspace.kind}</small></dd></div>
        <div><dt>Session</dt><dd>{session.id}<small>{session.status}</small></dd></div>
        <div><dt>Attempts</dt><dd>{job.attempts} / {job.max_attempts}</dd></div>
        <div><dt>Budget</dt><dd>{job.budget_tokens === null ? 'No token cap' : `${job.budget_tokens.toLocaleString()} tokens`}</dd></div>
      </dl>
      {job.error && <div className="cc-job-error" role="alert"><OsIcon name="attention" /><span>{job.error}</span></div>}
      <TrackbookPane deliveries={deliveries} evidence={evidence} contract={contract} card={card}
        boardId={job.board_id} />
    </article>
  )
}

export function CompatibilityMessageDetail({
  thread,
  onChange,
}: {
  thread: Thread
  onChange: () => void | Promise<void>
}) {
  return (
    <section className="cc-compatibility-surface" aria-labelledby="cc-message-compatibility-title">
      <header><div><p>Compatibility transport</p><h2 id="cc-message-compatibility-title">Message thread</h2></div>
        <CommandCenterStatus value={commandCenterStatus('discussion', 'unavailable')} /></header>
      <p className="cc-compatibility-note">This intentional message can wake a recipient. It is not a canonical Discussion and has no accepted-answer, nested-resolution, or knowledge-promotion authority.</p>
      <MessageThread thread={thread} onChange={onChange} />
    </section>
  )
}

export function JobList({
  jobs,
  selectedJobId,
  onSelect,
}: {
  jobs: readonly Job[]
  selectedJobId: string | null
  onSelect: (job: Job) => void
}) {
  if (jobs.length === 0) return <CommandCenterState kind="empty" detail="No canonical jobs exist in this project view." />
  return (
    <ol className="cc-job-list" aria-label="Canonical jobs">
      {jobs.map((job) => <li key={String(job.id)}>
        <button type="button" aria-pressed={String(job.id) === selectedJobId} onClick={() => onSelect(job)}>
          <span><strong>Job {job.id}</strong><small>{job.provider} · {job.model || 'provider default'}</small></span>
          <CommandCenterStatus value={commandCenterStatus('job', job.status)} compact />
        </button>
      </li>)}
    </ol>
  )
}
