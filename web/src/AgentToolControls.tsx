import type {
  SessionToolCapability,
  SessionToolSnapshot,
  ToolPolicyDecision,
} from './agentToolApi'

const DECISIONS: Array<{ id: ToolPolicyDecision; label: string }> = [
  { id: 'approval_required', label: 'Ask every time' },
  { id: 'allow', label: 'Allow' },
  { id: 'deny', label: 'Deny' },
]

const title = (value: string): string => value
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (character: string) => character.toUpperCase())

const toolState = (tool: SessionToolCapability): string => {
  if (tool.status === 'ready' && tool.managed_support === 'supported') return 'Managed ready'
  if (tool.direct_terminal_available) return 'Managed unavailable · terminal available'
  return `Managed ${tool.managed_support}`
}

export function AgentToolControls({
  snapshot,
  busyToolId = null,
  error = null,
  readOnly = false,
  onPolicyChange,
}: {
  snapshot: SessionToolSnapshot
  busyToolId?: string | null
  error?: string | null
  readOnly?: boolean
  onPolicyChange: (toolId: string, decision: ToolPolicyDecision) => void
}) {
  const provider = snapshot.provider
  const drift = snapshot.permission_drift.filter((entry) => entry.status !== 'aligned')
  const grouped = snapshot.tools.reduce((groups, tool) => {
    const list = groups.get(tool.kind) ?? []
    list.push(tool)
    groups.set(tool.kind, list)
    return groups
  }, new Map<SessionToolCapability['kind'], SessionToolCapability[]>())

  return (
    <section className="agent-tool-controls" aria-labelledby="agent-tool-controls-title">
      <header className="agent-tool-controls__header">
        <div>
          <p className="agent-tool-controls__eyebrow">Effective session capabilities</p>
          <h3 id="agent-tool-controls-title">Tools & permissions</h3>
        </div>
        <span className="agent-tool-controls__terminal-truth">
          Direct terminal remains the source of truth
        </span>
      </header>

      {provider && (
        <div className={`agent-tool-provider agent-tool-provider--${provider.managed_support}`}>
          <div>
            <strong>{provider.display_name}</strong>
            <span>{provider.mode_id} · {provider.billing_mode}</span>
          </div>
          <div>
            <span>{provider.release_state}</span>
            <span>{provider.accepted_evidence ? 'Acceptance verified' : 'Acceptance evidence missing'}</span>
          </div>
          {provider.blockers.length > 0 && (
            <p role="status">Blocked: {provider.blockers.map(title).join(' · ')}</p>
          )}
        </div>
      )}

      {drift.length > 0 && (
        <div className="agent-tool-drift" role="alert">
          <strong>{drift.length} permission {drift.length === 1 ? 'difference' : 'differences'}</strong>
          <ul>
            {drift.map((entry) => (
              <li key={entry.tool_id}>
                {entry.tool_id}: requested {title(entry.requested)}, effective {title(entry.effective)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="agent-tool-controls__error" role="alert">{error}</p>}

      {[...grouped.entries()].map(([kind, tools]) => (
        <div className="agent-tool-group" key={kind}>
          <h4>{title(kind)}</h4>
          <div className="agent-tool-list">
            {tools.map((tool) => (
              <article className={`agent-tool-card agent-tool-card--${tool.status}`} key={tool.id}>
                <div className="agent-tool-card__identity">
                  <strong>{tool.name}</strong>
                  <span>{toolState(tool)}</span>
                </div>
                <dl>
                  <div><dt>Status</dt><dd>{title(tool.status)}</dd></div>
                  <div><dt>Effective</dt><dd>{title(tool.permission.effective)}</dd></div>
                  <div><dt>Evidence</dt><dd>{title(tool.provenance.evidence)}</dd></div>
                  {tool.provenance.executable?.version && (
                    <div><dt>Version</dt><dd>{tool.provenance.executable.version}</dd></div>
                  )}
                </dl>
                {tool.error && <p className="agent-tool-card__error">{tool.error.detail}</p>}
                <label>
                  Session policy
                  <select
                    aria-label={`${tool.name} session policy`}
                    value={tool.permission.requested}
                    disabled={readOnly || busyToolId === tool.id}
                    onChange={(event) => onPolicyChange(
                      tool.id,
                      event.target.value as ToolPolicyDecision,
                    )}>
                    {DECISIONS.map((decision) => (
                      <option key={decision.id} value={decision.id}>{decision.label}</option>
                    ))}
                  </select>
                </label>
              </article>
            ))}
          </div>
        </div>
      ))}

      {snapshot.tools.length === 0 && (
        <p className="agent-tool-controls__empty">
          No managed tool metadata is available for this session. Use the terminal for installed tools.
        </p>
      )}

      {snapshot.approvals.length > 0 && (
        <div className="agent-tool-approvals">
          <h4>Needs your approval</h4>
          <ul>
            {snapshot.approvals.map((approval) => (
              <li key={approval.id}>
                <strong>{approval.title}</strong>
                <span>{title(approval.severity)} · routed to Needs You</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="agent-tool-controls__privacy">
        Invocation history stores tool identity, outcome, and a one-way argument digest. Inputs and outputs stay withheld.
      </p>
    </section>
  )
}
