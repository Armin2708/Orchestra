import React, { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  osApi,
  type JsonObject,
  type OrganizationControlCenter,
  type OrganizationRecord,
} from './osApi'
import {
  organizationAttention,
  organizationCounts,
  organizationList,
  organizationText,
} from './organizationPresentation'
import './organizationCenter.css'

type BoardRef = { id: number; name: string }
type OrganizationClient = Pick<typeof osApi,
  'listOrganizations' | 'createOrganization' | 'getOrganizationControlCenter'>

type Props = {
  boards: BoardRef[]
  client?: OrganizationClient
}

const commandKey = (scope: string) =>
  `orchestra-web:${scope}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`

export function OrganizationCenter({ boards, client = osApi }: Props) {
  const [organizations, setOrganizations] = useState<OrganizationRecord[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [center, setCenter] = useState<OrganizationControlCenter | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const boardIds = boards.map((board) => board.id).join(',')

  const loadOrganizations = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const listed = (await Promise.all(boards.map((board) =>
        client.listOrganizations(board.id)))).flat()
      setOrganizations(listed)
      setSelectedId((current) => listed.some((item) => item.id === current)
        ? current : listed[0]?.id ?? '')
      if (!listed.length) setCenter(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [boardIds, client])

  useEffect(() => { void loadOrganizations() }, [loadOrganizations])

  useEffect(() => {
    if (!selectedId) return
    let current = true
    setLoading(true)
    setError(null)
    client.getOrganizationControlCenter(selectedId)
      .then((value) => { if (current) setCenter(value) })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [client, selectedId])

  const selected = organizations.find((item) => item.id === selectedId) ?? null
  const counts = useMemo(() => center ? organizationCounts(center) : null, [center])
  const attention = useMemo(() => center ? organizationAttention(center) : [], [center])

  return (
    <main className="org-center">
      <header className="oc-header">
        <div>
          <p className="oc-kicker">Organization control plane</p>
          <h1>{selected?.name ?? 'Build your agent organization'}</h1>
          <p className="oc-intro">Bounded teams, explicit authority, durable decisions, independent quality gates, and an exact path from objective to outcome.</p>
        </div>
        <div className="oc-actions">
          {organizations.length > 0 && (
            <label><span>Organization</span><select value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}>
              {organizations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
          )}
          <button type="button" className="oc-button secondary" onClick={() => void loadOrganizations()}>Refresh</button>
          <button type="button" className="oc-button" onClick={() => setCreateOpen(true)} disabled={!boards.length}>New organization</button>
        </div>
      </header>

      {error && <div className="oc-alert" role="alert"><strong>Control center unavailable</strong><span>{error}</span></div>}
      {loading && !center && <div className="oc-loading" aria-label="Loading organization"><span /><span /><span /></div>}
      {!loading && !center && !error && (
        <section className="oc-empty">
          <p className="oc-kicker">No organization yet</p>
          <h2>Turn this project into a governed agent team.</h2>
          <p>Create the organization boundary first. Teams, roles, goals, quality gates, and measurement attach to it.</p>
          <button type="button" className="oc-button" onClick={() => setCreateOpen(true)} disabled={!boards.length}>Create organization</button>
        </section>
      )}

      {center && counts && (
        <>
          <dl className="oc-counts">
            <Metric label="Teams" value={counts.teams} />
            <Metric label="Active members" value={counts.activeMembers} />
            <Metric label="Objectives" value={counts.objectives} />
            <Metric label="Decisions" value={counts.decisions} />
            <Metric label="Trace nodes" value={counts.traceNodes} />
            <Metric label="Passing gates" value={counts.gatesPassing} />
            <Metric label="Needs you" value={counts.needsYou} alert={counts.needsYou > 0} />
          </dl>

          <div className="oc-grid">
            <Panel title="Organization map" kicker="Ownership & capacity" wide>
              <div className="oc-team-grid">
                {center.organization.teams.map((team) => {
                  const teamId = organizationText(team, ['id'])
                  const members = center.organization.memberships
                    .filter((row) => organizationText(row, ['team_id']) === teamId)
                  const goals = center.coordination.goals
                    .filter((row) => organizationText(row, ['team_id']) === teamId)
                  const capacity = center.coordination.capacity
                    .find((row) => organizationText(row, ['team_id']) === teamId)
                  const owned = center.organization.ownerships
                    .filter((row) => organizationText(row, ['team_id']) === teamId)
                  return <article className="oc-team" key={teamId}>
                    <header><span className="oc-status">{organizationText(team, ['status'])}</span>
                      <h3>{organizationText(team, ['name'])}</h3>
                      <p>{organizationText(team, ['mission'])}</p></header>
                    <div className="oc-team-stats"><span>{members.length} members</span><span>{goals.length} goals</span>
                      <span>{owned.length} owned surfaces</span></div>
                    {capacity && <div className="oc-capacity">
                      <span>WIP {organizationText(capacity, ['current_wip'])}/{organizationText(capacity, ['wip_limit'])}</span>
                      <span>{organizationText(capacity, ['blocked_count'], '0')} blocked</span>
                      <span>{organizationText(capacity, ['queued_demand'], '0')} queued</span>
                    </div>}
                  </article>
                })}
                {!center.organization.teams.length && <Empty text="No bounded teams have been created." />}
              </div>
            </Panel>

            <Panel title="Needs You" kicker="Authority & attention" tone={attention.length ? 'alert' : 'normal'}>
              <RecordList rows={attention.map((item) => ({
                id: item.id, title: item.title, detail: item.detail,
                meta: `${item.kind.replace('_', ' ')} · ${item.severity}`,
              }))} empty="No escalations, incidents, appeals, failed gates, or overdue actions." />
            </Panel>

            <Panel title="Objectives & decisions" kicker="Why work exists">
              <RecordList rows={center.coordination.objectives.map((row) => ({
                id: organizationText(row, ['id']),
                title: organizationText(row, ['statement', 'objective_key']),
                detail: `${organizationList(row.customer_evidence_refs_json).length} customer evidence links`,
                meta: organizationText(row, ['status']),
              }))} empty="No objectives recorded." />
              <div className="oc-divider" />
              <RecordList rows={center.coordination.decisions.map((row) => ({
                id: organizationText(row, ['id']),
                title: organizationText(row, ['question', 'decision_key']),
                detail: organizationText(row, ['rationale']),
                meta: `selected ${organizationText(row, ['selected_option'])}`,
              }))} empty="No binding decisions recorded." />
            </Panel>

            <Panel title="Quality gate center" kicker="Independent assurance">
              <RecordList rows={center.assurance.quality_gate_runs.map((row) => ({
                id: organizationText(row, ['id']),
                title: `${organizationText(row, ['subject_kind'])} · ${organizationText(row, ['subject_id'])}`,
                detail: `Risk ${organizationText(row, ['risk_tier'])} · deadline ${shortDate(row.deadline)}`,
                meta: organizationText(row, ['status']),
              }))} empty="No quality-gate runs yet." />
              <footer className="oc-panel-footer">{center.assurance.provenance_attestations.length} provenance attestations · {center.assurance.access_certifications.length} access certifications</footer>
            </Panel>

            <Panel title="Objective → outcome trace" kicker="Digest-verifiable lineage" wide>
              <div className="oc-trace">
                {center.assurance.trace_nodes.map((row, index) => <React.Fragment key={organizationText(row, ['id'])}>
                  {index > 0 && <span className="oc-arrow" aria-hidden="true">→</span>}
                  <article><span>{organizationText(row, ['node_kind'])}</span>
                    <strong>{organizationText(row, ['external_ref'])}</strong>
                    <code>{organizationText(row, ['sha256']).slice(0, 10)}</code></article>
                </React.Fragment>)}
                {!center.assurance.trace_nodes.length && <Empty text="No trace nodes have been attested." />}
              </div>
              <footer className="oc-panel-footer">{center.assurance.trace_edges.length} verified relationships · {center.assurance.knowledge_promotions.length} promoted lessons</footer>
            </Panel>

            <Panel title="Outcome scorecards" kicker="Team-level measurement">
              <RecordList rows={center.assurance.scorecards.map((row) => ({
                id: organizationText(row, ['id']),
                title: `${organizationText(row, ['subject_kind'])} · ${organizationText(row, ['subject_id'])}`,
                detail: `${shortDate(row.window_start)} — ${shortDate(row.window_end)} · ${organizationText(row, ['confidence'])} confidence`,
                meta: organizationText(row, ['status']),
              }))} empty="No contextual scorecards yet." />
              <footer className="oc-panel-footer">{center.assurance.metric_definitions.length} governed metrics · {center.assurance.insufficient_evidence_observations} insufficient-evidence observations</footer>
            </Panel>

            <Panel title="Reliability & learning" kicker="Incidents become controls">
              <RecordList rows={center.assurance.incidents.map((row) => ({
                id: organizationText(row, ['id']),
                title: organizationText(row, ['title']),
                detail: `${organizationText(row, ['severity'])} · ${organizationText(row, ['impact'])}`,
                meta: organizationText(row, ['status']),
              }))} empty="No incidents recorded." />
              <footer className="oc-panel-footer">{center.assurance.postmortems.length} postmortems · {center.assurance.corrective_actions.length} corrective/preventive actions</footer>
            </Panel>
          </div>
        </>
      )}

      {createOpen && <CreateOrganizationDialog boards={boards} client={client}
        onClose={() => setCreateOpen(false)} onCreated={async (record) => {
          setCreateOpen(false)
          await loadOrganizations()
          setSelectedId(record.id)
        }} />}
    </main>
  )
}

function Metric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return <div className={alert ? 'alert' : ''}><dt>{label}</dt><dd>{value}</dd></div>
}

function Panel({ title, kicker, children, wide = false, tone = 'normal' }: {
  title: string; kicker: string; children: React.ReactNode; wide?: boolean; tone?: 'normal' | 'alert'
}) {
  return <section className={`oc-panel${wide ? ' wide' : ''}${tone === 'alert' ? ' alert' : ''}`}>
    <header><p>{kicker}</p><h2>{title}</h2></header><div className="oc-panel-body">{children}</div>
  </section>
}

function RecordList({ rows, empty }: { rows: Array<{ id: string; title: string; detail: string; meta: string }>; empty: string }) {
  if (!rows.length) return <Empty text={empty} />
  return <div className="oc-records">{rows.slice(0, 8).map((row) => <article key={row.id}>
    <span>{row.meta}</span><strong>{row.title}</strong><p>{row.detail}</p>
  </article>)}</div>
}

function Empty({ text }: { text: string }) { return <p className="oc-muted">{text}</p> }

function shortDate(value: unknown): string {
  if (!value) return '—'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString()
}

function CreateOrganizationDialog({ boards, client, onClose, onCreated }: {
  boards: BoardRef[]
  client: OrganizationClient
  onClose: () => void
  onCreated: (record: OrganizationRecord) => void | Promise<void>
}) {
  const [boardId, setBoardId] = useState(boards[0]?.id ?? 0)
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [mission, setMission] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const record = await client.createOrganization(boardId, {
        key, name, mission, idempotency_key: commandKey(`organization-create:${boardId}:${key}`),
      })
      await onCreated(record)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return <div className="oc-dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}><form className="oc-dialog" onSubmit={submit}>
    <header><div><p className="oc-kicker">Organization boundary</p><h2>New organization</h2></div>
      <button type="button" onClick={onClose} aria-label="Close">×</button></header>
    {boards.length > 1 && <label><span>Project</span><select value={boardId}
      onChange={(event) => setBoardId(Number(event.target.value))}>{boards.map((board) =>
        <option value={board.id} key={board.id}>{board.name}</option>)}</select></label>}
    <label><span>Key</span><input value={key} required pattern="[a-z0-9][a-z0-9._-]*"
      placeholder="product-engineering" onChange={(event) => setKey(event.target.value.toLowerCase())} /></label>
    <label><span>Name</span><input value={name} required placeholder="Product Engineering"
      onChange={(event) => setName(event.target.value)} /></label>
    <label><span>Mission</span><textarea value={mission} required rows={4}
      placeholder="Own the customer outcome and its safe delivery."
      onChange={(event) => setMission(event.target.value)} /></label>
    {error && <p className="oc-form-error" role="alert">{error}</p>}
    <footer><button type="button" className="oc-button secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className="oc-button" disabled={busy}>{busy ? 'Creating…' : 'Create organization'}</button></footer>
  </form></div>
}
