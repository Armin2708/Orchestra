import React, { useEffect, useMemo, useState } from 'react'
import { Card } from './api'
import {
  Artifact,
  DeliveryCollection,
  DeliveryEvidence,
  DeliveryOutcome,
  DeliveryPromise,
  DeliveryReport,
  EvidenceBundle,
  JobDeliveryDetailModel,
  JsonObject,
  osApi,
  OsEvent,
  parseJson,
  TaskContract,
} from './osApi'
import { DeliveryTrackbookFilterBar, JobDeliveryDetail, type DeliveryListFilter } from './JobDeliveryDetail'
import { JobDetailDiscussions } from './DiscussionCenter'
import { OsIcon, OsIconName } from './OsIcon'
import { PaneFrame, PaneSkeleton, Resource } from './WorkspacePanes'

type TrackbookAsked = {
  objective: string
  deliverables: DeliveryPromise[]
  criteria: DeliveryPromise[]
  nonGoals: string[]
  risks: string[]
  verifyCommands: string[]
  dependencies: string[]
  baseRef: string | null
  budgetTokens: number | null
  budgetCents: number | null
  priority: number
  policyId: string | null
  version: string | number | null
  updatedAt: string | null
}

type DeltaRow = {
  key: string
  promised: DeliveryPromise
  result: DeliveryOutcome | null
  extra: boolean
}

type TimelineItem = {
  id: string
  kind: 'test' | 'review' | 'process' | 'artifact' | 'shipped'
  label: string
  title: string
  detail: string | null
  status: string | null
  time: string | null
  icon: OsIconName
}

const GOOD_STATUSES = new Set(['accepted', 'complete', 'completed', 'delivered', 'met', 'pass', 'passed', 'shipped', 'verified'])
const BAD_STATUSES = new Set(['blocked', 'failed', 'fail', 'missed', 'rejected', 'unmet'])
const EVIDENCE_GAP_STATUSES = new Set(['claimed', 'missing', 'partial', 'pending', 'submitted', 'unknown', 'unverifiable', 'unverified'])

const recordValue = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonObject : {}

const firstText = (record: JsonObject, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key]
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim()
  }
  return null
}

const normalizeTime = (value: string | null | undefined) => {
  if (!value) return 'Not recorded'
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

const statusLabel = (status: string | null | undefined) => {
  if (!status) return 'Not reported'
  if (status === 'unverifiable') return 'Unverifiable'
  return status.split('_').join(' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

const statusTone = (status: string | null | undefined) => {
  const value = status?.toLowerCase() ?? 'missing'
  if (GOOD_STATUSES.has(value)) return 'verified'
  if (BAD_STATUSES.has(value)) return 'failed'
  if (value === 'overridden') return 'overridden'
  return 'unverified'
}

const contractPromises = (value: unknown): DeliveryPromise[] => {
  const raw = Array.isArray(value) ? value : parseJson<unknown>(value, value)
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split('\n').map((item) => item.trim()).filter(Boolean) : []
  return list.map((promise, index) => {
    if (typeof promise === 'string') return {
      id: null, text: promise, required: true, deliverable_ids: [], metadata: {},
    }
    const row = recordValue(promise)
    return {
      id: firstText(row, ['id', 'deliverable_id', 'criterion_id']),
      text: firstText(row, ['text', 'description', 'title']) ?? `Outcome ${index + 1}`,
      required: row.required !== false,
      deliverable_ids: Array.isArray(row.deliverable_ids) ? row.deliverable_ids.map(String) : [],
      metadata: recordValue(row.metadata),
    }
  })
}

const contractCommands = (contract: TaskContract | null): string[] => {
  if (!contract) return []
  const raw = parseJson<unknown>(contract.verify_commands, contract.verify_commands)
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return typeof raw === 'string' ? raw.split('\n').map((item) => item.trim()).filter(Boolean) : []
}

const contractStrings = (value: unknown): string[] => {
  const raw = parseJson<unknown>(value, value)
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return typeof raw === 'string' ? raw.split('\n').map((item) => item.trim()).filter(Boolean) : []
}

const askedFor = (delivery: DeliveryReport | null, contract: TaskContract | null, card: Card | undefined): TrackbookAsked => {
  if (delivery) return {
    objective: delivery.asked.objective || card?.description || card?.title || 'No objective recorded.',
    deliverables: delivery.asked.deliverables,
    criteria: delivery.asked.acceptance_criteria,
    nonGoals: delivery.asked.non_goals,
    risks: delivery.asked.risks,
    verifyCommands: delivery.asked.verify_commands,
    dependencies: delivery.asked.dependencies.map(String),
    baseRef: delivery.asked.base_ref,
    budgetTokens: delivery.asked.budget_tokens,
    budgetCents: delivery.asked.budget_cents,
    priority: delivery.asked.priority,
    policyId: delivery.asked.policy_id === null ? null : String(delivery.asked.policy_id),
    version: delivery.asked.version,
    updatedAt: delivery.asked.updated_at,
  }
  return {
    objective: contract?.objective || card?.description || card?.title || 'No objective recorded.',
    deliverables: contractPromises(contract?.deliverables),
    criteria: contractPromises(contract?.acceptance_criteria),
    nonGoals: contractStrings(contract?.non_goals),
    risks: contractStrings(contract?.risks),
    verifyCommands: contractCommands(contract),
    dependencies: contractStrings(contract?.dependencies),
    baseRef: contract?.base_ref ?? null,
    budgetTokens: contract?.budget_tokens ?? null,
    budgetCents: contract?.budget_cents ?? null,
    priority: contract?.priority ?? 0,
    policyId: contract?.policy_id === null || contract?.policy_id === undefined ? null : String(contract.policy_id),
    version: contract?.version ?? null,
    updatedAt: contract?.updated_at ?? null,
  }
}

const outcomeKey = (item: DeliveryPromise, index: number) => item.id ? `id:${item.id}` : `index:${index}`

const deltaRows = (promises: DeliveryPromise[], results: DeliveryOutcome[]): DeltaRow[] => {
  const used = new Set<number>()
  const rows = promises.map((promised, index) => {
    const matchedIndex = promised.id
      ? results.findIndex((result, candidate) => !used.has(candidate) && result.id === promised.id)
      : results[index] && !used.has(index) ? index : -1
    if (matchedIndex >= 0) used.add(matchedIndex)
    return {
      key: outcomeKey(promised, index),
      promised,
      result: matchedIndex >= 0 ? results[matchedIndex] : null,
      extra: false,
    }
  })
  results.forEach((result, index) => {
    if (!used.has(index)) rows.push({ key: `extra:${result.id ?? index}`, promised: result, result, extra: true })
  })
  return rows
}

const hasObservedEvidence = (outcome: DeliveryOutcome | null) => Boolean(outcome?.evidence.length)

const deliveryHeadline = (delivery: DeliveryReport | null, rows: DeltaRow[]) => {
  if (!delivery) return 'No delivery has been submitted yet.'
  if (!rows.length) return 'Delivery submitted; no required outcomes are recorded.'
  const supported = (result: DeliveryOutcome | null) => Boolean(result?.override || (result
    && GOOD_STATUSES.has(result.status) && hasObservedEvidence(result) && result.gaps.length === 0))
  const verified = rows.filter(({ result }) => supported(result)).length
  const failed = rows.filter(({ result }) => result && !result.override && BAD_STATUSES.has(result.status)).length
  const needsEvidence = rows.filter(({ result }) => !result || (
    !supported(result) && !BAD_STATUSES.has(result.status)
    && (!hasObservedEvidence(result) || EVIDENCE_GAP_STATUSES.has(result.status) || result.gaps.length > 0)
  )).length
  const parts = [`Delivered ${verified} of ${rows.length} required outcome${rows.length === 1 ? '' : 's'}`]
  if (needsEvidence) parts.push(`${needsEvidence} need${needsEvidence === 1 ? 's' : ''} evidence`)
  if (failed) parts.push(`${failed} failed`)
  return `${parts.join('; ')}.`
}

export const deliveryEvidenceText = (value: DeliveryEvidence): string => {
  if (typeof value === 'string') return value
  const label = firstText(value, ['label', 'summary', 'detail', 'command', 'name', 'path', 'result'])
  const reference = firstText(value, ['ref', 'artifact_id', 'artifactId'])
  if (label && reference && label !== reference) return `${label} — ${reference}`
  return label ?? reference ?? 'Evidence reference'
}

const metadataText = (metadata: JsonObject): string => Object.entries(metadata).map(([key, value]) => {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  return `${key}: ${rendered}`
}).join(' · ')

const eventDetail = (event: OsEvent) => {
  const payload = parseJson<JsonObject>(event.payload, {})
  return firstText(payload, ['summary', 'detail', 'message', 'command', 'reason', 'result'])
}

const artifactTimelineItem = (artifact: Artifact): TimelineItem => ({
  id: `artifact:${artifact.id}`,
  kind: /test|verification/i.test(artifact.kind) ? 'test' : 'artifact',
  label: /test|verification/i.test(artifact.kind) ? 'Test evidence' : 'Artifact',
  title: artifact.name || artifact.kind,
  detail: artifact.path ?? artifact.mime_type,
  status: null,
  time: artifact.created_at,
  icon: /test|verification/i.test(artifact.kind) ? 'check' : 'evidence',
})

const evidenceTimeline = (bundle: EvidenceBundle | null): TimelineItem[] => {
  if (!bundle) return []
  const verification = bundle.verification && typeof bundle.verification === 'object'
    ? bundle.verification as { artifacts?: Artifact[]; events?: OsEvent[] } : {}
  const events = [
    ...(Array.isArray(verification.events) ? verification.events : []),
    ...(Array.isArray(bundle.events) ? bundle.events.filter((event) => /test|verify|review|ship/.test(event.kind)) : []),
  ]
  const artifacts = [
    ...(Array.isArray(bundle.artifacts) ? bundle.artifacts : []),
    ...(Array.isArray(verification.artifacts) ? verification.artifacts : []),
  ]
  const items: TimelineItem[] = events.map((event) => ({
    id: `event:${event.id}`,
    kind: /review/.test(event.kind) ? 'review' : /ship/.test(event.kind) ? 'shipped' : 'test',
    label: /review/.test(event.kind) ? 'Review' : /ship/.test(event.kind) ? 'Shipped record' : 'Test or verification',
    title: statusLabel(event.kind),
    detail: eventDetail(event),
    status: firstText(parseJson<JsonObject>(event.payload, {}), ['status', 'result', 'decision']),
    time: event.created_at,
    icon: /review/.test(event.kind) ? 'message' : /ship/.test(event.kind) ? 'branch' : 'check',
  }))
  const artifactItems = artifacts.map(artifactTimelineItem)
  const reviews = Array.isArray(bundle.reviews) ? bundle.reviews : []
  const reviewItems: TimelineItem[] = reviews.map((review, index) => ({
    id: `review:${String(review.id ?? index)}`,
    kind: 'review',
    label: 'Observed review',
    title: statusLabel(firstText(review, ['decision', 'status']) ?? 'reviewed'),
    detail: firstText(review, ['note', 'summary', 'detail']),
    status: firstText(review, ['decision', 'status']),
    time: firstText(review, ['decided_at', 'reviewed_at', 'created_at']),
    icon: 'message',
  }))
  if (bundle.review) {
    const review = recordValue(bundle.review)
    reviewItems.push({
      id: 'review:current', kind: 'review', label: 'Observed review',
      title: statusLabel(firstText(review, ['decision', 'status']) ?? 'reviewed'),
      detail: firstText(review, ['note', 'summary', 'detail']),
      status: firstText(review, ['decision', 'status']),
      time: firstText(review, ['decided_at', 'reviewed_at', 'created_at']), icon: 'message',
    })
  }
  const processItems: TimelineItem[] = (Array.isArray(bundle.process_exits) ? bundle.process_exits : []).map((process) => ({
    id: `process:${process.id}`,
    kind: 'process',
    label: 'Process exit',
    title: process.name || process.command,
    detail: process.command,
    status: process.exit_code === 0 ? 'passed' : process.exit_code === null ? process.status : `exit ${process.exit_code}`,
    time: process.ended_at,
    icon: 'process',
  }))
  const shippedItems: TimelineItem[] = (Array.isArray(bundle.shipped) ? bundle.shipped : []).map((record, index) => {
    const detail = recordValue(record.detail)
    return {
      id: `shipped:${index}`, kind: 'shipped', label: 'Shipped record',
      title: firstText(detail, ['hash', 'commit', 'summary']) ?? record.source ?? 'Recorded as shipped',
      detail: firstText(detail, ['detail', 'note']), status: 'shipped', time: record.created_at ?? null, icon: 'branch',
    }
  })
  if (bundle.shipped_commit) {
    shippedItems.push({
      id: `shipped:${bundle.shipped_commit}`, kind: 'shipped', label: 'Shipped commit',
      title: bundle.shipped_commit, detail: null, status: 'shipped', time: null, icon: 'branch',
    })
  }
  const unique = new Map<string, TimelineItem>()
  for (const item of [...items, ...artifactItems, ...reviewItems, ...processItems, ...shippedItems]) unique.set(item.id, item)
  return [...unique.values()].sort((a, b) => {
    const left = a.time ? new Date(a.time).getTime() : 0
    const right = b.time ? new Date(b.time).getTime() : 0
    return right - left
  })
}

const lifecycleTimes = (delivery: DeliveryReport) => ([
  ['Created', delivery.created_at, delivery.created_by],
  ['Submitted', delivery.submitted_at, delivery.submitted_by],
  ['Verified', delivery.verified_at, delivery.verified_by],
  ['Reviewed', delivery.reviewed_at, null],
  ['Accepted', delivery.accepted_at, delivery.accepted_by],
  ['Rejected', delivery.rejected_at, delivery.rejected_by],
  ['Shipped', delivery.shipped_at, null],
  ['Updated', delivery.updated_at, null],
] as Array<[string, string | null, string | null]>).filter((entry): entry is [string, string, string | null] => Boolean(entry[1]))

const actorLabel = (delivery: DeliveryReport) => {
  const lifecycleActor = delivery.status === 'rejected' ? delivery.rejected_by
    : delivery.status === 'accepted' ? delivery.accepted_by
      : delivery.status === 'verified' ? delivery.verified_by : delivery.submitted_by ?? delivery.created_by
  if (lifecycleActor) return lifecycleActor
  return [delivery.actor_type, delivery.actor_id === null ? null : String(delivery.actor_id)].filter(Boolean).join(' · ')
    || 'Actor not recorded'
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  return <span className={`os-trackbook-status ${statusTone(status)}`}>{statusLabel(status)}</span>
}

function PromiseList({ items, empty }: { items: DeliveryPromise[]; empty: string }) {
  if (!items.length) return <p className="os-trackbook-quiet">{empty}</p>
  return <ol className="os-trackbook-promises">{items.map((item, index) => {
    const metadata = metadataText(item.metadata)
    return <li key={item.id ?? index}><span>{index + 1}</span><p>{item.text}<small>{item.required ? 'Required' : 'Optional'}
      {item.deliverable_ids.length ? ` · Covers ${item.deliverable_ids.join(', ')}` : ''}</small>
      {metadata && <small className="os-trackbook-promise-meta">Metadata · {metadata}</small>}</p></li>
  })}</ol>
}

function TextList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="os-trackbook-quiet">{empty}</p>
  return <ul className="os-trackbook-text-list">{items.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}</ul>
}

function AskedMetadata({ asked }: { asked: TrackbookAsked }) {
  const hasContractMetadata = asked.version !== null || asked.updatedAt || asked.baseRef || asked.dependencies.length
    || asked.budgetTokens !== null || asked.budgetCents !== null || asked.policyId
  if (!hasContractMetadata) return null
  const facts: Array<[string, string | null]> = [
    ['Contract', asked.version === null ? null : `v${asked.version}`],
    ['Captured', asked.updatedAt ? normalizeTime(asked.updatedAt) : null],
    ['Base ref', asked.baseRef],
    ['Priority', String(asked.priority)],
    ['Token budget', asked.budgetTokens === null ? null : asked.budgetTokens.toLocaleString()],
    ['Cost budget', asked.budgetCents === null ? null : `$${(asked.budgetCents / 100).toFixed(2)}`],
    ['Policy', asked.policyId],
  ].filter((fact): fact is [string, string] => fact[1] !== null)
  return <div className="os-trackbook-block"><h5>Contract context</h5>
    <dl className="os-trackbook-asked-meta">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {asked.dependencies.length > 0 && <div className="os-trackbook-dependencies"><b>Dependencies</b><TextList items={asked.dependencies} empty="" /></div>}
  </div>
}

function AskedColumn({ asked }: { asked: TrackbookAsked }) {
  return (
    <section className="os-trackbook-column asked" aria-labelledby="trackbook-asked-title">
      <header><span>01</span><div><p className="os-eyebrow">Asked</p><h4 id="trackbook-asked-title">The promise</h4></div></header>
      <div className="os-trackbook-block emphasis"><h5>Objective</h5><p>{asked.objective}</p></div>
      <div className="os-trackbook-block"><h5>Deliverables</h5><PromiseList items={asked.deliverables} empty="No deliverables were captured in this revision." /></div>
      <div className="os-trackbook-block"><h5>Acceptance criteria</h5><PromiseList items={asked.criteria} empty="No acceptance criteria were captured." /></div>
      <div className="os-trackbook-split">
        <div className="os-trackbook-block"><h5>Non-goals</h5><TextList items={asked.nonGoals} empty="None recorded." /></div>
        <div className="os-trackbook-block"><h5>Risks</h5><TextList items={asked.risks} empty="None recorded." /></div>
      </div>
      {asked.verifyCommands.length > 0 && (
        <div className="os-trackbook-block"><h5>Verification requested</h5>{asked.verifyCommands.map((command) => (
          <code className="os-trackbook-command" key={command}>{command}</code>
         ))}</div>
      )}
      <AskedMetadata asked={asked} />
    </section>
  )
}

function DeliveredColumn({ delivery }: { delivery: DeliveryReport | null }) {
  const reviewNote = delivery?.rejection_reason ?? delivery?.acceptance_note ?? delivery?.human_summary ?? null
  const reviewLabel = delivery?.rejection_reason ? 'Rejection reason'
    : delivery?.acceptance_note ? 'Acceptance note' : 'Reviewer summary'
  const reviewActor = delivery?.rejection_reason ? delivery.rejected_by
    : delivery?.acceptance_note ? delivery.accepted_by : null
  return (
    <section className="os-trackbook-column delivered" aria-labelledby="trackbook-delivered-title">
      <header><span>02</span><div><p className="os-eyebrow">Delivered</p><h4 id="trackbook-delivered-title">The submitted result</h4></div></header>
      {!delivery ? (
        <div className="os-trackbook-pending"><OsIcon name="evidence" size={20} /><strong>Nothing submitted</strong><p>The request is visible, but there is no delivery report to compare yet.</p></div>
      ) : <>
        {reviewNote && <div className="os-trackbook-block human-summary"><h5>{reviewLabel}</h5><p>{reviewNote}</p>
          {reviewActor && <small>Recorded by {reviewActor}</small>}</div>}
        <div className="os-trackbook-block"><h5>Submitted summary</h5><p>{delivery.summary || 'No summary was supplied.'}</p></div>
        <div className="os-trackbook-block"><h5>Reported items</h5>
          {delivery.delivered_items.length ? <ul className="os-trackbook-delivered-list">{delivery.delivered_items.map((item, index) => (
            <li key={item.id ?? index}><div><p>{item.text}</p><StatusBadge status={item.status} /></div>
              {!hasObservedEvidence(item) && <small>Reported by the delivery; supporting evidence is still required.</small>}</li>
          ))}</ul> : <p className="os-trackbook-quiet">No delivered items were itemized.</p>}
        </div>
        <div className="os-trackbook-output-grid">
          <div className="os-trackbook-block"><h5>Changed files</h5><TextList items={delivery.changed_files} empty="No files reported." /></div>
          <div className="os-trackbook-block"><h5>Commits</h5>{delivery.commits.length
            ? <ul className="os-trackbook-code-list">{delivery.commits.map((commit) => <li key={commit}><code>{commit}</code></li>)}</ul>
            : <p className="os-trackbook-quiet">No commits reported.</p>}</div>
          <div className="os-trackbook-block"><h5>Artifacts</h5><TextList items={delivery.artifact_ids.map(String)} empty="No artifacts linked." /></div>
        </div>
        {delivery.claims.length > 0 && (
          <aside className="os-trackbook-claims" aria-label="Agent claims, not observed evidence">
            <header><OsIcon name="message" size={14} /><strong>Agent claims</strong><span>Not observed evidence</span></header>
            {delivery.claims.map((claim, index) => <blockquote key={`${claim.text}:${index}`}><p>{claim.text}</p>
              <footer>{claim.source ?? 'Unattributed agent'}{claim.created_at ? ` · ${normalizeTime(claim.created_at)}` : ''}</footer></blockquote>)}
          </aside>
        )}
        {delivery.gaps.length > 0 && <aside className="os-trackbook-gaps"><h5><OsIcon name="attention" size={13} /> Declared gaps</h5><TextList items={delivery.gaps} empty="" /></aside>}
      </>}
    </section>
  )
}

function DeltaResult({ row }: { row: DeltaRow }) {
  const result = row.result
  const status = result?.status ?? 'missing'
  return (
    <article className={`os-trackbook-delta-row ${statusTone(status)}`}>
      <header>
        <div><span>{row.extra ? 'Additional output' : `${row.promised.required ? 'Required' : 'Optional'} outcome`}</span><h5>{row.promised.text}</h5></div>
        <StatusBadge status={status} />
      </header>
      {!result && <p className="os-trackbook-missing"><OsIcon name="attention" size={13} /> No result was submitted for this promise.</p>}
      {result && <>
        {result.text !== row.promised.text && <p className="os-trackbook-result-text"><b>Reported result</b>{result.text}</p>}
        {result.note && <p className="os-trackbook-result-text"><b>Verifier note</b>{result.note}</p>}
        {(result.actor || result.updated_at) && <p className="os-trackbook-result-audit"><b>Recorded by</b>
          {result.actor ?? 'Actor not recorded'}{result.updated_at ? ` · ${normalizeTime(result.updated_at)}` : ''}</p>}
        {result.evidence.length > 0 ? (
          <div className="os-trackbook-evidence-links"><span><OsIcon name="check" size={12} /> Linked evidence</span><ul>{result.evidence.map((item, index) => (
            <li key={`${deliveryEvidenceText(item)}:${index}`}>{deliveryEvidenceText(item)}</li>
          ))}</ul></div>
        ) : <p className="os-trackbook-missing"><OsIcon name="attention" size={13} /> No observed evidence is linked.</p>}
        {(result.claim || (!hasObservedEvidence(result) && result.text)) && (
          <p className="os-trackbook-claim-line"><b>Agent claim · not evidence</b>{result.claim ?? result.text}</p>
        )}
        {result.gaps.length > 0 && <div className="os-trackbook-row-gaps"><b>Gaps</b><TextList items={result.gaps} empty="" /></div>}
        {result.override && <div className="os-trackbook-override"><b>Human override</b><p>{result.override.reason ?? 'No reason recorded.'}</p>
          <small>{result.override.actor ?? 'Actor not recorded'}{result.override.created_at ? ` · ${normalizeTime(result.override.created_at)}` : ''}</small></div>}
      </>}
    </article>
  )
}

function DeltaSection({ deliverables, criteria }: { deliverables: DeltaRow[]; criteria: DeltaRow[] }) {
  return (
    <section className="os-trackbook-delta" aria-labelledby="trackbook-delta-title">
      <header><span>03</span><div><p className="os-eyebrow">Delta</p><h4 id="trackbook-delta-title">What the evidence supports</h4><p>Statuses are written out; color is only a secondary cue.</p></div></header>
      <div className="os-trackbook-delta-group"><h5>Deliverables</h5>{deliverables.length
        ? deliverables.map((row) => <DeltaResult key={row.key} row={row} />)
        : <p className="os-trackbook-quiet">No promised deliverables were available to compare.</p>}</div>
      <div className="os-trackbook-delta-group"><h5>Acceptance criteria</h5>{criteria.length
        ? criteria.map((row) => <DeltaResult key={row.key} row={row} />)
        : <p className="os-trackbook-quiet">No acceptance criteria were available to compare.</p>}</div>
    </section>
  )
}

function EvidenceTimeline({ timeline, state, historical }: {
  timeline: TimelineItem[]
  state: Resource<EvidenceBundle | null>
  historical: boolean
}) {
  return (
    <section className="os-trackbook-timeline" aria-labelledby="trackbook-timeline-title">
      <header><div><p className="os-eyebrow">Observed record</p><h4 id="trackbook-timeline-title">Evidence timeline</h4></div><span>{timeline.length} record{timeline.length === 1 ? '' : 's'}</span></header>
      <p className="os-trackbook-section-note">{historical
        ? 'Only evidence explicitly linked in the Delta above belongs to this historical revision.'
        : 'Runtime exits, tests, reviews, artifacts, and shipped records are current card evidence. Agent claims stay separate.'}</p>
      {!historical && state.status === 'loading' && !state.data && <PaneSkeleton />}
      {!historical && state.status === 'error' && <div className="os-trackbook-stale" role="status"><OsIcon name="attention" size={13} /> Evidence may be stale: {state.error}</div>}
      {timeline.length ? <ol>{timeline.map((item) => (
        <li key={item.id}>
          <span className={`os-trackbook-timeline-icon ${item.kind}`}><OsIcon name={item.icon} size={13} /></span>
          <div><header><span>{item.label}</span>{item.time && <time dateTime={item.time}>{normalizeTime(item.time)}</time>}</header>
            <h5>{item.title}</h5>{item.detail && <p>{item.detail}</p>}{item.status && <StatusBadge status={item.status} />}</div>
        </li>
      ))}</ol> : <div className="os-trackbook-timeline-empty"><OsIcon name="evidence" size={18} /><p>{historical
        ? 'A revision-specific timeline is unavailable. Later-revision evidence is intentionally hidden; use the linked evidence in Delta.'
        : 'No observed evidence has been recorded yet.'}</p></div>}
    </section>
  )
}

function RevisionHistory({ deliveries, selectedId, currentId, onSelect }: {
  deliveries: DeliveryReport[]
  selectedId: string | null
  currentId: string | null
  onSelect: (delivery: DeliveryReport) => void
}) {
  return (
    <section className="os-trackbook-revisions" aria-labelledby="trackbook-revisions-title">
      <header><div><p className="os-eyebrow">Audit trail</p><h4 id="trackbook-revisions-title">Revision history</h4></div><span>{deliveries.length}</span></header>
      <ol>{deliveries.map((delivery) => {
        const selected = String(delivery.id) === selectedId
        const current = String(delivery.id) === currentId
        const time = delivery.submitted_at ?? delivery.created_at
        return <li key={String(delivery.id)}><button type="button" aria-pressed={selected} className={selected ? 'active' : ''} onClick={() => onSelect(delivery)}>
          <span className="os-trackbook-revision-index">{delivery.sequence || '—'}</span>
          <div><strong>Revision {delivery.sequence || 'unversioned'}{current ? ' · Current' : ''}</strong><small>{actorLabel(delivery)} · {normalizeTime(time)}</small></div>
          <StatusBadge status={delivery.status} />
        </button></li>
      })}</ol>
    </section>
  )
}

export function TrackbookPane({ deliveries, evidence, contract, card, boardId }: {
  deliveries: Resource<DeliveryCollection>
  evidence: Resource<EvidenceBundle | null>
  contract: Resource<TaskContract | null>
  card: Card | undefined
  boardId: number
}) {
  const currentId = deliveries.data.current ? String(deliveries.data.current.id) : null
  const [selectedId, setSelectedId] = useState<string | null>(currentId)
  const [filter, setFilter] = useState<DeliveryListFilter>('all')
  const [jobDetail, setJobDetail] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error'
    data: JobDeliveryDetailModel | null
    error: string | null
  }>({ status: 'idle', data: null, error: null })
  useEffect(() => { setSelectedId(currentId) }, [card?.id, currentId])
  const selected = deliveries.data.deliveries.find((delivery) => String(delivery.id) === selectedId)
    ?? deliveries.data.current ?? deliveries.data.deliveries[0] ?? null
  const asked = useMemo(() => askedFor(selected, contract.data, card), [selected, contract.data, card])
  const deliverableRows = useMemo(() => deltaRows(asked.deliverables, selected?.deliverable_results ?? []), [asked.deliverables, selected?.deliverable_results])
  const criterionRows = useMemo(() => deltaRows(asked.criteria, selected?.criterion_results ?? []), [asked.criteria, selected?.criterion_results])
  const comparisonRows = [...deliverableRows, ...criterionRows].filter((row) => row.promised.required)
  const headline = deliveryHeadline(selected, comparisonRows)
  const viewingHistorical = Boolean(selected && currentId && String(selected.id) !== currentId)
  const timeline = useMemo(() => viewingHistorical ? [] : evidenceTimeline(evidence.data), [evidence.data, viewingHistorical])
  const hasDeliveryData = deliveries.data.deliveries.length > 0 || deliveries.data.current !== null
  const isInitialLoading = ['idle', 'loading'].includes(deliveries.status) && !hasDeliveryData
  const isHardError = deliveries.status === 'error' && !hasDeliveryData
  useEffect(() => {
    if (selected?.job_id === null || selected?.job_id === undefined) {
      setJobDetail({ status: 'idle', data: null, error: null })
      return
    }
    let active = true
    setJobDetail((previous) => ({ status: 'loading', data: previous.data, error: null }))
    osApi.getJobDeliveryDetail(selected.job_id).then((data) => {
      if (active) setJobDetail({ status: 'ready', data, error: null })
    }, (error: unknown) => {
      if (active) setJobDetail({ status: 'error', data: null,
        error: error instanceof Error ? error.message : 'Job delivery detail could not load.' })
    })
    return () => { active = false }
  }, [selected?.job_id])
  const matchesFilter = (delivery: DeliveryReport, candidate: DeliveryListFilter) => candidate === 'all'
    || (candidate === 'awaiting_review' && ['submitted', 'verified'].includes(delivery.status))
    || (candidate === 'evidence_gaps' && (delivery.gaps.length > 0
      || [...delivery.deliverable_results, ...delivery.criterion_results]
        .some((result) => EVIDENCE_GAP_STATUSES.has(result.status))))
    || (candidate === 'rejected' && delivery.status === 'rejected')
    || (candidate === 'overridden' && [...delivery.deliverable_results, ...delivery.criterion_results]
      .some((result) => result.override !== null))
    || (candidate === 'shipped' && delivery.status === 'shipped')
  const filteredDeliveries = deliveries.data.deliveries.filter((delivery) => matchesFilter(delivery, filter))
  const filterCounts = Object.fromEntries((['all', 'awaiting_review', 'evidence_gaps', 'rejected', 'overridden', 'shipped'] as DeliveryListFilter[])
    .map((candidate) => [candidate,
      deliveries.data.deliveries.filter((delivery) => matchesFilter(delivery, candidate)).length]))

  return (
    <PaneFrame title="Trackbook" eyebrow={card ? `Task ${card.id} · Asked versus delivered` : 'Unlinked workspace'}
      action={selected && <StatusBadge status={selected.status} />}>
      <div className="os-trackbook" aria-busy={deliveries.status === 'loading'}>
        {isInitialLoading && <div className="os-trackbook-loading"><PaneSkeleton /><PaneSkeleton /></div>}
        {isHardError && <div className="os-pane-error" role="alert"><OsIcon name="attention" /><strong>Trackbook could not load</strong><span>{deliveries.error}</span></div>}
        {!isInitialLoading && !isHardError && <>
          {deliveries.status === 'error' && hasDeliveryData && (
            <div className="os-trackbook-stale" role="status"><OsIcon name="refresh" size={13} /> Showing the last loaded Trackbook. Refresh failed: {deliveries.error}</div>
          )}
          {contract.status === 'error' && <div className="os-trackbook-stale" role="status"><OsIcon name="attention" size={13} /> Request details may be stale: {contract.error}</div>}
          <section className="os-trackbook-hero" aria-live="polite">
            <div><p className="os-eyebrow">Delivery health</p><h3>{headline}</h3></div>
            {selected ? <dl>
              <div><dt>Revision</dt><dd>{selected.sequence || 'Unversioned'}</dd></div>
              <div><dt>Latest actor</dt><dd>{actorLabel(selected)}</dd></div>
              <div><dt>Parent</dt><dd>{selected.parent_delivery_id ?? 'First submission'}</dd></div>
            </dl> : <p>Waiting for the first submitted result.</p>}
          </section>

          <DeliveryTrackbookFilterBar value={filter} onChange={setFilter} counts={filterCounts} />

          {selected && <div className="os-trackbook-lifecycle" aria-label="Delivery lifecycle timestamps">{lifecycleTimes(selected).map(([label, time, actor]) => (
            <span key={label}><b>{label}</b><time dateTime={time}>{normalizeTime(time)}</time>{actor && <small>by {actor}</small>}</span>
          ))}</div>}

          <div className="os-trackbook-comparison">
            <AskedColumn asked={asked} />
            <DeliveredColumn delivery={selected} />
          </div>
          <DeltaSection deliverables={deliverableRows} criteria={criterionRows} />
          <EvidenceTimeline timeline={timeline} state={evidence} historical={viewingHistorical} />
          {jobDetail.status === 'loading' && !jobDetail.data && <div className="os-trackbook-loading"><PaneSkeleton /></div>}
          {jobDetail.status === 'error' && <div className="os-pane-error" role="alert"><OsIcon name="attention" />
            <strong>Exact job evidence could not load</strong><span>{jobDetail.error}</span></div>}
          {jobDetail.data && <JobDeliveryDetail detail={jobDetail.data} />}
          {card && selected?.job_id && <JobDetailDiscussions boardId={boardId}
            linkType="job" linkTarget={String(selected.job_id)} />}
          {filteredDeliveries.length > 0 && (
            <RevisionHistory deliveries={filteredDeliveries} selectedId={selected ? String(selected.id) : null}
              currentId={currentId} onSelect={(delivery) => setSelectedId(String(delivery.id))} />
          )}
        </>}
      </div>
    </PaneFrame>
  )
}
