import React, { useEffect, useState } from 'react'
import { AgentHome } from './AgentHome'
import { CommandCenterStatus } from './CommandCenter'
import { MessageThread } from './MessageThread'
import { OsIcon } from './OsIcon'
import { TrackbookPane } from './TrackbookPane'
import { WorkspaceCockpit } from './WorkspaceCockpit'
import type { Card, Snapshot, Thread } from './api'
import type {
  CanonicalLifecycleRecord,
  DeliveryCollection,
  EvidenceBundle,
  Job,
  TaskContract,
} from './osApi'
import { osApi } from './osApi'
import {
  commandCenterDeepLink,
  commandCenterStatus,
  type CommandCenterDiscussionRecord,
  type CommandCenterGraph,
  type CommandCenterKnowledgeRecord,
} from './commandCenterModel'

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
    localStorage.setItem('orchestra-os-workspace', workspaceId)
    return (
      <section className="cc-canonical-surface" aria-label="Canonical workspace terminal">
        <header className="cc-surface-context">
          <div><p>Canonical surface</p><h2>Workspace</h2></div>
          <span>Exact PTY · durable process · provider session</span>
        </header>
        <WorkspaceCockpit snaps={snaps} onChange={onChange} readOnly={readOnly} />
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

export function CanonicalActivity({ snaps }: { snaps: Snapshot[] }) {
  const records = snaps.flatMap((snapshot) => [
    ...snapshot.cards.map((card) => ({
      id: `card-${snapshot.board.id}-${card.id}`,
      title: card.title,
      detail: `Work is ${card.column.replace(/_/g, ' ')}`,
      project: snapshot.board.name,
    })),
    ...snapshot.milestones.map((milestone) => ({
      id: `milestone-${snapshot.board.id}-${milestone.id}`,
      title: milestone.title,
      detail: 'Project milestone',
      project: snapshot.board.name,
    })),
  ])
  if (records.length === 0) {
    return <CommandCenterState kind="empty" detail="No causal work or milestone activity is recorded for this project yet." />
  }
  return (
    <section className="cc-canonical-surface" aria-label="Canonical project activity">
      <header className="cc-surface-context"><div><p>Canonical surface</p><h2>Activity</h2></div><span>Work state · milestones</span></header>
      <ol className="cc-activity-list">
        {records.map((record) => <li key={record.id}><strong>{record.title}</strong><span>{record.detail} · {record.project}</span></li>)}
      </ol>
    </section>
  )
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

export type CommandCenterDiscussionPost = {
  id: string
  author: string
  actorType: 'agent' | 'operator' | 'system'
  provider: string | null
  sessionId: string | null
  body: string
  createdAt: string
  accepted: boolean
}

export function CanonicalDiscussionDetail({
  discussion,
  posts,
  backendAvailable,
  onReply,
  onAccept,
}: {
  discussion: CommandCenterDiscussionRecord | null
  posts: readonly CommandCenterDiscussionPost[]
  backendAvailable: boolean
  onReply?: () => void
  onAccept?: (postId: string) => void
}) {
  if (!backendAvailable) {
    return <CommandCenterState kind="unsupported" title="Canonical Discussions are not available"
      detail="Low-level Messages remain intentional delivery/wake transport, but they are not being relabeled as durable Discussion records. This capability fails closed until the Discussion service and routes are registered; Q&A, plan, decision, conflict, and knowledge-promotion support are not claimed." />
  }
  if (!discussion) {
    return <CommandCenterState kind="empty" detail="Select a durable Discussion record, or create one from a supported question, plan, decision, announcement, or conflict flow." />
  }
  const status = commandCenterStatus('discussion', discussion.status)
  return (
    <article className="cc-discussion-detail" aria-labelledby="cc-discussion-title">
      <header className="cc-detail-header">
        <div className="cc-detail-heading">
          <p>{discussion.type} · {discussion.author}</p>
          <h2 id="cc-discussion-title">{discussion.title}</h2>
          <span>{discussion.summary}</span>
        </div>
        <CommandCenterStatus value={status} />
        <nav aria-label="Discussion actions">
          <button type="button" disabled={!onReply || status.terminal} onClick={onReply}>Reply</button>
        </nav>
      </header>
      <ol className="cc-discussion-posts" aria-label="Discussion posts">
        {posts.map((post) => (
          <li key={post.id} data-accepted={post.accepted}>
            <header><strong>{post.author}</strong><span>{post.actorType}{post.provider ? ` · ${post.provider}` : ''}</span>
              <time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleString()}</time></header>
            <p>{post.body}</p>
            <footer>
              {post.sessionId && <a href={commandCenterDeepLink(browserSearch(), {
                section: 'agents', boardId: discussion.boardId, sessionId: post.sessionId,
              })}>Provider session</a>}
              {post.accepted
                ? <span><OsIcon name="check" /> Accepted answer</span>
                : discussion.type === 'question' && onAccept
                  ? <button type="button" onClick={() => onAccept(post.id)}>Accept answer</button>
                  : null}
            </footer>
          </li>
        ))}
      </ol>
      {posts.length === 0 && <CommandCenterState kind="empty" detail="This discussion has no posts yet." />}
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

export function KnowledgeBrowse({
  records,
  available,
  stale,
}: {
  records: readonly CommandCenterKnowledgeRecord[]
  available: boolean
  stale?: boolean
}) {
  if (!available) {
    return <CommandCenterState kind="unsupported" title="Knowledge browse is unavailable"
      detail="Repository ingestion and retrieval foundations exist, but this project has no registered Knowledge browse adapter. No context item is being promoted or fabricated by the UI." />
  }
  if (records.length === 0) {
    return <CommandCenterState kind="empty" detail="No cited Knowledge records matched this project view." />
  }
  return (
    <section className="cc-knowledge" aria-labelledby="cc-knowledge-title">
      <header><div><p>Canonical sources</p><h2 id="cc-knowledge-title">Knowledge</h2></div>
        {stale && <span className="cc-stale-label"><OsIcon name="refresh" /> Freshness check pending</span>}</header>
      <ol>{records.map((record) => (
        <li key={record.id}>
          <a href={commandCenterDeepLink(browserSearch(), {
            section: 'knowledge', boardId: record.boardId, knowledgeId: record.id,
          })}>
            <div><strong>{record.title}</strong><p>{record.summary}</p></div>
            <dl><div><dt>Source</dt><dd>{record.source}</dd></div>
              <div><dt>Freshness</dt><dd>{record.freshness ?? 'Not reported'}</dd></div></dl>
          </a>
        </li>
      ))}</ol>
    </section>
  )
}

export function DependencyVisualization({ graph }: { graph: CommandCenterGraph }) {
  if (graph.nodes.length === 0) {
    return <CommandCenterState kind="empty" detail="No canonical dependencies, assignments, discussions, or conflicts are recorded for this view." />
  }
  const lanes = [0, 1, 2].map((lane) => graph.nodes.filter((node) => node.lane === lane))
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  return (
    <section className="cc-dependency-map" aria-labelledby="cc-dependency-title">
      <header><div><p>Observed relationships</p><h2 id="cc-dependency-title">Dependency map</h2></div>
        <span>{graph.nodes.length} records · {graph.edges.length} relationships</span></header>
      <div className="cc-dependency-lanes" aria-describedby="cc-dependency-description">
        {lanes.map((nodes, lane) => (
          <section key={lane} aria-label={lane === 0 ? 'Dependencies' : lane === 1 ? 'Work' : 'People and coordination'}>
            <h3>{lane === 0 ? 'Prerequisites' : lane === 1 ? 'Active work' : 'Assignments and coordination'}</h3>
            {nodes.map((node) => {
              const content = <><span className={`cc-node-kind cc-node-${node.kind}`}>{node.kind}</span>
                <strong>{node.label}</strong><small>{node.detail}</small><CommandCenterStatus value={node.status} compact /></>
              return node.href
                ? <a key={node.id} href={node.href} className="cc-graph-node">{content}</a>
                : <div key={node.id} className="cc-graph-node">{content}</div>
            })}
          </section>
        ))}
      </div>
      <p id="cc-dependency-description" className="sr-only">The visual lanes are followed by a complete text relationship list.</p>
      <ol className="cc-edge-list" aria-label="Dependency relationships">
        {graph.edges.map((edge) => (
          <li key={edge.id} data-blocked={edge.blocked}>
            <span>{nodeById.get(edge.from)?.label ?? edge.from}</span>
            <b>{edge.label || edge.kind.replace(/_/g, ' ')}</b>
            <span>{nodeById.get(edge.to)?.label ?? edge.to}</span>
          </li>
        ))}
      </ol>
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
