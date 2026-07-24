import { describe, expect, it } from 'vitest'
import type {
  AgentConversation,
  AgentHomeCapabilities,
  AgentHomeSnapshot,
  AgentProfile,
  AgentSessionRecord,
  ConversationEvent,
} from '../web/src/agentHomeApi.js'
import {
  agentHomeDeepLink,
  capabilityFor,
  chooseConversation,
  chooseProcess,
  chooseProfile,
  chooseSession,
  eventText,
  parseAgentHomeSelection,
  usageSummary,
} from '../web/src/agentHomePresentation.js'
import type { WorkspaceProcess } from '../web/src/osApi.js'

const profile = (id: string, status: 'active' | 'archived' = 'active') => ({
  id,
  board_id: 1,
  legacy_agent_id: null,
  name: `Agent ${id}`,
  role: null,
  default_provider: 'codex',
  default_model: null,
  default_effort: null,
  default_access_profile: 'workspace_write',
  capabilities: [],
  owner_actor_type: 'operator',
  owner_actor_id: 'test',
  status,
  provenance: {},
  created_at: '2026-07-24T10:00:00Z',
  updated_at: '2026-07-24T10:00:00Z',
  archived_at: status === 'archived' ? '2026-07-24T11:00:00Z' : null,
}) satisfies AgentProfile

const conversation = (id: string, isDefault = false) => ({
  id,
  board_id: 1,
  profile_id: 'p1',
  title: `Conversation ${id}`,
  status: 'active',
  is_default: isDefault,
  next_sequence: 1,
  created_by_actor_type: 'operator',
  created_by_actor_id: 'test',
  created_at: '2026-07-24T10:00:00Z',
  updated_at: '2026-07-24T10:00:00Z',
  archived_at: null,
}) satisfies AgentConversation

const session = (id: string, conversationId: string, status = 'running') => ({
  id,
  workspace_id: `w-${id}`,
  agent_id: null,
  provider: 'codex',
  external_id: null,
  model: 'gpt-5',
  status,
  context: {},
  profile_id: 'p1',
  conversation_id: conversationId,
  job_id: null,
  mode: 'managed',
  driver_id: 'codex',
  effort: 'high',
  access_profile: 'workspace_write',
  provider_thread_id: null,
  provider_cursor: null,
  recovery_state: 'recoverable',
  recovery: {},
  history_state: 'complete',
  started_at: '2026-07-24T10:00:00Z',
  ended_at: null,
  archived_at: null,
  created_at: '2026-07-24T10:00:00Z',
  updated_at: '2026-07-24T10:00:00Z',
}) satisfies AgentSessionRecord

const home = (): AgentHomeSnapshot => {
  const defaultConversation = conversation('c-default', true)
  const activeSession = session('s-active', defaultConversation.id)
  return {
    profile: profile('p1'),
    conversations: [defaultConversation, conversation('c-other')],
    sessions: [session('s-old', 'c-other', 'stopped'), activeSession],
    active_session: activeSession,
    active_scope: { workspace: null, job: null, processes: [], attention: [] },
  }
}

const event = (overrides: Partial<ConversationEvent> = {}): ConversationEvent => ({
  id: 'event-1',
  board_id: 1,
  profile_id: 'p1',
  conversation_id: 'c-default',
  session_id: 's-active',
  sequence: 1,
  provider: 'codex',
  provider_event_id: null,
  provider_thread_id: null,
  provider_turn_id: null,
  provider_item_id: null,
  provider_cursor: null,
  kind: 'assistant',
  actor_type: 'agent',
  actor_id: 'p1',
  correlation_id: null,
  causation_id: null,
  projected_text: 'Delivered safely',
  metadata: {},
  raw_artifact_id: null,
  dedupe_key: 'dedupe-1',
  content_hash: 'hash-1',
  redaction_state: 'none',
  retention_class: 'transcript',
  schema_version: 1,
  created_at: '2026-07-24T10:00:00Z',
  archived_at: null,
  ...overrides,
})

describe('Agent Home selection and provenance presentation', () => {
  it('honors exact deep-link selection before saved and fallback identity', () => {
    const profiles = [profile('saved'), profile('requested'), profile('archived', 'archived')]
    expect(chooseProfile(profiles, 'requested', 'saved')?.id).toBe('requested')
    expect(chooseProfile(profiles, 'missing', 'saved')?.id).toBe('saved')
    expect(chooseProfile([profile('archived', 'archived'), profile('active')], null, null)?.id).toBe('active')
  })

  it('binds a requested session and its conversation without borrowing another thread', () => {
    const snapshot = home()
    const requested = chooseSession(snapshot, 's-old')
    expect(requested?.id).toBe('s-old')
    expect(chooseConversation(snapshot, requested, null)?.id).toBe('c-other')
    expect(chooseSession(snapshot, null)?.id).toBe('s-active')
    expect(chooseConversation(snapshot, snapshot.active_session, null)?.id).toBe('c-default')
  })

  it('selects an exact process, then a running process, then a stable fallback', () => {
    const processes = [
      { id: 'p-stopped', status: 'stopped' },
      { id: 'p-running', status: 'running' },
    ] as WorkspaceProcess[]
    expect(chooseProcess(processes, 'p-stopped')?.id).toBe('p-stopped')
    expect(chooseProcess(processes, null)?.id).toBe('p-running')
    expect(chooseProcess([{ id: 'only', status: 'exited' } as WorkspaceProcess], null)?.id).toBe('only')
  })

  it('round-trips exact Agent Home deep-link identifiers without dropping unrelated query state', () => {
    const url = agentHomeDeepLink('?card=9&debug=1', {
      boardId: 4,
      profileId: 'agent-1',
      conversationId: 'conversation-2',
      sessionId: 'session-3',
      jobId: 'job-4',
      workspaceId: 'workspace-5',
      processId: 'process-6',
    }, { pathname: '/board', hash: '#inspect' })
    expect(url).toBe('/board?card=9&debug=1&board=4&agent=agent-1&conversation=conversation-2&session=session-3&job=job-4&workspace=workspace-5&process=process-6#inspect')
    expect(parseAgentHomeSelection(url.split('?')[1].split('#')[0])).toEqual({
      profileId: 'agent-1',
      conversationId: 'conversation-2',
      sessionId: 'session-3',
      processId: 'process-6',
    })
  })

  it('fails closed when lifecycle capability sidecars are unavailable', () => {
    expect(capabilityFor(null, 'pause')).toMatchObject({
      supported: false,
      allowed: false,
    })
    const capabilities: AgentHomeCapabilities = {
      provider: 'codex',
      actions: {
        resume: { supported: false, allowed: true, requires_operator: true, reason: 'Already running.' },
        pause: { supported: true, allowed: true, requires_operator: true, reason: null },
        stop: { supported: true, allowed: true, requires_operator: true, reason: null },
        retry: { supported: false, allowed: true, requires_operator: true, reason: 'Still running.' },
        fork: { supported: true, allowed: true, requires_operator: true, reason: null },
        rename: { supported: true, allowed: true, requires_operator: true, reason: null },
        archive: { supported: false, allowed: false, requires_operator: true, reason: 'Stop first.' },
      },
    }
    expect(capabilityFor(capabilities, 'pause').supported).toBe(true)
    expect(capabilityFor(capabilities, 'archive').reason).toBe('Stop first.')
  })

  it('never exposes withheld text and totals provider usage from durable metadata', () => {
    expect(eventText(event({
      projected_text: 'secret-token',
      redaction_state: 'withheld',
    }))).not.toContain('secret-token')
    expect(usageSummary([
      event({ id: 'usage-1', kind: 'usage', metadata: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 40 } }),
      event({ id: 'usage-2', kind: 'usage', metadata: { input: 30, cache_read: 20, output: 10, cost_cents: 5 } }),
    ])).toEqual({ input: 150, cached: 100, output: 50, costCents: 5 })
  })
})
