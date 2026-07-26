import React from 'react'
import type {
  CanonicalLifecycleRecord,
  DeliveryReport,
  Job,
  JsonObject,
  OsEvent,
  OsId,
  Workspace,
} from './osApi'
import { parseJson } from './osApi'

export type CanonicalLifecycleView = {
  lifecycle: 'canonical' | 'ambient'
  workspace: Workspace
  job: Job | null
  sessionId: OsId | null
  contractId: OsId | null
  dispatchEvent: OsEvent | null
  missing: Array<'job' | 'session' | 'contract' | 'dispatch_event'>
}

const sameId = (left: OsId | null | undefined, right: OsId | null | undefined) =>
  left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right)

const eventJobId = (event: OsEvent): OsId | null => {
  if (event.job_id !== undefined) return event.job_id
  const payload = parseJson<JsonObject>(event.payload, {})
  const value = payload.job_id ?? payload.jobId
  return value === null || value === undefined || value === '' ? null : value as OsId
}

const dispatchKinds = new Set([
  'job.queued', 'job.started', 'job.retry_queued', 'job.succeeded', 'job.blocked', 'job.cancelled',
])

/** Join only exact persisted identifiers; never infer a session from card ownership or provider state. */
export function canonicalLifecycleForWorkspace(input: {
  workspace: Workspace
  jobs: Job[]
  delivery: DeliveryReport | null
  events: OsEvent[]
  exact?: CanonicalLifecycleRecord | null
}): CanonicalLifecycleView {
  const { workspace, jobs, events } = input
  if (input.exact && sameId(input.exact.workspace.id, workspace.id)) {
    const dispatchEvent = input.exact.events
      .filter((event) => dispatchKinds.has(event.kind) && sameId(eventJobId(event), input.exact?.job.id))
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())[0] ?? null
    const missing: CanonicalLifecycleView['missing'] = []
    if (dispatchEvent === null) missing.push('dispatch_event')
    return {
      lifecycle: 'canonical',
      workspace,
      job: input.exact.job,
      sessionId: input.exact.session.id,
      contractId: input.exact.orchestration.contract_id ?? input.exact.delivery.contract_id,
      dispatchEvent,
      missing,
    }
  }
  const scopedDelivery = input.delivery
    && sameId(input.delivery.workspace_id, workspace.id)
    ? input.delivery : null
  if (!scopedDelivery) {
    return {
      lifecycle: 'ambient',
      workspace,
      job: null,
      sessionId: null,
      contractId: null,
      dispatchEvent: null,
      missing: ['job'],
    }
  }
  const deliveryJob = scopedDelivery?.job_id === null || scopedDelivery?.job_id === undefined
    ? null : jobs.find((job) => sameId(job.id, scopedDelivery.job_id) && sameId(job.workspace_id, workspace.id)) ?? null
  const job = deliveryJob
  const sessionId = job && scopedDelivery && sameId(scopedDelivery.job_id, job.id)
    ? scopedDelivery.session_id : null
  const contractId = job && scopedDelivery && sameId(scopedDelivery.job_id, job.id)
    ? scopedDelivery.contract_id : null
  const dispatchEvent = job
    ? events
      .filter((event) => dispatchKinds.has(event.kind) && sameId(eventJobId(event), job.id))
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())[0] ?? null
    : null
  if (!job) {
    return {
      lifecycle: 'canonical',
      workspace,
      job: null,
      sessionId: null,
      contractId: null,
      dispatchEvent: null,
      missing: ['job'],
    }
  }
  const missing: CanonicalLifecycleView['missing'] = []
  if (sessionId === null) missing.push('session')
  if (contractId === null) missing.push('contract')
  if (dispatchEvent === null) missing.push('dispatch_event')
  return { lifecycle: 'canonical', workspace, job, sessionId, contractId, dispatchEvent, missing }
}

const compactId = (value: OsId) => {
  const text = String(value)
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text
}

export function CanonicalLifecycleStatus({ view }: { view: CanonicalLifecycleView }) {
  if (!view.job) {
    return (
      <div className="os-workspace-paths" aria-label="Canonical lifecycle">
        <span title={view.lifecycle === 'canonical'
          ? 'Canonical records exist, but no exact job link is available.'
          : 'This workspace is not linked to a canonical managed job.'}>
          <b>Lifecycle</b> {view.lifecycle === 'canonical' ? 'link incomplete' : 'ambient'}
        </span>
        <span><b>Workspace</b> <code>{compactId(view.workspace.id)}</code></span>
      </div>
    )
  }
  return (
    <div className="os-workspace-paths" aria-label="Canonical lifecycle">
      <span title={String(view.job.id)}><b>Job</b> <code>{compactId(view.job.id)}</code> · {view.job.status}</span>
      <span title={String(view.workspace.id)}><b>Workspace</b> <code>{compactId(view.workspace.id)}</code></span>
      <span title={view.sessionId === null ? 'No exact session link is persisted for this lifecycle.' : String(view.sessionId)}>
        <b>Session</b> {view.sessionId === null ? 'not linked' : <code>{compactId(view.sessionId)}</code>}
      </span>
      <span title={view.dispatchEvent?.id === undefined ? 'No causal dispatch event is persisted.' : String(view.dispatchEvent.id)}>
        <b>Dispatch</b> {view.dispatchEvent?.kind ?? 'not recorded'}
      </span>
    </div>
  )
}
