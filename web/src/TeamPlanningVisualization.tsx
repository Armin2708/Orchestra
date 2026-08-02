import './teamPlanningVisualization.css'

export type TeamPlanningNode = {
  id: string
  kind: 'planning_team' | 'member' | 'delegation' | 'conflict'
  label?: string
  status?: string
  severity?: 'low' | 'medium' | 'high' | 'critical'
  roles?: string[]
}

export type TeamPlanningEdge = {
  from: string
  to: string
  kind: 'participant' | 'delegates' | 'assigned_to' | 'has_conflict' | 'affects'
}

export type TeamPlanningVisualizationData = {
  nodes: TeamPlanningNode[]
  edges: TeamPlanningEdge[]
  needs_you: Array<{ id: string; severity: string; title: string; detail: string }>
}

type Props = {
  data?: TeamPlanningVisualizationData | null
  loading?: boolean
  error?: string | null
}

export function TeamPlanningVisualization({ data, loading = false, error = null }: Props) {
  if (loading) {
    return <section className="team-viz team-viz-loading" aria-label="Loading team plan">
      <span /><span /><span />
    </section>
  }
  if (error) {
    return <section className="team-viz team-viz-error" role="alert">
      <p className="team-viz-kicker">Team map unavailable</p>
      <p>{error}</p>
    </section>
  }
  if (!data?.nodes.length) {
    return <section className="team-viz team-viz-empty">
      <p className="team-viz-kicker">No bounded plan</p>
      <h2>Create a plan with explicit participants and budgets.</h2>
      <p>The map will show role snapshots, delegations, overlaps, and the integration path.</p>
    </section>
  }

  const plans = data.nodes.filter((node) => node.kind === 'planning_team')
  const members = data.nodes.filter((node) => node.kind === 'member')
  const delegations = data.nodes.filter((node) => node.kind === 'delegation')
  const conflicts = data.nodes.filter((node) => node.kind === 'conflict')

  return <section className="team-viz" aria-label="Team planning and conflict map">
    <header className="team-viz-header">
      <div>
        <p className="team-viz-kicker">Bounded collaboration</p>
        <h2>Plans, delegation, and overlap</h2>
      </div>
      <dl className="team-viz-metrics">
        <Metric label="Plans" value={plans.length} />
        <Metric label="Participants" value={members.length} />
        <Metric label="Delegations" value={delegations.length} />
        <Metric label="Open attention" value={data.needs_you.length} alert={data.needs_you.length > 0} />
      </dl>
    </header>

    <div className="team-viz-layout">
      <div className="team-viz-flow">
        {plans.map((plan) => {
          const planMembers = linked(data, plan.id, 'participant')
          const planDelegations = linked(data, plan.id, 'delegates')
          const planConflicts = linked(data, plan.id, 'has_conflict')
          return <article key={plan.id} className="team-viz-plan">
            <div className="team-viz-plan-heading">
              <span className={`team-viz-status status-${plan.status ?? 'unknown'}`} />
              <div><h3>{plan.label ?? 'Team plan'}</h3><p>{plan.status ?? 'unknown'}</p></div>
            </div>
            <div className="team-viz-rail" aria-label="Plan execution sequence">
              <Lane label="Participants" nodes={planMembers} />
              <Lane label="Delegated work" nodes={planDelegations} />
              <Lane label="Conflicts" nodes={planConflicts} conflicts />
            </div>
          </article>
        })}
      </div>

      <aside className="team-viz-attention" aria-label="Team conflicts needing attention">
        <p className="team-viz-kicker">Needs you</p>
        {data.needs_you.length === 0
          ? <p className="team-viz-muted">No high-risk team conflicts are waiting.</p>
          : data.needs_you.map((item) => <article key={item.id}>
            <span>{item.severity}</span><h3>{item.title}</h3><p>{item.detail}</p>
          </article>)}
        {conflicts.length > 0 && <div className="team-viz-conflict-index">
          <p className="team-viz-kicker">Conflict register</p>
          {conflicts.map((conflict) => <div key={conflict.id}>
            <span className={`severity-${conflict.severity ?? 'low'}`} />
            <p>{conflict.label ?? conflict.id}</p><small>{conflict.status}</small>
          </div>)}
        </div>}
      </aside>
    </div>
  </section>
}

function linked(data: TeamPlanningVisualizationData, id: string, kind: TeamPlanningEdge['kind']) {
  const ids = new Set(data.edges.filter((edge) => edge.from === id && edge.kind === kind)
    .map((edge) => edge.to))
  return data.nodes.filter((node) => ids.has(node.id))
}

function Lane({ label, nodes, conflicts = false }: {
  label: string
  nodes: TeamPlanningNode[]
  conflicts?: boolean
}) {
  return <div className="team-viz-lane">
    <p>{label}</p>
    <div>{nodes.length === 0
      ? <span className="team-viz-placeholder">None</span>
      : nodes.map((node) => <span key={node.id} className={conflicts ? `severity-${node.severity}` : ''}>
        {node.label ?? node.roles?.join(' · ') ?? node.kind}
      </span>)}</div>
  </div>
}

function Metric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return <div className={alert ? 'is-alert' : ''}><dt>{label}</dt><dd>{value}</dd></div>
}
