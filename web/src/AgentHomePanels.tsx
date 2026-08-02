import React, { useEffect, useMemo, useState } from 'react'
import type { Agent } from './api'
import {
  AGENT_HOME_EVENT_KINDS,
  type AgentConversation,
  type AgentHomeAction,
  type AgentHomeCapabilities,
  type AgentHomeEventKind,
  type AgentHomeSnapshot,
  type AgentProfile,
  type AgentSessionRecord,
  type ConversationEvent,
} from './agentHomeApi'
import {
  agentHomeActionPresentation,
  agentHomeSessionPresentation,
  attentionSummary,
  eventActor,
  eventLabel,
  eventText,
  formatEventTime,
  metadataName,
  shortId,
  usageSummary,
} from './agentHomePresentation'
import { OsIcon } from './OsIcon'
import type {
  AttentionItem,
  ContextItem,
  Job,
  TaskContract,
  Workspace,
  WorkspaceProcess,
} from './osApi'
import { ProcessTerminal } from './ProcessTerminal'
import { ProviderBadge } from './ProviderBadge'
import { AgentToolControls } from './AgentToolControls'
import {
  agentToolApi,
  type SessionToolSnapshot,
  type ToolPolicyDecision,
} from './agentToolApi'

export type AgentHomeDetailTab = 'work' | 'context' | 'tools' | 'usage' | 'history'
export type AgentHomeMobilePane = 'conversation' | 'terminal' | 'details'

export type Loadable<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T
  error: string | null
}

const activeStatuses = new Set(['reserved', 'starting', 'running', 'idle', 'stopping'])

export function AgentHomeHeader({
  profile,
  session,
  conversation,
  workspace,
  job,
  contract,
  process,
  attention,
  capabilities,
  busyAction,
  error,
  copied,
  onAction,
  onRefresh,
  onCopyLink,
}: {
  profile: AgentProfile
  session: AgentSessionRecord | null
  conversation: AgentConversation | null
  workspace: Workspace | null
  job: Job | null
  contract: TaskContract | null
  process: WorkspaceProcess | null
  attention: AttentionItem[]
  capabilities: AgentHomeCapabilities | null
  busyAction: AgentHomeAction | null
  error: string | null
  copied: boolean
  onAction: (action: AgentHomeAction) => void
  onRefresh: () => void
  onCopyLink: () => void
}) {
  const attentionCount = attentionSummary(attention)
  const sessionPresentation = agentHomeSessionPresentation(session)
  const quickActions = sessionPresentation.quickActions
  const overflowActions: AgentHomeAction[] = ['fork', 'rename', 'archive']

  const actionButton = (action: AgentHomeAction, compact = false) => {
    const actionPresentation = agentHomeActionPresentation(capabilities, action, {
      hasSession: session !== null,
      busyAction,
    })
    return (
      <button key={action} type="button" className={compact ? 'ah-menu-action' : 'ah-action'}
        disabled={actionPresentation.disabled} title={actionPresentation.reason} onClick={() => onAction(action)}>
        {busyAction === action ? 'Working…' : action}
      </button>
    )
  }

  return (
    <header className="ah-header">
      <div className="ah-identity">
        <div className="ah-identity-mark" aria-hidden="true">
          {profile.name.split(/[\s-_]+/).map((part) => part[0]?.toUpperCase()).slice(0, 2).join('')}
        </div>
        <div>
          <div className="ah-kicker">
            <span className={`ah-health ${session ? sessionPresentation.status : 'offline'}`}>
              {sessionPresentation.status}
            </span>
            <span>{session?.mode ?? 'durable identity'}</span>
            <span>Agent {shortId(profile.id)}</span>
          </div>
          <h2>{profile.name}</h2>
          <p>{profile.role ?? 'General agent'} · {conversation?.title ?? 'No active conversation'}</p>
        </div>
      </div>

      <div className="ah-header-facts" aria-label="Agent runtime facts">
        <HeaderFact label="Provider" value={session?.provider ?? profile.default_provider ?? 'Unassigned'}
          badge={session?.provider ?? profile.default_provider ?? undefined} />
        <HeaderFact label="Model" value={session?.model ?? profile.default_model ?? 'Provider default'} />
        <HeaderFact label="Effort" value={session?.effort ?? profile.default_effort ?? 'Default'} />
        <HeaderFact label="Access" value={session?.access_profile ?? profile.default_access_profile ?? 'Not set'} />
        <HeaderFact label="Recovery" value={session?.recovery_state ?? 'Not started'} tone={session?.recovery_state === 'lost' ? 'danger' : undefined} />
        <HeaderFact label="Cursor" value={shortId(session?.provider_cursor, 12)} mono />
      </div>

      <div className="ah-runtime-links" aria-label="Exact runtime links">
        <RuntimeLink label="Contract" value={contract
          ? `card-${contract.card_id}:v${contract.version ?? job?.contract_version ?? '—'}`
          : null} />
        <RuntimeLink label="Job" value={job?.id} />
        <RuntimeLink label="Workspace" value={workspace?.id} />
        <RuntimeLink label="Branch" value={workspace?.branch} />
        <RuntimeLink label="Session" value={session?.id} />
        <RuntimeLink label="Process" value={process?.id} />
        <span className={`ah-attention-count${attentionCount.total ? ' active' : ''}`}>
          <OsIcon name="attention" size={12} /> {attentionCount.total} pending
        </span>
      </div>

      <div className="ah-header-actions">
        {quickActions.map((action) => actionButton(action))}
        <details className="ah-action-menu">
          <summary aria-label="More session actions including lifecycle controls">More</summary>
          <div>
            <div className="ah-mobile-control-actions" role="group" aria-label="Session lifecycle controls">
              {sessionPresentation.mobileActions.map((action) => actionButton(action, true))}
            </div>
            {overflowActions.map((action) => actionButton(action, true))}
          </div>
        </details>
        <button className="ah-icon-action" type="button" onClick={onCopyLink}
          aria-label="Copy exact Agent Home link" title="Copy exact Agent Home link">
          <OsIcon name={copied ? 'check' : 'external'} size={14} />
        </button>
        <button className="ah-icon-action" type="button" onClick={onRefresh}
          aria-label="Refresh Agent Home" title="Refresh Agent Home">
          <OsIcon name="refresh" size={14} />
        </button>
      </div>
      {error && <div className="ah-header-error" role="alert"><OsIcon name="attention" size={14} />{error}</div>}
    </header>
  )
}

function HeaderFact({ label, value, tone, mono, badge }: {
  label: string
  value: string
  tone?: 'danger'
  mono?: boolean
  badge?: string
}) {
  return (
    <div className={`ah-header-fact${tone ? ` ${tone}` : ''}`}>
      <span>{label}</span>
      {badge ? <ProviderBadge provider={badge} compact /> : <strong className={mono ? 'mono' : ''}>{value}</strong>}
    </div>
  )
}

function RuntimeLink({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <span><b>{label}</b><code title={value == null ? undefined : String(value)}>{shortId(value, 12)}</code></span>
}

export function AgentConversationPanel({
  conversation,
  session,
  events,
  highlightedEventId,
  query,
  kind,
  liveAgent,
  searching,
  hasMore,
  exportBusy,
  onQueryChange,
  onKindChange,
  onSearch,
  onLoadMore,
  onOpenLiveAgent,
  onExport,
}: {
  conversation: AgentConversation | null
  session: AgentSessionRecord | null
  events: Loadable<ConversationEvent[]>
  highlightedEventId: string | null
  query: string
  kind: AgentHomeEventKind | 'all'
  liveAgent: Agent | null
  searching: boolean
  hasMore: boolean
  exportBusy: 'human' | 'json' | null
  onQueryChange: (value: string) => void
  onKindChange: (value: AgentHomeEventKind | 'all') => void
  onSearch: (event: React.FormEvent) => void
  onLoadMore: () => void
  onOpenLiveAgent: () => void
  onExport: (format: 'human' | 'json') => void
}) {
  return (
    <section className="ah-panel ah-conversation-panel" aria-labelledby="ah-conversation-title">
      <header className="ah-panel-head">
        <div>
          <p>Durable timeline</p>
          <h3 id="ah-conversation-title">{conversation?.title ?? 'Conversation'}</h3>
        </div>
        <div className="ah-panel-actions">
          {liveAgent && (
            <button type="button" onClick={onOpenLiveAgent}><OsIcon name="message" size={13} /> Live chat</button>
          )}
          <details className="ah-export-menu">
            <summary>Export</summary>
            <div>
              <button type="button" disabled={!conversation || exportBusy !== null} onClick={() => onExport('human')}>
                {exportBusy === 'human' ? 'Preparing…' : 'Human transcript'}
              </button>
              <button type="button" disabled={!conversation || exportBusy !== null} onClick={() => onExport('json')}>
                {exportBusy === 'json' ? 'Preparing…' : 'Provenance JSON'}
              </button>
            </div>
          </details>
        </div>
      </header>

      <form className="ah-search" role="search" onSubmit={onSearch}>
        <label>
          <OsIcon name="search" size={14} />
          <span className="sr-only">Search the durable conversation</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search message, tool, file, status…" />
        </label>
        <select aria-label="Filter conversation event kind" value={kind}
          onChange={(event) => onKindChange(event.target.value as AgentHomeEventKind | 'all')}>
          <option value="all">All events</option>
          {AGENT_HOME_EVENT_KINDS.map((eventKind) => (
            <option value={eventKind} key={eventKind}>{eventKind.replace('_', ' ')}</option>
          ))}
        </select>
        <button type="submit" disabled={!conversation || searching}>{searching ? 'Searching' : 'Search'}</button>
      </form>

      <div className="ah-event-stream" aria-live="polite">
        {events.status === 'loading' && events.data.length === 0 && <AgentHomePanelSkeleton rows={5} />}
        {events.status === 'error' && events.data.length === 0 && (
          <AgentHomeInlineState icon="attention" title="Conversation unavailable" detail={events.error ?? 'The timeline could not be read.'} />
        )}
        {events.status !== 'loading' && events.data.length === 0 && (
          <AgentHomeInlineState icon="message" title="No durable events yet"
            detail="Provider-native messages, tool calls, approvals, usage, and status changes will appear here without replacing the CLI." />
        )}
        {events.data.map((event) => (
          <ConversationEventCard event={event} highlighted={event.id === highlightedEventId} key={event.id} />
        ))}
        {hasMore && (
          <button className="ah-load-more" type="button" onClick={onLoadMore} disabled={searching}>
            Load more matching events
          </button>
        )}
      </div>

      <footer className="ah-conversation-foot">
        <span className={`ah-live-dot${session && activeStatuses.has(session.status) ? ' active' : ''}`} />
        <span>{session ? `${session.provider} ${session.mode} session` : 'No provider session selected'}</span>
        <code>{events.data.length} visible events</code>
        <small>Safe projection · raw payloads stay governed by retention policy</small>
      </footer>
    </section>
  )
}

function ConversationEventCard({
  event,
  highlighted,
}: {
  event: ConversationEvent
  highlighted: boolean
}) {
  const tool = metadataName(event)
  const machineEvent = ['tool', 'tool_result', 'usage', 'status', 'approval'].includes(event.kind)
  return (
    <article
      className={`ah-event ah-event-${event.kind}${machineEvent ? ' machine' : ''}${highlighted ? ' deep-linked' : ''}`}
      data-agent-event-id={event.id}
      tabIndex={-1}>
      <header>
        <span className="ah-event-kind">{eventLabel(event)}</span>
        <span>{eventActor(event)}</span>
        {event.provider && <ProviderBadge provider={event.provider} compact />}
        <time dateTime={event.created_at}>{formatEventTime(event.created_at)}</time>
      </header>
      {tool && <code className="ah-tool-name">{tool}</code>}
      <p>{eventText(event)}</p>
      <footer>
        <span>#{event.sequence}</span>
        {event.provider_item_id && <code>item {shortId(event.provider_item_id, 11)}</code>}
        {event.correlation_id && <code>corr {shortId(event.correlation_id, 11)}</code>}
        {event.redaction_state !== 'none' && <b>{event.redaction_state}</b>}
      </footer>
    </article>
  )
}

export function AgentTerminalPanel({
  workspace,
  processes,
  process,
  loading,
  error,
  openingShell,
  startingCommand,
  restartingProcessId,
  onSelectProcess,
  onOpenShell,
  onRunCommand,
  onSignal,
  onRestart,
  onProcessChanged,
}: {
  workspace: Workspace | null
  processes: WorkspaceProcess[]
  process: WorkspaceProcess | null
  loading: boolean
  error: string | null
  openingShell: boolean
  startingCommand: boolean
  restartingProcessId: string | null
  onSelectProcess: (process: WorkspaceProcess) => void
  onOpenShell: () => void
  onRunCommand: (command: string) => Promise<void>
  onSignal: (process: WorkspaceProcess, signal: string) => void
  onRestart: (process: WorkspaceProcess) => void
  onProcessChanged: () => void
}) {
  const [command, setCommand] = useState('')
  const running = process && activeStatuses.has(process.status)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const next = command.trim()
    if (!next) return
    await onRunCommand(next)
    setCommand('')
  }

  return (
    <section className="ah-panel ah-terminal-panel" aria-labelledby="ah-terminal-title">
      <header className="ah-panel-head ah-terminal-head">
        <div>
          <p>Direct node-pty</p>
          <h3 id="ah-terminal-title">Terminal</h3>
        </div>
        <div className="ah-process-tabs" role="tablist" aria-label="Agent workspace processes">
          {processes.map((item) => (
            <button type="button" role="tab" aria-selected={String(process?.id) === String(item.id)}
              className={String(process?.id) === String(item.id) ? 'active' : ''}
              onClick={() => onSelectProcess(item)} key={String(item.id)}>
              <span className={`ah-process-dot ${item.status}`} />{item.name}
            </button>
          ))}
        </div>
        <div className="ah-panel-actions">
          <button type="button" onClick={onOpenShell} disabled={!workspace || openingShell}>
            <OsIcon name="terminal" size={13} /> {openingShell ? 'Opening…' : 'New shell'}
          </button>
          {process && (running
            ? <>
                <button type="button" onClick={() => onSignal(process, 'SIGINT')}>Interrupt</button>
                <button type="button" onClick={() => onSignal(process, 'SIGTERM')}>Stop</button>
              </>
            : Boolean(process.restartable) && <button type="button"
                disabled={restartingProcessId === String(process.id)} onClick={() => onRestart(process)}>
                {restartingProcessId === String(process.id) ? 'Restarting…' : 'Restart'}
              </button>)}
        </div>
      </header>
      {error && <div className="ah-panel-error" role="alert">{error}</div>}
      {loading && !process && <AgentHomePanelSkeleton rows={4} dark />}
      {!loading && !workspace && (
        <AgentHomeInlineState icon="workspace" title="No session workspace"
          detail="Start or attach a managed provider session to bind a recoverable workspace and real terminal." dark />
      )}
      {workspace && <ProcessTerminal process={process} onProcessChanged={onProcessChanged} />}
      <form className="ah-command" onSubmit={submit}>
        <label htmlFor="ah-command-input">Run in a new PTY</label>
        <div>
          <span aria-hidden="true">$</span>
          <input id="ah-command-input" value={command} onChange={(event) => setCommand(event.target.value)}
            placeholder="git status" autoComplete="off" spellCheck={false} disabled={!workspace} />
          <button type="submit" disabled={!workspace || !command.trim() || startingCommand}>
            {startingCommand ? 'Starting…' : 'Run'}
          </button>
        </div>
        <small>Raw input/output · ANSI and Unicode preserved · no chat summarization</small>
      </form>
    </section>
  )
}

export function AgentInspector({
  tab,
  profile,
  home,
  session,
  conversation,
  workspace,
  job,
  contract,
  processes,
  attention,
  context,
  events,
  onTabChange,
  onSelectSession,
  onSelectConversation,
}: {
  tab: AgentHomeDetailTab
  profile: AgentProfile
  home: AgentHomeSnapshot
  session: AgentSessionRecord | null
  conversation: AgentConversation | null
  workspace: Workspace | null
  job: Job | null
  contract: TaskContract | null
  processes: WorkspaceProcess[]
  attention: AttentionItem[]
  context: Loadable<ContextItem[]>
  events: ConversationEvent[]
  onTabChange: (tab: AgentHomeDetailTab) => void
  onSelectSession: (session: AgentSessionRecord) => void
  onSelectConversation: (conversation: AgentConversation) => void
}) {
  const tabs: Array<{ id: AgentHomeDetailTab; label: string }> = [
    { id: 'work', label: 'Work' },
    { id: 'context', label: 'Context' },
    { id: 'tools', label: 'Tools' },
    { id: 'usage', label: 'Usage' },
    { id: 'history', label: 'History' },
  ]
  return (
    <aside className="ah-panel ah-inspector" aria-label="Agent details">
      <nav className="ah-detail-tabs" role="tablist" aria-label="Agent detail views">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''} onClick={() => onTabChange(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="ah-detail-panel" role="tabpanel" tabIndex={0}>
        {tab === 'work' && <WorkDetail workspace={workspace} job={job} contract={contract} session={session}
          processes={processes} attention={attention} />}
        {tab === 'context' && <ContextDetail context={context} />}
        {tab === 'tools' && <ToolsDetail profile={profile} session={session} events={events} />}
        {tab === 'usage' && <UsageDetail events={events} job={job} />}
        {tab === 'history' && <HistoryDetail home={home} session={session} conversation={conversation}
          onSelectSession={onSelectSession} onSelectConversation={onSelectConversation} />}
      </div>
    </aside>
  )
}

function WorkDetail({ workspace, job, contract, session, processes, attention }: {
  workspace: Workspace | null
  job: Job | null
  contract: TaskContract | null
  session: AgentSessionRecord | null
  processes: WorkspaceProcess[]
  attention: AttentionItem[]
}) {
  const summary = attentionSummary(attention)
  return (
    <div className="ah-detail-stack">
      <DetailSection title="Active assignment" eyebrow={job ? `Job ${shortId(job.id)}` : 'No canonical job'}>
        <dl className="ah-fact-list">
          <Fact label="Contract" value={contract
            ? `Card ${contract.card_id} · v${contract.version ?? job?.contract_version ?? '—'}`
            : 'Not attached'} mono />
          <Fact label="Objective" value={contract?.objective ?? 'No frozen objective'} />
          <Fact label="Job status" value={job?.status ?? 'Unassigned'} />
          <Fact label="Workspace" value={workspace?.name ?? 'Not bound'} />
          <Fact label="Branch" value={workspace?.branch ?? '—'} mono />
          <Fact label="Path" value={workspace?.worktree_path ?? workspace?.root_path ?? '—'} mono />
          <Fact label="Session" value={shortId(session?.id, 14)} mono />
        </dl>
      </DetailSection>
      <DetailSection title="Needs you" eyebrow={`${summary.total} open`}>
        {attention.length === 0 ? <p className="ah-detail-empty">No approvals, questions, conflicts, reviews, or failures are pending.</p>
          : <div className="ah-attention-list">{attention.map((item) => (
            <article key={String(item.id)}>
              <span className={`ah-severity ${item.severity}`} />
              <div><strong>{item.title}</strong><p>{item.detail ?? item.kind}</p></div>
              <time>{formatEventTime(item.created_at)}</time>
            </article>
          ))}</div>}
      </DetailSection>
      <DetailSection title="Processes" eyebrow={`${processes.length} attached`}>
        {processes.length === 0 ? <p className="ah-detail-empty">No PTY recipes are attached.</p>
          : <div className="ah-mini-processes">{processes.map((process) => (
            <div key={String(process.id)}>
              <span className={`ah-process-dot ${process.status}`} />
              <strong>{process.name}</strong><code>{shortId(process.id)}</code><small>{process.status}</small>
            </div>
          ))}</div>}
      </DetailSection>
    </div>
  )
}

function ContextDetail({ context }: { context: Loadable<ContextItem[]> }) {
  const tokens = context.data.reduce((total, item) => total + (item.tokens || 0), 0)
  return (
    <div className="ah-detail-stack">
      <DetailSection title="Context manifest" eyebrow={`${tokens.toLocaleString()} attributable tokens`}>
        {context.status === 'loading' && context.data.length === 0 && <AgentHomePanelSkeleton rows={3} />}
        {context.status === 'error' && <p className="ah-detail-error">{context.error}</p>}
        {context.status !== 'loading' && context.data.length === 0 && (
          <p className="ah-detail-empty">No explicit files, decisions, or references are pinned to this workspace.</p>
        )}
        <div className="ah-context-list">{context.data.map((item) => (
          <article key={String(item.id)}>
            <header><span>{item.kind}</span><code>{item.tokens.toLocaleString()} tok</code>{Boolean(item.pinned) && <b>pinned</b>}</header>
            <strong>{item.source}</strong>
            <p>{item.content}</p>
          </article>
        ))}</div>
      </DetailSection>
    </div>
  )
}

function ToolsDetail({
  profile,
  session,
  events,
}: {
  profile: AgentProfile
  session: AgentSessionRecord | null
  events: ConversationEvent[]
}) {
  const [snapshot, setSnapshot] = useState<SessionToolSnapshot | null>(null)
  const [busyToolId, setBusyToolId] = useState<string | null>(null)
  const [toolError, setToolError] = useState<string | null>(null)
  const toolEvents = events.filter((event) => event.kind === 'tool' || event.kind === 'tool_result')
  const grouped = useMemo(() => {
    const counts = new Map<string, { requested: number; completed: number }>()
    for (const event of toolEvents) {
      const name = metadataName(event) ?? 'unnamed tool'
      const current = counts.get(name) ?? { requested: 0, completed: 0 }
      if (event.kind === 'tool') current.requested++
      else current.completed++
      counts.set(name, current)
    }
    return [...counts.entries()]
  }, [toolEvents])

  useEffect(() => {
    let current = true
    setSnapshot(null)
    setToolError(null)
    if (!session) return () => { current = false }
    void agentToolApi.getSessionTools(session.id)
      .then((next) => { if (current) setSnapshot(next) })
      .catch((error: unknown) => {
        if (current) setToolError(error instanceof Error ? error.message : 'Tool capabilities could not be loaded.')
      })
    return () => { current = false }
  }, [session?.id])

  const changePolicy = async (toolId: string, decision: ToolPolicyDecision) => {
    if (!session || !snapshot) return
    setBusyToolId(toolId)
    setToolError(null)
    try {
      const rules = snapshot.policy.rules.filter((rule) => rule.target !== toolId)
      rules.push({ target: toolId, decision })
      await agentToolApi.updatePolicy(session.id, {
        default_decision: snapshot.policy.default_decision,
        rules,
        revision: snapshot.policy.revision,
      })
      setSnapshot(await agentToolApi.getSessionTools(session.id))
    } catch (error) {
      setToolError(error instanceof Error ? error.message : 'The tool policy could not be updated.')
    } finally {
      setBusyToolId(null)
    }
  }

  return (
    <div className="ah-detail-stack">
      {!session && <p className="ah-detail-empty">Select a durable provider session to inspect effective tool permissions.</p>}
      {session && !snapshot && !toolError && <AgentHomePanelSkeleton rows={3} />}
      {snapshot && <AgentToolControls snapshot={snapshot} busyToolId={busyToolId}
        error={toolError} onPolicyChange={(toolId, decision) => void changePolicy(toolId, decision)} />}
      {session && toolError && !snapshot && <p className="ah-detail-error" role="alert">{toolError}</p>}
      <DetailSection title="Declared capabilities" eyebrow={`${profile.capabilities.length} available`}>
        {profile.capabilities.length === 0 ? <p className="ah-detail-empty">No durable capability labels have been declared.</p>
          : <div className="ah-capability-list">{profile.capabilities.map((capability) => <code key={capability}>{capability}</code>)}</div>}
      </DetailSection>
      <DetailSection title="Observed tools" eyebrow={`${toolEvents.length} timeline events`}>
        {grouped.length === 0 ? <p className="ah-detail-empty">Tool activity will be summarized from provider-native events.</p>
          : <div className="ah-tool-list">{grouped.map(([name, count]) => (
            <div key={name}><strong>{name}</strong><span>{count.requested} calls</span><span>{count.completed} results</span></div>
          ))}</div>}
      </DetailSection>
    </div>
  )
}

function UsageDetail({ events, job }: { events: ConversationEvent[]; job: Job | null }) {
  const usage = usageSummary(events)
  const total = usage.input + usage.output
  return (
    <div className="ah-detail-stack">
      <DetailSection title="Provider usage" eyebrow="Durable usage events">
        <div className="ah-usage-grid">
          <UsageMetric label="Input" value={usage.input} />
          <UsageMetric label="Cached" value={usage.cached} />
          <UsageMetric label="Output" value={usage.output} />
          <UsageMetric label="Visible total" value={total} />
        </div>
        <p className="ah-detail-note">Counts reflect the selected conversation window and remain separate from injected-context estimates.</p>
      </DetailSection>
      <DetailSection title="Job budget" eyebrow={job ? `Attempt ${job.attempts}/${job.max_attempts}` : 'No job'}>
        <dl className="ah-fact-list">
          <Fact label="Spent tokens" value={(job?.spent_tokens ?? total).toLocaleString()} mono />
          <Fact label="Token budget" value={job?.budget_tokens?.toLocaleString() ?? 'Open'} mono />
          <Fact label="Spent cost" value={`$${((job?.spent_cents ?? usage.costCents) / 100).toFixed(2)}`} mono />
          <Fact label="Cost budget" value={job?.budget_cents == null ? 'Open' : `$${(job.budget_cents / 100).toFixed(2)}`} mono />
        </dl>
      </DetailSection>
    </div>
  )
}

function UsageMetric({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{value.toLocaleString()}</strong><small>tokens</small></div>
}

function HistoryDetail({ home, session, conversation, onSelectSession, onSelectConversation }: {
  home: AgentHomeSnapshot
  session: AgentSessionRecord | null
  conversation: AgentConversation | null
  onSelectSession: (session: AgentSessionRecord) => void
  onSelectConversation: (conversation: AgentConversation) => void
}) {
  return (
    <div className="ah-detail-stack">
      <DetailSection title="Sessions" eyebrow={`${home.sessions.length} provider lifecycles`}>
        <div className="ah-history-list">
          {home.sessions.map((item) => (
            <button type="button" key={item.id} className={item.id === session?.id ? 'active' : ''}
              onClick={() => onSelectSession(item)}>
              <span className={`ah-process-dot ${item.status}`} />
              <div><strong>{item.provider} · {item.mode}</strong><small>{formatEventTime(item.started_at ?? item.created_at)}</small></div>
              <span>{item.recovery_state}</span><code>{shortId(item.id)}</code>
            </button>
          ))}
        </div>
      </DetailSection>
      <DetailSection title="Conversations" eyebrow={`${home.conversations.length} durable threads`}>
        <div className="ah-history-list">
          {home.conversations.map((item) => (
            <button type="button" key={item.id} className={item.id === conversation?.id ? 'active' : ''}
              onClick={() => onSelectConversation(item)}>
              <OsIcon name="message" size={14} />
              <div><strong>{item.title}</strong><small>{formatEventTime(item.updated_at)}</small></div>
              <span>{item.status}</span><code>next #{item.next_sequence}</code>
            </button>
          ))}
        </div>
      </DetailSection>
    </div>
  )
}

function DetailSection({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="ah-detail-section">
      <header><div><span>{eyebrow}</span><h4>{title}</h4></div></header>
      {children}
    </section>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : ''} title={value}>{value}</dd></div>
}

export function AgentHomePanelSkeleton({ rows = 4, dark = false }: { rows?: number; dark?: boolean }) {
  return (
    <div className={`ah-skeleton${dark ? ' dark' : ''}`} aria-label="Loading Agent Home panel">
      {Array.from({ length: rows }, (_, index) => <span key={index} style={{ '--row': index } as React.CSSProperties} />)}
    </div>
  )
}

export function AgentHomeInlineState({ icon, title, detail, dark = false }: {
  icon: 'attention' | 'message' | 'workspace'
  title: string
  detail: string
  dark?: boolean
}) {
  return (
    <div className={`ah-inline-state${dark ? ' dark' : ''}`}>
      <OsIcon name={icon} size={20} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  )
}
