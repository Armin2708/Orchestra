import React from 'react'
import type { DeliveryOutcome, DeliveryPromise, DeliveryReport } from './osApi'
import './jobDeliveryDetail.css'

export type DeliveryListFilter = 'all' | 'awaiting_review' | 'evidence_gaps' | 'rejected' | 'overridden' | 'shipped'

export type JobDeliveryDetailModel = {
  job: {
    id: string | number
    status: string
    provider: string
  }
  requested: DeliveryReport['asked'] & { contract_version?: number; contract_updated_at?: string }
  delivered: DeliveryReport
  lineage: DeliveryReport[]
  verification_runs: Array<{
    id: string
    command: string
    cwd: string
    environment: Record<string, string>
    environment_sha256: string
    exit_code: number
    output_artifact_id: string
    output_sha256: string
    started_at: string
    finished_at: string
    recorded_by: string
  }>
  artifact_attestations: Array<{
    id: string
    artifact_id: string
    content_sha256: string
    byte_size: number
    source_kind: string
    source_locator: string
    source_revision: string | null
    builder: string
    attestation_sha256: string
  }>
  review_comments: Array<{
    id: string
    criterion_id: string | null
    deliverable_id: string | null
    artifact_id: string
    location: { path?: string; startLine?: number; endLine?: number; startByte?: number; endByte?: number }
    body: string
    author: string
    created_at: string
  }>
  shipments: Array<{
    id: string
    source_repository: string
    source_commit: string
    destination: string
    deployment_ref: string | null
    manifest_sha256: string
    shipped_by: string
    shipped_at: string
  }>
  regressions: Array<{
    id: string
    summary: string
    evidence_artifact_id: string
    reopened_report_id: string
    recorded_by: string
    observed_at: string
  }>
  evidence_gaps: string[]
}

const FILTERS: Array<{ id: DeliveryListFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'awaiting_review', label: 'Awaiting review' },
  { id: 'evidence_gaps', label: 'Evidence gaps' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'overridden', label: 'Overridden' },
  { id: 'shipped', label: 'Shipped' },
]

export function DeliveryTrackbookFilterBar({
  value,
  onChange,
  counts = {},
}: {
  value: DeliveryListFilter
  onChange: (value: DeliveryListFilter) => void
  counts?: Partial<Record<DeliveryListFilter, number>>
}) {
  return <nav className="job-delivery-filters" aria-label="Delivery filters">
    {FILTERS.map((filter) => <button key={filter.id} type="button" aria-pressed={value === filter.id}
      onClick={() => onChange(filter.id)}>
      {filter.label}{counts[filter.id] !== undefined && <span>{counts[filter.id]}</span>}
    </button>)}
  </nav>
}

export function JobDeliveryDetail({ detail }: { detail: JobDeliveryDetailModel }) {
  const report = detail.delivered
  return <main className="job-delivery-detail">
    <header className="job-delivery-heading">
      <div><p>Job {String(detail.job.id)}</p><h2>Requested versus delivered</h2></div>
      <dl><div><dt>Job</dt><dd>{label(detail.job.status)}</dd></div>
        <div><dt>Delivery</dt><dd>{label(report.status)}</dd></div>
        <div><dt>Revision</dt><dd>{report.sequence}</dd></div></dl>
    </header>

    <section className="job-delivery-comparison" aria-label="Requested and delivered comparison">
      <article>
        <header><span>Requested</span><h3>The frozen contract</h3></header>
        <div className="job-delivery-objective"><small>Objective</small><p>{detail.requested.objective}</p></div>
        <PromiseGroup title="Deliverables" items={detail.requested.deliverables} />
        <PromiseGroup title="Acceptance criteria" items={detail.requested.acceptance_criteria} />
        <section><h4>Exact verification requested</h4>{detail.requested.verify_commands.length
          ? detail.requested.verify_commands.map((command) => <code key={command}>{command}</code>)
          : <Empty>No command was requested.</Empty>}</section>
        <dl className="job-delivery-contract-facts">
          <div><dt>Contract</dt><dd>v{String(detail.requested.version ?? detail.requested.contract_version ?? '—')}</dd></div>
          <div><dt>Base</dt><dd>{detail.requested.base_ref ?? 'Not frozen'}</dd></div>
          <div><dt>Provider</dt><dd>{detail.job.provider}</dd></div>
        </dl>
      </article>

      <article>
        <header><span>Delivered</span><h3>The observed result</h3></header>
        <div className="job-delivery-objective"><small>Submitted summary</small><p>{report.summary || 'No summary submitted.'}</p></div>
        <OutcomeGroup title="Deliverables" requested={detail.requested.deliverables} results={report.deliverable_results} />
        <OutcomeGroup title="Acceptance criteria" requested={detail.requested.acceptance_criteria} results={report.criterion_results} />
        {report.claims.length > 0 && <aside className="job-delivery-claims"><h4>Agent claims · not evidence</h4>
          <ul>{report.claims.map((claim, index) => <li key={`${claim.text}:${index}`}>{claim.text}</li>)}</ul></aside>}
        {detail.evidence_gaps.length > 0 && <aside className="job-delivery-gaps"><h4>Evidence gaps</h4>
          <ul>{detail.evidence_gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></aside>}
      </article>
    </section>

    <section className="job-delivery-ledger" aria-labelledby="job-delivery-proof-title">
      <header><p>Immutable proof</p><h3 id="job-delivery-proof-title">Verification and provenance</h3></header>
      <div className="job-delivery-proof-grid">
        <section><h4>Verification runs <span>{detail.verification_runs.length}</span></h4>
          {detail.verification_runs.length ? detail.verification_runs.map((run) => <article key={run.id}>
            <div className="job-delivery-run-result" data-result={run.exit_code === 0 ? 'pass' : 'fail'}>
              <strong>{run.exit_code === 0 ? 'Passed' : `Exit ${run.exit_code}`}</strong><time>{formatTime(run.finished_at)}</time></div>
            <code>{run.command}</code><dl><div><dt>cwd</dt><dd>{run.cwd}</dd></div>
              <div><dt>Environment</dt><dd><Digest value={run.environment_sha256} /></dd></div>
              <div><dt>Output</dt><dd>{run.output_artifact_id} · <Digest value={run.output_sha256} /></dd></div>
              <div><dt>Actor</dt><dd>{run.recorded_by}</dd></div></dl>
          </article>) : <Empty>No exact verification run has been recorded.</Empty>}
        </section>

        <section><h4>Artifact attestations <span>{detail.artifact_attestations.length}</span></h4>
          {detail.artifact_attestations.length ? detail.artifact_attestations.map((artifact) => <article key={artifact.id}>
            <strong>{artifact.artifact_id}</strong><p>{artifact.source_kind} · {artifact.source_locator}</p>
            <dl><div><dt>Content</dt><dd><Digest value={artifact.content_sha256} /> · {artifact.byte_size} bytes</dd></div>
              <div><dt>Source revision</dt><dd>{artifact.source_revision ?? 'Not applicable'}</dd></div>
              <div><dt>Attestation</dt><dd><Digest value={artifact.attestation_sha256} /></dd></div></dl>
          </article>) : <Empty>No artifact provenance has been attested.</Empty>}
        </section>
      </div>
    </section>

    <section className="job-delivery-audit-grid">
      <section><header><p>Review</p><h3>Comments at exact evidence</h3></header>
        {detail.review_comments.length ? <ol>{detail.review_comments.map((comment) => <li key={comment.id}>
          <div><strong>{comment.criterion_id ? `Criterion ${comment.criterion_id}` : `Deliverable ${comment.deliverable_id}`}</strong>
            <time>{formatTime(comment.created_at)}</time></div><p>{comment.body}</p>
          <small>{comment.author} · artifact {comment.artifact_id} · {locationText(comment.location)}</small>
        </li>)}</ol> : <Empty>No review comments are linked.</Empty>}
      </section>

      <section><header><p>Shipping</p><h3>Canonical shipped records</h3></header>
        {detail.shipments.length ? <ol>{detail.shipments.map((shipment) => <li key={shipment.id}>
          <div><strong>{shipment.destination}</strong><time>{formatTime(shipment.shipped_at)}</time></div>
          <p>{shipment.source_repository} · <code>{shipment.source_commit}</code></p>
          <small>Manifest <Digest value={shipment.manifest_sha256} /> · {shipment.shipped_by}</small>
        </li>)}</ol> : <Empty>Accepted, but not recorded as shipped.</Empty>}
        {detail.regressions.map((regression) => <aside className="job-delivery-regression" key={regression.id}>
          <strong>Reopened after regression</strong><p>{regression.summary}</p>
          <small>Evidence {regression.evidence_artifact_id} · revision {regression.reopened_report_id}</small>
        </aside>)}
      </section>
    </section>
  </main>
}

function PromiseGroup({ title, items }: { title: string; items: DeliveryPromise[] }) {
  return <section><h4>{title}</h4>{items.length ? <ol className="job-delivery-promises">{items.map((item, index) => <li key={String(item.id ?? index)}>
    <span>{index + 1}</span><p>{item.text}<small>{item.required ? 'Required' : 'Optional'}</small></p>
  </li>)}</ol> : <Empty>None recorded.</Empty>}</section>
}

function OutcomeGroup({ title, requested, results }: {
  title: string
  requested: DeliveryPromise[]
  results: DeliveryOutcome[]
}) {
  return <section><h4>{title}</h4><ol className="job-delivery-outcomes">{requested.map((promise, index) => {
    const result = results.find((candidate) => candidate.id === promise.id) ?? results[index] ?? null
    const status = result?.status ?? 'missing'
    return <li key={String(promise.id ?? index)} data-status={status}>
      <div><p>{promise.text}</p><span>{label(status)}</span></div>
      {result?.note && <small>Verifier: {result.note}</small>}
      {result?.evidence.length ? <ul>{result.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}>
        {typeof evidence === 'string' ? evidence : String(evidence.label ?? evidence.ref ?? 'Evidence reference')}
      </li>)}</ul> : <small>No observed evidence linked.</small>}
      {result?.override && <aside><strong>Human override</strong><p>{result.override.reason}</p></aside>}
    </li>
  })}</ol></section>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="job-delivery-empty">{children}</p>
}

function Digest({ value }: { value: string }) {
  return <code title={value}>{value.slice(0, 12)}…</code>
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase())
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function locationText(location: JobDeliveryDetailModel['review_comments'][number]['location']) {
  const path = location.path ? `${location.path}:` : ''
  if (location.startLine !== undefined) return `${path}${location.startLine}${location.endLine !== location.startLine ? `–${location.endLine}` : ''}`
  return `${path}bytes ${location.startByte}–${location.endByte}`
}
