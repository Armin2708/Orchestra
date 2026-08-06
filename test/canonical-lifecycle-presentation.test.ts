import { describe, expect, it } from 'vitest'
import {
  normalizeCanonicalLifecycleRecord,
  normalizeCanonicalLifecycleResponse,
  type CanonicalLifecycleRecord,
  type DeliveryReport,
  type Job,
  type OsEvent,
  type Workspace,
} from '../web/src/osApi.js'

const workspace = (id = 'workspace-1'): Workspace => ({
  id, board_id: 1, card_id: 7, name: 'Managed worktree', kind: 'worktree', root_path: '/repo',
  worktree_path: '/repo-card-7', branch: 'card-7', base_ref: 'main', status: 'running',
  created_at: '2026-07-22T10:00:00Z', updated_at: '2026-07-22T10:00:01Z',
})

const job = (id: string, workspaceId: string): Job => ({
  id, board_id: 1, card_id: 7, workspace_id: workspaceId, provider: 'codex', model: 'gpt-5',
  priority: 4, status: 'running', attempts: 1, max_attempts: 1, budget_tokens: null,
  budget_cents: null, scheduled_at: '2026-07-22T10:00:00Z', started_at: '2026-07-22T10:00:01Z',
  finished_at: null, error: null,
})

const delivery = (overrides: Partial<DeliveryReport> = {}): DeliveryReport => ({
  id: 'delivery-1', lineage_id: 'delivery-1', card_id: 7, contract_id: 'contract-1', job_id: 'job-1',
  session_id: 'session-1', workspace_id: 'workspace-1', status: 'draft',
  asked: {
    objective: 'Ship one canonical lifecycle', deliverables: [], acceptance_criteria: [], non_goals: [],
    risks: [], verify_commands: [], dependencies: [], base_ref: 'main', budget_tokens: null,
    budget_cents: null, priority: 4, policy_id: null, version: 1, updated_at: '2026-07-22T10:00:00Z',
  },
  summary: '', human_summary: null, delivered_items: [], deliverable_results: [], criterion_results: [],
  changed_files: [], commits: [], artifact_ids: [], claims: [], gaps: [], parent_delivery_id: null,
  sequence: 1, actor_type: null, actor_id: null, created_by: null, submitted_by: null,
  verified_by: null, accepted_by: null, rejected_by: null, acceptance_note: null, rejection_reason: null,
  created_at: '2026-07-22T10:00:00Z', updated_at: '2026-07-22T10:00:00Z', submitted_at: null,
  verified_at: null, reviewed_at: null, accepted_at: null, rejected_at: null, shipped_at: null,
  ...overrides,
})

const event = (id: string, jobId: string, kind: string, at: string): OsEvent => ({
  id, board_id: 1, workspace_id: 'workspace-1', card_id: 7, session_id: null, process_id: null,
  job_id: jobId, kind, source: 'scheduler', payload: { job_id: jobId }, created_at: at,
})

const canonicalEnvelope = () => ({
  mode: 'canonical',
  orchestration: {
    lifecycle: 'canonical', contract_attached: true, job_id: 'job-1', workspace_id: 'workspace-1',
    session_id: 'session-1', contract_id: 'card:7:v3', contract_version: 3,
    assignment_id: 'workspace-assignment-1',
    workspace_assignment_id: 'workspace-assignment-1',
    correlation_id: 'correlation-1', idempotency_key: 'launch-card-7',
  },
  contract: {
    card_id: 7, objective: 'Ship', deliverables: [], acceptance_criteria: [], dependencies: [],
    verify_commands: [], non_goals: [], risks: [], workspace_id: 'workspace-1', version: 3,
  },
  delivery: {
    id: 'delivery-1', card_id: 7, contract_id: 'card:7:v3', job_id: 'job-1',
    workspace_id: 'workspace-1', session_id: 'session-1', status: 'draft',
    asked: {
      objective: 'Ship', deliverables: [], acceptance_criteria: [], dependencies: [],
      verify_commands: [], non_goals: [], risks: [], contract_version: 3,
    },
  },
  job: {
    id: 'job-1', board_id: 1, card_id: 7, workspace_id: 'workspace-1', provider: 'codex',
    driver_id: 'codex', model: 'gpt-5', effort: 'high', access_profile: 'workspace_write',
    contract_version: 3, idempotency_key: 'launch-card-7', priority: 4, status: 'running',
    attempts: 1, max_attempts: 2, budget_tokens: 10_000, budget_cents: 300,
    spent_tokens: 120, spent_cents: 4, scheduled_at: '2026-07-22T10:00:00Z',
  },
  workspace: {
    id: 'workspace-1', board_id: 1, card_id: 7, name: 'card-7', kind: 'worktree', root_path: '/repo',
    worktree_path: '/repo-card-7', branch: 'card-7', base_ref: 'main', status: 'running',
  },
  session: {
    id: 'session-1', workspace_id: 'workspace-1', provider: 'codex', model: 'gpt-5', status: 'running',
    workspace_assignment_id: 'workspace-assignment-1',
    context_json: JSON.stringify({ job_id: 'job-1', correlation_id: 'correlation-1' }),
  },
  dispatch: { started: ['job-1'], completed: [], blocked: [], deferred: [] },
  dispatch_error: null,
})

describe('canonical lifecycle presentation', () => {
  it('normalizes the shared Board/API/CLI canonical envelope without dropping runtime truth', () => {
    const normalized = normalizeCanonicalLifecycleResponse(canonicalEnvelope())

    expect(normalized.orchestration).toMatchObject({
      lifecycle: 'canonical', contract_attached: true, job_id: 'job-1', workspace_id: 'workspace-1',
      session_id: 'session-1', contract_version: 3, idempotency_key: 'launch-card-7',
    })
    expect(normalized.job).toMatchObject({
      id: 'job-1', driver_id: 'codex', effort: 'high', access_profile: 'workspace_write',
      contract_version: 3, spent_tokens: 120,
    })
    expect(normalized.session.context).toEqual({ job_id: 'job-1', correlation_id: 'correlation-1' })
    expect(normalized.dispatch.started).toEqual(['job-1'])
  })

  it('normalizes one job-keyed lifecycle and uses only its exact causal events', () => {
    const record = {
      ...canonicalEnvelope(),
      dispatch: undefined,
      dispatch_error: undefined,
      events: [{
        id: 'event-1', board_id: 1, workspace_id: 'workspace-1', card_id: 7,
        session_id: 'session-1', process_id: null, job_id: 'job-1', contract_id: 'card:7:v3',
        correlation_id: 'correlation-1', causation_id: null, idempotency_key: 'job:job-1:queued',
        event_version: 1, kind: 'job.queued', source: 'orchestration', payload: { job_id: 'job-1' },
        created_at: '2026-07-22T10:00:00Z',
      }],
    }
    const normalized = normalizeCanonicalLifecycleRecord(record)
    const wrongSession = structuredClone(record)
    wrongSession.events[0].session_id = 'another-session'
    expect(() => normalizeCanonicalLifecycleRecord(wrongSession)).toThrow(/event.session_id does not match/)
    const wrongCorrelation = structuredClone(record)
    wrongCorrelation.events[0].correlation_id = 'another-correlation'
    expect(() => normalizeCanonicalLifecycleRecord(wrongCorrelation)).toThrow(/event.correlation_id does not match/)
    expect(normalized.orchestration.job_id).toBe('job-1')
    expect(normalized.events?.[0]).toMatchObject({ id: 'event-1', kind: 'job.queued' })
  })

  it('rejects partial, mismatched, or compatibility envelopes instead of inventing canonical links', () => {
    expect(() => normalizeCanonicalLifecycleResponse({ mode: 'canonical' })).toThrow(/missing orchestration/)
    expect(() => normalizeCanonicalLifecycleResponse({ mode: 'legacy' })).toThrow(/mode is not canonical/)
    expect(() => normalizeCanonicalLifecycleResponse({
      mode: 'canonical', orchestration: { lifecycle: 'canonical' },
    })).toThrow(/contract_attached must be true/)

    const detached = canonicalEnvelope()
    detached.orchestration.contract_attached = false
    expect(() => normalizeCanonicalLifecycleResponse(detached)).toThrow(/contract_attached must be true/)

    const mismatched = canonicalEnvelope()
    mismatched.delivery.job_id = 'another-job'
    expect(() => normalizeCanonicalLifecycleResponse(mismatched)).toThrow(/delivery.job_id does not match/)

    const invalidAccess = canonicalEnvelope()
    invalidAccess.job.access_profile = 'unrestricted'
    expect(() => normalizeCanonicalLifecycleResponse(invalidAccess)).toThrow(/access_profile is invalid/)

    const incompleteDispatch = canonicalEnvelope()
    incompleteDispatch.dispatch = { started: [], completed: [], blocked: [] } as typeof incompleteDispatch.dispatch
    expect(() => normalizeCanonicalLifecycleResponse(incompleteDispatch)).toThrow(/dispatch.deferred must be an array/)
  })
})
