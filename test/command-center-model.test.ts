import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../web/src/api.js'
import type { AgentProfile } from '../web/src/agentHomeApi.js'
import {
  buildCommandCenterGraph,
  commandCenterDeepLink,
  commandCenterProjectProjection,
  commandCenterSearchRecords,
  commandCenterStatus,
  filterCommandCenterSearchRecords,
  legacyCommandCenterRedirect,
  parseCommandCenterSelection,
  parseSavedCommandCenterViews,
  projectScopedJobs,
  readCommandCenterPreferences,
  searchCommandCenter,
  DEFAULT_COMMAND_CENTER_VIEWS,
} from '../web/src/commandCenterModel.js'

const snapshots: Snapshot[] = [{
  board: { id: 7, name: 'Orchestra' },
  agents: [{
    id: 12,
    name: 'runtime-operator',
    status: 'active',
    last_seen: '2026-08-02T10:00:00Z',
    provider: 'codex',
    model: 'gpt-5.4',
    capabilities: ['typescript', 'pty'],
    access_profile: 'workspace_write',
  }],
  cards: [{
    id: 41,
    title: 'Durable terminal acceptance',
    description: 'Verify raw terminal continuation.',
    column: 'in_progress',
    owner: 'runtime-operator',
    paths: ['web/src/ProcessTerminal.tsx'],
    updated_at: '2026-08-02T10:00:00Z',
  }],
  open_questions: [],
  threads: [],
  ideas: [],
  milestones: [],
}]

const agentProfiles: AgentProfile[] = [{
  id: 'managed-codex-profile:opaque-7f',
  board_id: 7,
  legacy_agent_id: 12,
  name: 'runtime-operator',
  role: 'runtime engineer',
  default_provider: 'codex',
  default_model: 'gpt-5.4',
  default_effort: 'high',
  default_access_profile: 'workspace_write',
  capabilities: ['typescript', 'pty'],
  owner_actor_type: 'human',
  owner_actor_id: 'operator',
  status: 'active',
  provenance: {},
  created_at: '2026-08-02T10:00:00Z',
  updated_at: '2026-08-02T10:00:00Z',
  archived_at: null,
}]

describe('command center navigation and presentation contracts', () => {
  it('parses canonical deep links and preserves unrelated durable context when one field changes', () => {
    const initial = parseCommandCenterSelection(
      '?debug=1&board=7&section=agents&agent=profile-7&conversation=conversation-7&session=session-7&job=job-7&workspace=workspace-7&process=process-7&event=event-7',
    )
    expect(initial).toMatchObject({
      section: 'agents',
      boardId: 7,
      cardId: null,
      agentId: 'profile-7',
      sessionId: 'session-7',
      workspaceId: 'workspace-7',
      processId: 'process-7',
    })

    const href = commandCenterDeepLink(
      '?debug=1&board=7&section=agents&agent=profile-7&session=session-7&process=process-7',
      { section: 'work', jobId: 'job-9', agentId: null },
      { pathname: '/operator', hash: '#evidence' },
    )
    expect(href).toBe('/operator?debug=1&board=7&section=work&session=session-7&process=process-7&job=job-9#evidence')
    expect(parseCommandCenterSelection(new URL(href, 'http://orchestra.local').search)).toMatchObject({
      section: 'work',
      boardId: 7,
      agentId: null,
      sessionId: 'session-7',
      processId: 'process-7',
      jobId: 'job-9',
    })
  })

  it('redirects duplicate legacy routes to one project-level command center section', () => {
    expect(legacyCommandCenterRedirect('agents')).toEqual({ section: 'agents', legacy: 'agents' })
    expect(legacyCommandCenterRedirect('messages')).toEqual({ section: 'discussions', legacy: 'messages' })
    expect(legacyCommandCenterRedirect('timeline')).toEqual({ section: 'activity', legacy: 'timeline' })
    expect(legacyCommandCenterRedirect('shipped')).toEqual({ section: 'activity', legacy: 'shipped' })
    expect(legacyCommandCenterRedirect('workspaces')).toEqual({ section: 'work', legacy: 'workspaces' })
    expect(legacyCommandCenterRedirect('review')).toEqual({ section: 'work', legacy: 'review' })
    expect(legacyCommandCenterRedirect('card-drawer')).toEqual({ section: 'work', legacy: 'card-drawer' })
    expect(DEFAULT_COMMAND_CENTER_VIEWS.map((view) => view.name)).toEqual([
      'Active work', 'Blocked work', 'Needs review', 'Unanswered', 'Conflicts',
    ])
  })

  it('uses one truthful status vocabulary while preserving unknown backend states', () => {
    expect(commandCenterStatus('agent', 'active')).toMatchObject({ label: 'Running', tone: 'running', known: true })
    expect(commandCenterStatus('job', 'submitted')).toMatchObject({ label: 'Needs review', tone: 'warning' })
    expect(commandCenterStatus('delivery', 'accepted')).toMatchObject({ label: 'Verified', tone: 'success', terminal: true })
    expect(commandCenterStatus('attention', 'critical')).toMatchObject({ label: 'Critical', tone: 'danger' })
    expect(commandCenterStatus('discussion', null)).toMatchObject({ label: 'Unavailable', tone: 'unsupported' })
    expect(commandCenterStatus('process', 'vendor_quiescing')).toEqual({
      label: 'Vendor Quiescing',
      tone: 'neutral',
      known: false,
      terminal: false,
      description: 'The backend reported the unrecognized process state “vendor_quiescing”.',
    })
  })

  it('fails preferences and saved views closed to bounded presentation-only values', () => {
    expect(readCommandCenterPreferences('{"density":"tiny","layout":"floating","terminalTouchBar":false}')).toEqual({
      density: 'comfortable',
      layout: 'balanced',
      terminalTouchBar: false,
    })
    expect(readCommandCenterPreferences('not-json')).toEqual({
      density: 'comfortable',
      layout: 'balanced',
      terminalTouchBar: true,
    })
    expect(parseSavedCommandCenterViews(JSON.stringify([
      { id: 'one', name: 'Blocked work', section: 'work', query: 'blocked', filters: { status: 'blocked' }, createdAt: '2026-08-02T10:00:00Z' },
      { id: 'bad', name: 'Invented route', section: 'billing', query: '', filters: {}, createdAt: '2026-08-02T10:00:00Z' },
    ]))).toHaveLength(1)
  })
})

describe('command center global search and dependency truth', () => {
  it('keeps jobs project-scoped and makes built-in saved-view filters control real records', () => {
    const jobs = [
      {
        id: 'job-7', board_id: 7, card_id: 41, workspace_id: null, provider: 'codex',
        model: 'gpt-5.4', priority: 1, status: 'running', attempts: 1, max_attempts: 1,
        budget_tokens: null, budget_cents: null, scheduled_at: '2026-08-02T10:00:00Z',
        started_at: null, finished_at: null, error: null,
      },
      {
        id: 'job-8', board_id: 8, card_id: 88, workspace_id: null, provider: 'claude',
        model: 'sonnet', priority: 1, status: 'submitted', attempts: 1, max_attempts: 1,
        budget_tokens: null, budget_cents: null, scheduled_at: '2026-08-02T10:00:00Z',
        started_at: null, finished_at: null, error: null,
      },
    ]
    expect(projectScopedJobs(snapshots, jobs).map((job) => job.id)).toEqual(['job-7'])

    const active = DEFAULT_COMMAND_CENTER_VIEWS.find((view) => view.id === 'preset-active-work')!
    const projection = commandCenterProjectProjection({ snapshots, agentProfiles, jobs, savedView: active })
    expect(projection.jobs.map((job) => job.id)).toEqual(['job-7'])
    const records = commandCenterSearchRecords({ snapshots, agentProfiles, jobs: projection.jobs })
    expect(records.some((record) => record.id === 'job:job-8')).toBe(false)
    expect(projection.searchRecords.map((record) => record.id)).toEqual(['job:job-7'])
    const review = DEFAULT_COMMAND_CENTER_VIEWS.find((view) => view.id === 'preset-needs-review')!
    expect(filterCommandCenterSearchRecords(records, review.filters)).toEqual([])
    expect(filterCommandCenterSearchRecords(records, { invented: 'value' })).toEqual([])
  })

  it('searches agents, work, discussions, knowledge, and deliveries without enabling unavailable records', () => {
    const records = commandCenterSearchRecords({
      snapshots,
      agentProfiles,
      discussions: [{
        id: 'discussion-1', boardId: 7, title: 'Restart plan', summary: 'Review daemon recovery.',
        status: 'open', type: 'plan', author: 'runtime-operator', updatedAt: '2026-08-02T10:00:00Z',
      }],
      knowledge: [{
        id: 'knowledge-1', boardId: 7, title: 'PTY restart invariant', summary: 'Raw bytes remain authoritative.',
        source: 'docs/agent-home.md', freshness: null, status: 'unavailable',
      }],
      deliveries: [{
        id: 'delivery-1', lineage_id: null, card_id: 41, contract_id: 'contract-1', job_id: 'job-1',
        session_id: 'session-1', workspace_id: 'workspace-1', status: 'accepted',
        asked: { objective: 'Verify restart', deliverables: [], acceptance_criteria: [], non_goals: [], risks: [], verify_commands: [], dependencies: [], base_ref: null, budget_tokens: null, budget_cents: null, priority: 1, policy_id: null, version: 1, updated_at: null },
        summary: 'Browser continuation verified', human_summary: null, delivered_items: [], deliverable_results: [], criterion_results: [],
        changed_files: ['web/src/AgentHome.tsx'], commits: ['abc123'], artifact_ids: [], claims: [], gaps: [], parent_delivery_id: null,
        sequence: 2, actor_type: 'operator', actor_id: 'operator-1', created_by: null, submitted_by: null, verified_by: null,
        accepted_by: null, rejected_by: null, acceptance_note: null, rejection_reason: null,
        created_at: '2026-08-02T10:00:00Z', updated_at: '2026-08-02T10:00:00Z', submitted_at: null,
        verified_at: null, reviewed_at: null, accepted_at: null, rejected_at: null, shipped_at: null,
      }],
    })
    expect(new Set(records.map((record) => record.kind))).toEqual(new Set(['agent', 'work', 'discussion', 'knowledge', 'delivery']))
    expect(records.find((record) => record.kind === 'agent')).toMatchObject({
      id: 'agent:7:managed-codex-profile:opaque-7f',
      href: '/?section=agents&board=7&agent=managed-codex-profile%3Aopaque-7f',
    })
    expect(parseCommandCenterSelection(
      new URL(records.find((record) => record.kind === 'agent')!.href, 'http://orchestra.local').search,
    ).agentId).toBe('managed-codex-profile:opaque-7f')
    expect(searchCommandCenter(records, 'runtime operator').map((record) => record.kind)).toContain('agent')
    expect(searchCommandCenter(records, 'raw bytes')).toMatchObject([{ kind: 'knowledge', unavailableReason: expect.stringContaining('unavailable') }])
    expect(searchCommandCenter(records, 'browser continuation')).toMatchObject([{ kind: 'delivery', status: 'Verified' }])
    expect(searchCommandCenter(records, 'no such record')).toEqual([])
  })

  it('projects only observed dependencies, assignments, discussions, and conflicts', () => {
    const graph = buildCommandCenterGraph({
      graph: {
        nodes: [
          { card_id: 41, board_id: 7, title: 'Restart acceptance', state: 'open', readiness: 'blocked', blocking_reasons: ['Provider session must be running.'] },
          { card_id: 40, board_id: 7, title: 'Durable reattach', state: 'accepted', readiness: 'ready', blocking_reasons: [] },
        ],
        edges: [{ from_card_id: 41, to_card_id: 40, blocking_reason: 'Provider session must be running.', completion_condition: 'card_done', readiness: 'blocked' }],
      },
      assignments: [{ cardId: 41, agentId: 'profile-7', agentName: 'runtime-operator', status: 'active' }],
      discussions: [{ id: 'discussion-1', cardId: 41, title: 'Restart plan', status: 'open' }],
      conflicts: [{ id: 'conflict-1', cardId: 41, otherCardId: 40, title: 'Shared port ownership', severity: 'high' }],
    })
    expect(graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['work', 'agent', 'discussion', 'conflict']))
    expect(graph.edges.map((edge) => edge.kind)).toEqual(expect.arrayContaining(['depends_on', 'assigned_to', 'discussed_in', 'conflicts_with']))
    expect(graph.edges.find((edge) => edge.kind === 'depends_on')).toMatchObject({ blocked: true, label: 'Provider session must be running.' })
    expect(graph.nodes.find((node) => node.id === 'work:41')?.href).toBe('/?section=work&board=7&card=41')
  })
})
