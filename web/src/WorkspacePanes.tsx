import React, { useEffect, useMemo, useState } from 'react'
import { Agent, Card, Snapshot } from './api'
import {
  AcceptanceCriterion,
  Artifact,
  asStringList,
  ContextItem,
  EvidenceBundle,
  JsonObject,
  OsEvent,
  osApi,
  Policy,
  PolicyDecision,
  TaskContract,
  Workspace,
  WorkspaceProcess,
  parseJson,
} from './osApi'
import { OsIcon } from './OsIcon'

export type Resource<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T
  error: string | null
}

export const resource = <T,>(data: T): Resource<T> => ({ status: 'idle', data, error: null })

const normalizeTime = (value: string | null | undefined) => {
  if (!value) return 'Not recorded'
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

const eventPayload = (event: OsEvent): JsonObject => parseJson<JsonObject>(event.payload, {})

const eventSummary = (event: OsEvent) => {
  const payload = eventPayload(event)
  for (const key of ['message', 'text', 'summary', 'detail', 'question', 'command', 'reason']) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key] as string
  }
  return event.kind.split('_').join(' ')
}

const eventActor = (event: OsEvent) => {
  const payload = eventPayload(event)
  for (const key of ['agent_name', 'actor', 'provider', 'name']) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key] as string
  }
  return event.source
}

export function PaneFrame({ title, eyebrow, action, children }: {
  title: string
  eyebrow?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="os-pane-frame">
      <header className="os-pane-head">
        <div>
          {eyebrow && <p className="os-eyebrow">{eyebrow}</p>}
          <h3>{title}</h3>
        </div>
        {action}
      </header>
      <div className="os-pane-body">{children}</div>
    </section>
  )
}

export function PaneState({ resource: state, emptyTitle, emptyText, children }: {
  resource: Resource<unknown>
  emptyTitle?: string
  emptyText?: string
  children: React.ReactNode
}) {
  if (state.status === 'loading' || state.status === 'idle') return <PaneSkeleton />
  if (state.status === 'error') return (
    <div className="os-pane-error" role="alert">
      <OsIcon name="attention" />
      <strong>This pane could not load</strong>
      <span>{state.error}</span>
    </div>
  )
  if (emptyTitle) return (
    <div className="os-empty-state compact">
      <span className="os-empty-icon"><OsIcon name="workspace" size={20} /></span>
      <h3>{emptyTitle}</h3>
      {emptyText && <p>{emptyText}</p>}
    </div>
  )
  return <>{children}</>
}

export function PaneSkeleton() {
  return (
    <div className="os-pane-skeleton" aria-label="Loading pane">
      <i className="wide" /><i /><i className="short" /><i className="wide" /><i />
    </div>
  )
}

export function ConversationPane({ events, workspace, snapshot, agent, onOpenAgent }: {
  events: Resource<OsEvent[]>
  workspace: Workspace
  snapshot: Snapshot | undefined
  agent: Agent | null
  onOpenAgent: (agent: Agent) => void
}) {
  const conversation = useMemo(() => events.data
    .filter((event) => String(event.workspace_id) === String(workspace.id) || event.card_id === workspace.card_id)
    .filter((event) => /agent|message|question|permission|tool|conversation|job|review/.test(event.kind))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()), [events.data, workspace.id, workspace.card_id])

  return (
    <PaneFrame title="Agent conversation" eyebrow="Driver-neutral event stream" action={agent && (
      <button className="os-secondary-button" onClick={() => onOpenAgent(agent)}>
        <OsIcon name="message" /> Open live agent
      </button>
    )}>
      <PaneState resource={events}
        emptyTitle={conversation.length === 0 ? 'No agent events yet' : undefined}
        emptyText="Launch or attach an agent session and its questions, decisions, and tool activity will appear here.">
        <div className="os-conversation">
          {conversation.map((event) => (
            <article key={String(event.id)} className={`os-event os-event-${event.kind.includes('error') ? 'error' : 'normal'}`}>
              <div className="os-event-meta">
                <span>{eventActor(event)}</span>
                <span>{event.kind.split('_').join(' ')}</span>
                <time title={normalizeTime(event.created_at)}>{normalizeTime(event.created_at)}</time>
              </div>
              <p>{eventSummary(event)}</p>
            </article>
          ))}
        </div>
      </PaneState>
      {!agent && snapshot && workspace.card_id !== null && (
        <p className="os-pane-note">Assign an active agent to this task to enable the live conversation console.</p>
      )}
    </PaneFrame>
  )
}

const artifactDiff = (bundle: EvidenceBundle | null) => {
  if (!bundle) return null
  if (typeof bundle.diff === 'string' && bundle.diff) return bundle.diff
  if (bundle.diff && typeof bundle.diff === 'object' && typeof bundle.diff.content === 'string') return bundle.diff.content
  const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : []
  return artifacts.find((artifact) => ['diff', 'patch'].includes(artifact.kind) && artifact.content)?.content ?? null
}

const changedFiles = (bundle: EvidenceBundle | null) => {
  if (!bundle || !Array.isArray(bundle.changed_files)) return []
  return bundle.changed_files
}

export function ChangesPane({ evidence }: { evidence: Resource<EvidenceBundle | null> }) {
  const diff = artifactDiff(evidence.data)
  const files = changedFiles(evidence.data)
  return (
    <PaneFrame title="Changed files" eyebrow="Exact workspace diff">
      <PaneState resource={evidence}
        emptyTitle={!diff && files.length === 0 ? 'No recorded changes' : undefined}
        emptyText="A diff artifact appears here after the workspace changes tracked files.">
        {files.length > 0 && (
          <div className="os-file-list">
            {files.map((file) => {
              const path = typeof file === 'string' ? file : file.path
              const additions = typeof file === 'string' ? undefined : file.insertions
              const deletions = typeof file === 'string' ? undefined : file.deletions
              return (
                <div key={path} className="os-file-row">
                  <code>{path}</code>
                  {(additions !== undefined || deletions !== undefined) && (
                    <span><b>+{additions ?? 0}</b><i>-{deletions ?? 0}</i></span>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {diff && (
          <pre className="os-diff" aria-label="Workspace diff">{diff.split('\n').map((line, index) => (
            <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'added'
              : line.startsWith('-') && !line.startsWith('---') ? 'removed'
                : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}{'\n'}</span>
          ))}</pre>
        )}
      </PaneState>
    </PaneFrame>
  )
}

const normalizeCriteria = (contract: TaskContract | null): AcceptanceCriterion[] => {
  if (!contract) return []
  if (Array.isArray(contract.acceptance_criteria)) return contract.acceptance_criteria
  const parsed = parseJson<AcceptanceCriterion[] | null>(contract.acceptance_criteria, null)
  if (Array.isArray(parsed)) return parsed
  return contract.acceptance_criteria.split('\n').map((text) => text.trim()).filter(Boolean)
}

const evidenceArtifacts = (bundle: EvidenceBundle | null): Artifact[] =>
  bundle && Array.isArray(bundle.artifacts) ? bundle.artifacts : []

export function EvidencePane({ evidence, contract, card }: {
  evidence: Resource<EvidenceBundle | null>
  contract: Resource<TaskContract | null>
  card: Card | undefined
}) {
  const criteria = normalizeCriteria(contract.data)
  const commands = asStringList(contract.data?.verify_commands)
  const artifacts = evidenceArtifacts(evidence.data)
  const claims = evidence.data && Array.isArray(evidence.data.claims) ? evidence.data.claims : []
  const reviews = evidence.data && Array.isArray(evidence.data.reviews) ? evidence.data.reviews : []
  const processExits = evidence.data && Array.isArray(evidence.data.process_exits) ? evidence.data.process_exits : []
  const shipped = evidence.data && Array.isArray(evidence.data.shipped) ? evidence.data.shipped : []
  const gaps = evidence.data && Array.isArray(evidence.data.gaps) ? evidence.data.gaps : []
  const verificationArtifacts = evidence.data?.verification && typeof evidence.data.verification === 'object' && Array.isArray(evidence.data.verification.artifacts)
    ? evidence.data.verification.artifacts : []
  const verificationEvents = evidence.data?.verification && typeof evidence.data.verification === 'object' && Array.isArray(evidence.data.verification.events)
    ? evidence.data.verification.events : []
  const hasEvidence = Boolean(evidence.data && (
    artifacts.length || evidence.data.diff || evidence.data.review || evidence.data.shipped_commit || reviews.length || processExits.length || shipped.length || verificationArtifacts.length || verificationEvents.length
  ))

  return (
    <PaneFrame title="Delivery evidence" eyebrow={card ? `Task ${card.id}` : 'Unlinked workspace'}>
      {contract.status === 'error' && <div className="os-inline-error" role="alert">Contract: {contract.error}</div>}
      {contract.status === 'loading' && <PaneSkeleton />}
      {contract.status === 'ready' && contract.data && (
        <div className="os-contract">
          <div className="os-contract-objective">
            <span>Objective</span>
            <p>{contract.data.objective || card?.title || 'No objective recorded.'}</p>
          </div>
          {criteria.length > 0 && (
            <div className="os-evidence-section">
              <h4>Acceptance criteria</h4>
              <ol className="os-criteria">
                {criteria.map((criterion, index) => {
                  const item = typeof criterion === 'string' ? { text: criterion } : criterion
                  return (
                    <li key={item.id ?? index} className={item.met === true ? 'met' : item.met === false ? 'unmet' : ''}>
                      <span>{item.met === true ? <OsIcon name="check" size={13} /> : index + 1}</span>
                      <div><p>{item.text}</p>{item.evidence && <small>{item.evidence}</small>}</div>
                    </li>
                  )
                })}
              </ol>
            </div>
          )}
          <div className="os-contract-meta">
            <span><b>Priority</b>{contract.data.priority}</span>
            <span><b>Token budget</b>{contract.data.budget_tokens?.toLocaleString() ?? 'Open'}</span>
            <span><b>Cost budget</b>{contract.data.budget_cents === null ? 'Open' : `$${(contract.data.budget_cents / 100).toFixed(2)}`}</span>
          </div>
          {commands.length > 0 && (
            <div className="os-evidence-section">
              <h4>Verification commands</h4>
              {commands.map((command) => <code className="os-command-line" key={command}>{command}</code>)}
            </div>
          )}
        </div>
      )}

      <PaneState resource={evidence}
        emptyTitle={!hasEvidence && gaps.length === 0 ? 'No verified evidence yet' : undefined}
        emptyText="Claims alone do not pass review. Diffs, command exits, test reports, review decisions, and the shipped commit will collect here.">
        {hasEvidence && (
          <div className="os-evidence-sections">
            {(verificationArtifacts.length > 0 || verificationEvents.length > 0) && (
              <div className="os-evidence-record">
                <span>Verification</span>
                <dl>
                  <div><dt>Artifacts</dt><dd>{verificationArtifacts.length}</dd></div>
                  <div><dt>Recorded events</dt><dd>{verificationEvents.length}</dd></div>
                </dl>
              </div>
            )}
            {evidence.data?.review && <EvidenceRecord label="Review decision" value={evidence.data.review} />}
            {reviews.length > 0 && (
              <div className="os-evidence-record">
                <span>Review decisions</span>
                <dl>{reviews.map((review, index) => (
                  <div key={String(review.id ?? index)}><dt>{String(review.decision ?? `Review ${index + 1}`)}</dt><dd>{String(review.note ?? review.decided_at ?? 'Recorded')}</dd></div>
                ))}</dl>
              </div>
            )}
            {processExits.length > 0 && (
              <div className="os-evidence-record">
                <span>Process exits</span>
                <dl>{processExits.map((process) => (
                  <div key={String(process.id)}><dt>{process.name}</dt><dd>{process.status} · exit {process.exit_code ?? '—'} · {process.command}</dd></div>
                ))}</dl>
              </div>
            )}
            {evidence.data?.shipped_commit && (
              <div className="os-evidence-record"><span>Shipped commit</span><code>{evidence.data.shipped_commit}</code></div>
            )}
            {shipped.length > 0 && (
              <div className="os-evidence-record"><span>Shipped records</span><dl>{shipped.map((record, index) => (
                <div key={index}><dt>{record.source ?? 'ship event'}</dt><dd>{typeof record.detail === 'object' ? JSON.stringify(record.detail) : String(record.detail ?? record.created_at ?? 'Recorded')}</dd></div>
              ))}</dl></div>
            )}
            {artifacts.length > 0 && (
              <div className="os-evidence-section">
                <h4>Artifacts</h4>
                <div className="os-artifact-list">
                  {artifacts.map((artifact) => (
                    <div key={String(artifact.id)}>
                      <span className="os-artifact-kind">{artifact.kind}</span>
                      <div><strong>{artifact.name}</strong><small>{artifact.path ?? artifact.mime_type ?? normalizeTime(artifact.created_at)}</small></div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {claims.length > 0 && (
              <div className="os-evidence-section os-claims">
                <h4>Agent claims <span>Not evidence</span></h4>
                {claims.map((claim, index) => {
                  const text = typeof claim === 'string' ? claim
                    : typeof claim.claim === 'string' ? claim.claim : JSON.stringify(claim.claim ?? claim)
                  return <p key={index}>{claim && typeof claim === 'object' && claim.source ? `${claim.source}: ` : ''}{text}</p>
                })}
              </div>
            )}
            {gaps.length > 0 && (
              <div className="os-evidence-section os-evidence-gaps">
                <h4>Evidence gaps</h4>
                {gaps.map((gap) => <p key={gap}><OsIcon name="attention" size={12} /> {gap}</p>)}
              </div>
            )}
          </div>
        )}
        {!hasEvidence && gaps.length > 0 && (
          <div className="os-evidence-section os-evidence-gaps standalone">
            <h4>Evidence gaps</h4>
            {gaps.map((gap) => <p key={gap}><OsIcon name="attention" size={12} /> {gap}</p>)}
          </div>
        )}
      </PaneState>
    </PaneFrame>
  )
}

function EvidenceRecord({ label, value }: { label: string; value: unknown }) {
  const record = value && typeof value === 'object' ? value as JsonObject : { result: value }
  return (
    <div className="os-evidence-record">
      <span>{label}</span>
      <dl>{Object.entries(record).slice(0, 8).map(([key, item]) => (
        <div key={key}><dt>{key.split('_').join(' ')}</dt><dd>{typeof item === 'object' ? JSON.stringify(item) : String(item)}</dd></div>
      ))}</dl>
    </div>
  )
}

export function ContextPane({ context, onTogglePin }: {
  context: Resource<ContextItem[]>
  onTogglePin: (item: ContextItem) => Promise<void>
}) {
  const total = context.data.reduce((sum, item) => sum + (item.tokens || 0), 0)
  return (
    <PaneFrame title="Context manifest" eyebrow={`${total.toLocaleString()} attributable tokens`}>
      <PaneState resource={context}
        emptyTitle={context.data.length === 0 ? 'No explicit context' : undefined}
        emptyText="Pin files, decisions, and references to make the session's inputs inspectable and reproducible.">
        <div className="os-context-list">
          {context.data.map((item) => (
            <article key={String(item.id)} className={Boolean(item.pinned) ? 'pinned' : ''}>
              <header>
                <span className="os-context-kind">{item.kind}</span>
                <code>{item.tokens.toLocaleString()} tok</code>
                <button className="os-text-button" onClick={() => onTogglePin(item)}>
                  {item.pinned ? 'Unpin' : 'Pin'}
                </button>
              </header>
              <h4>{item.source}</h4>
              <p>{item.content}</p>
              {item.provenance && <small>Provenance: {typeof item.provenance === 'string' ? item.provenance : JSON.stringify(item.provenance)}</small>}
            </article>
          ))}
        </div>
      </PaneState>
    </PaneFrame>
  )
}

export function PolicyPane({ policies, contract }: {
  policies: Resource<Policy[]>
  contract: Resource<TaskContract | null>
}) {
  const [selectedId, setSelectedId] = useState<string>('')
  const [operationKind, setOperationKind] = useState<'filesystem' | 'command' | 'network' | 'secret'>('command')
  const [operationValue, setOperationValue] = useState('')
  const [decision, setDecision] = useState<PolicyDecision | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [evaluateError, setEvaluateError] = useState<string | null>(null)

  useEffect(() => {
    if (contract.data?.policy_id !== null && contract.data?.policy_id !== undefined) {
      setSelectedId(String(contract.data.policy_id))
    } else if (policies.data[0]) setSelectedId(String(policies.data[0].id))
  }, [contract.data?.policy_id, policies.data])

  const policy = policies.data.find((item) => String(item.id) === selectedId) ?? policies.data[0]

  const evaluate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!policy || !operationValue.trim()) return
    setEvaluating(true)
    try {
      setDecision(await osApi.evaluatePolicy(policy.id, { kind: operationKind, value: operationValue.trim() }))
      setEvaluateError(null)
    } catch (error) {
      setEvaluateError(error instanceof Error ? error.message : 'The policy could not be evaluated.')
    } finally { setEvaluating(false) }
  }

  return (
    <PaneFrame title="Policy" eyebrow="Filesystem, command, network, and secret capabilities">
      <PaneState resource={policies}
        emptyTitle={policies.data.length === 0 ? 'No policy assigned' : undefined}
        emptyText="Without an explicit policy, agent permissions continue through the existing advisory fallback.">
        {policy && (
          <div className="os-policy">
            {policies.data.length > 1 && (
              <label className="os-field">
                <span>Policy</span>
                <select value={String(policy.id)} onChange={(event) => { setSelectedId(event.target.value); setDecision(null) }}>
                  {policies.data.map((item) => <option value={String(item.id)} key={String(item.id)}>{item.name}</option>)}
                </select>
              </label>
            )}
            <div className="os-policy-title">
              <div><h4>{policy.name}</h4><p>Approval scope: {policy.approval_scope}</p></div>
              <span className="os-status-pill ready">active</span>
            </div>
            <PolicyRules label="Files" values={asStringList(policy.file_globs)} />
            <PolicyRules label="Commands" values={asStringList(policy.command_globs)} />
            <PolicyRules label="Network" values={asStringList(policy.network_hosts)} />
            <PolicyRules label="Secrets" values={asStringList(policy.secret_names)} redacted />

            <form className="os-policy-evaluator" onSubmit={evaluate}>
              <h4>Evaluate an operation</h4>
              <div className="os-policy-inputs">
                <label className="os-field">
                  <span>Capability</span>
                  <select value={operationKind} onChange={(event) => {
                    setOperationKind(event.target.value as typeof operationKind); setDecision(null); setEvaluateError(null)
                  }}>
                    <option value="command">Command</option><option value="filesystem">File</option>
                    <option value="network">Network host</option><option value="secret">Secret</option>
                  </select>
                </label>
                <label className="os-field grow">
                  <span>Operation</span>
                  <input value={operationValue} onChange={(event) => {
                    setOperationValue(event.target.value); setDecision(null); setEvaluateError(null)
                  }}
                    placeholder={operationKind === 'command' ? 'npm run build' : operationKind === 'filesystem' ? 'src/server.ts' : 'api.example.com'} />
                </label>
              </div>
              <button className="os-secondary-button" type="submit" disabled={!operationValue.trim() || evaluating}>
                {evaluating ? 'Evaluating' : 'Evaluate'}
              </button>
              {evaluateError && <div className="os-inline-error" role="alert">{evaluateError}</div>}
              {decision && <div className={`os-policy-decision ${decision.decision}`}><b>{decision.decision}</b><span>{decision.reason}</span></div>}
            </form>
          </div>
        )}
      </PaneState>
    </PaneFrame>
  )
}

function PolicyRules({ label, values, redacted = false }: { label: string; values: string[]; redacted?: boolean }) {
  return (
    <div className="os-policy-rules">
      <span>{label}</span>
      <div>{values.length === 0 ? <i>None declared</i> : values.map((value) => (
        <code key={value}>{redacted ? `${value.slice(0, 3)}${'•'.repeat(Math.min(5, Math.max(2, value.length - 3)))}` : value}</code>
      ))}</div>
    </div>
  )
}

export function ProcessesPane({ processes, activeId, onAttach, onSignal, onRestart }: {
  processes: Resource<WorkspaceProcess[]>
  activeId: string | null
  onAttach: (process: WorkspaceProcess) => void
  onSignal: (process: WorkspaceProcess, signal: string) => Promise<void>
  onRestart: (process: WorkspaceProcess) => Promise<void>
}) {
  const availablePorts = processes.data.flatMap((process) => process.ports ?? [])
  const localViewer = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(window.location.hostname)
  const [previewPort, setPreviewPort] = useState<number | null>(null)
  useEffect(() => {
    if (previewPort !== null && !availablePorts.includes(previewPort)) setPreviewPort(availablePorts[0] ?? null)
  }, [availablePorts.join(','), previewPort])
  return (
    <PaneFrame title="Processes & ports" eyebrow="Durable PTY recipes">
      <PaneState resource={processes}
        emptyTitle={processes.data.length === 0 ? 'No managed processes' : undefined}
        emptyText="Run a command from the terminal pane. Its PID, output, exit status, and restart recipe remain attached to this workspace.">
        <div className="os-process-list">
          {processes.data.map((process) => {
            const running = ['running', 'starting', 'stopping'].includes(process.status)
            return (
              <article className={String(process.id) === activeId ? 'active' : ''} key={String(process.id)}>
                <button className="os-process-main" onClick={() => onAttach(process)}>
                  <span className={`os-process-dot ${process.status}`} />
                  <div><strong>{process.name}</strong><code>{process.command}</code></div>
                  <OsIcon name="chevron" size={14} />
                </button>
                <dl>
                  <div><dt>Status</dt><dd>{process.status}</dd></div>
                  <div><dt>PID</dt><dd>{process.pid ?? '—'}</dd></div>
                  <div><dt>Exit</dt><dd>{process.exit_code ?? '—'}</dd></div>
                  <div><dt>Started</dt><dd>{normalizeTime(process.started_at)}</dd></div>
                </dl>
                {process.ports && process.ports.length > 0 && (
                  <div className="os-port-list">
                    {process.ports.map((port) => <span key={port}>
                      {localViewer ? <>
                        <button className={previewPort === port ? 'active' : ''} onClick={() => setPreviewPort(port)}>Preview :{port}</button>
                        <a href={`http://127.0.0.1:${port}`} target="_blank" rel="noreferrer" aria-label={`Open port ${port} in a new tab`}><OsIcon name="external" size={12} /></a>
                      </> : <code title="Port previews are local to the daemon host">Local daemon :{port}</code>}
                    </span>)}
                  </div>
                )}
                <footer>
                  {running ? (
                    <><button onClick={() => onSignal(process, 'SIGINT')}>Interrupt</button><button onClick={() => onSignal(process, 'SIGTERM')}>Terminate</button></>
                  ) : process.restartable ? <button onClick={() => onRestart(process)}>Restart recipe</button> : null}
                </footer>
              </article>
            )
          })}
        </div>
        {localViewer && previewPort !== null && (
          <section className="os-port-preview">
            <header><span>Local preview</span><code>127.0.0.1:{previewPort}</code><button onClick={() => setPreviewPort(null)} aria-label="Close local preview"><OsIcon name="close" size={12} /></button></header>
            <iframe src={`http://127.0.0.1:${previewPort}`} title={`Preview of local port ${previewPort}`} />
          </section>
        )}
      </PaneState>
    </PaneFrame>
  )
}
