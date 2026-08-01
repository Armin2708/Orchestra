import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDispatchIdempotencyKey,
  defaultOpenWorkFilters,
  dispatchInputFromMatch,
  openWorkApi,
  OpenWorkProtocolError,
  parseBriefPreview,
  parseContractEnvelope,
  parseMatchResponse,
  parseOpenWorkResponse,
  serializeOpenWorkFilters,
  type ContractEnvelope,
  type OpenWorkMatch,
  type OpenWorkResponse,
} from '../web/src/openWorkApi.js'
import {
  activeFilterChips,
  contractDraftFromEnvelope,
  contractEditorStatus,
  contractVersionIsStale,
  initialOpenWorkState,
  mapBackendValidation,
  nextStableId,
  openWorkCounts,
  openWorkReducer,
  reconcileRequiredArtifacts,
  splitListInput,
  stableOpenWorkItems,
  validateContractDraft,
} from '../web/src/openWorkPresentation.js'

const selectedAgent = {
  profile_id: 'profile-river',
  name: 'River',
  provider: 'codex',
  model: 'gpt-5.4',
  access_profile: 'workspace_write' as const,
  workspace_id: 'workspace-river',
  capabilities: ['typescript', 'ui'],
  eligible: true,
  ineligibility_reasons: [],
  capacity: { active: 1, limit: 3, available: 2 },
}

const openWorkFixture = (): OpenWorkResponse => ({
  items: [{
    card_id: 42,
    board_id: 7,
    title: 'Build Open Work',
    repository: '/work/orchestra',
    status: 'open',
    market_version: 4,
    priority: -2,
    constraints: {
      required_capabilities: ['typescript', 'ui'],
      provider_constraints: ['codex'],
      model_constraints: ['gpt-5.4'],
      access_needs: ['workspace_write'],
    },
    budgets: {
      tokens: 18_500,
      cost_cents: 475,
      time_seconds: 5_400,
      retries: 2,
      coordination_tokens: 1_200,
      coordination_messages: 14,
    },
    dependency_readiness: 'ready',
    dependencies: [{
      card_id: 21,
      title: 'Typed contracts',
      state: 'done',
      blocking_reason: 'Typed contracts must exist first.',
      completion_condition: 'card_done',
      readiness: 'ready',
    }],
    critical_path: [],
    eligible_agent_count: 1,
    selected_agent: selectedAgent,
  }, {
    card_id: 43,
    board_id: 7,
    title: 'Blocked work',
    repository: '/work/orchestra',
    status: 'open',
    market_version: 2,
    priority: 100,
    constraints: {
      required_capabilities: ['sqlite'],
      provider_constraints: [],
      model_constraints: [],
      access_needs: ['read_only'],
    },
    budgets: {
      tokens: null,
      cost_cents: null,
      time_seconds: null,
      retries: null,
      coordination_tokens: null,
      coordination_messages: null,
    },
    dependency_readiness: 'blocked',
    dependencies: [{
      card_id: 31,
      title: 'Storage migration',
      state: 'in_progress',
      blocking_reason: 'The migration must finish.',
      completion_condition: 'card_done',
      readiness: 'blocked',
    }],
    critical_path: [{
      path: [
        { card_id: 43, title: 'Blocked work', state: 'open', blocking_reason: null },
        { card_id: 31, title: 'Storage migration', state: 'in_progress', blocking_reason: 'The migration must finish.' },
      ],
      terminal: 'incomplete',
    }],
    eligible_agent_count: 0,
    selected_agent: null,
  }],
  graph: {
    nodes: [
      {
        card_id: 42,
        board_id: 7,
        title: 'Build Open Work',
        state: 'open',
        readiness: 'ready',
        blocking_reasons: [],
      },
      {
        card_id: 31,
        board_id: 7,
        title: 'Storage migration',
        state: 'in_progress',
        readiness: 'blocked',
        blocking_reasons: ['The migration must finish.'],
      },
    ],
    edges: [{
      from_card_id: 43,
      to_card_id: 31,
      blocking_reason: 'The migration must finish.',
      completion_condition: 'card_done',
      readiness: 'blocked',
    }],
  },
})

const contractEnvelope = (): ContractEnvelope => ({
  contract: {
    card_id: 42,
    objective: 'Expose dependency-ready work.',
    deliverables: [{
      id: 'surface',
      text: 'Open Work surface',
      required: true,
      metadata: {},
    }],
    acceptance_criteria: [{
      id: 'a11y',
      text: 'Keyboard reachable',
      required: true,
      deliverable_ids: ['surface'],
      metadata: {},
    }],
    dependencies: [21],
    base_ref: 'main',
    verify_commands: ['npm test -- open-work'],
    non_goals: ['Auctions'],
    risks: ['Stale capacity'],
    budget_tokens: 18_500,
    budget_cents: 475,
    priority: -2,
    policy_id: null,
    workspace_id: 'workspace-river',
    version: 3,
    updated_at: '2026-07-29T10:00:00.000Z',
  },
  job_market: {
    card_id: 42,
    status: 'open',
    market_version: 4,
    contract: {
      card_id: 42,
      objective: 'Expose dependency-ready work.',
      deliverables: [{
        id: 'surface',
        text: 'Open Work surface',
        required: true,
        metadata: {},
      }],
      acceptance_criteria: [{
        id: 'a11y',
        text: 'Keyboard reachable',
        required: true,
        deliverable_ids: ['surface'],
        metadata: {},
      }],
      dependencies: [21],
      base_ref: 'main',
      verify_commands: ['npm test -- open-work'],
      non_goals: ['Auctions'],
      risks: ['Stale capacity'],
      budget_tokens: 18_500,
      budget_cents: 475,
      priority: -2,
      policy_id: null,
      workspace_id: 'workspace-river',
      version: 3,
      updated_at: '2026-07-29T10:00:00.000Z',
    },
    criteria: [{
      id: 'a11y',
      text: 'Keyboard reachable',
      required: true,
      deliverable_ids: ['surface'],
      metadata: {},
      description: 'Reach every action without a pointer.',
      verifier: { kind: 'human' },
      required_artifacts: [],
      priority: -10,
      owner: 'agent:reviewer',
    }],
    dependency_rules: [{
      card_id: 21,
      blocking_reason: 'Typed contracts must exist first.',
      completion_condition: 'card_done',
    }],
    constraints: {
      required_capabilities: ['typescript', 'ui'],
      provider_constraints: ['codex'],
      model_constraints: ['gpt-5.4'],
      access_needs: ['workspace_write'],
    },
    budgets: {
      tokens: 18_500,
      cost_cents: 475,
      time_seconds: 5_400,
      retries: 2,
      coordination_tokens: 1_200,
      coordination_messages: 14,
    },
    published_at: '2026-07-29T10:00:00.000Z',
    archived_at: null,
    created_at: '2026-07-29T09:00:00.000Z',
    updated_at: '2026-07-29T10:00:00.000Z',
  },
})

const matchFixture = (): OpenWorkMatch => ({
  card_id: 42,
  board_id: 7,
  market_version: 4,
  eligible: true,
  eligible_agent_count: 1,
  selected_agent: selectedAgent,
  candidates: [selectedAgent],
  global_capacity: { active: 2, limit: 6, available: 4 },
  agent_brief_sha256: 'b'.repeat(64),
  decision_sha256: 'd'.repeat(64),
})

describe('Open Work query and protocol', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'operator-token'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 1,
    })
  })

  it('serializes filters in a stable, exact query without locale-sensitive ordering', () => {
    expect(serializeOpenWorkFilters({
      repository: ' /work/orchestra ',
      capabilities: ['ui', 'typescript', 'ui', ''],
      priority: -4,
      dependencyReadiness: 'blocked',
      maxTokens: 20_000,
      maxCostCents: 700,
      maxTimeSeconds: 7_200,
    })).toBe(
      'repository=%2Fwork%2Forchestra&capability=typescript&capability=ui&priority=-4'
      + '&dependency_readiness=blocked&max_tokens=20000&max_cost_cents=700&max_time_seconds=7200',
    )
    expect(() => serializeOpenWorkFilters({
      ...defaultOpenWorkFilters(),
      maxTokens: -1,
    })).toThrow(/maxTokens/)
  })

  it('fails closed on invalid fields instead of coercing them', () => {
    const valid = openWorkFixture()
    expect(parseOpenWorkResponse(valid)).toEqual(valid)
    expect(() => parseOpenWorkResponse({
      ...valid,
      items: [{ ...valid.items[0], eligible_agent_count: '1' }],
    })).toThrow(OpenWorkProtocolError)
    expect(() => parseOpenWorkResponse({
      ...valid,
      items: [{ ...valid.items[0], status: 'assigned' }],
    })).toThrow(/status must be open/)
    expect(() => parseOpenWorkResponse({
      ...valid,
      graph: {
        ...valid.graph,
        edges: [{ ...valid.graph.edges[0], completion_condition: 'guess_done' }],
      },
    })).toThrow(/completion_condition/)

    const envelope = contractEnvelope()
    expect(() => parseContractEnvelope({
      ...envelope,
      job_market: { ...envelope.job_market, status: 'mystery' },
    })).toThrow(/job market status/)
  })

  it('uses the exact GET path and preserves repeated capability keys', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(openWorkFixture()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await openWorkApi.list({
      ...defaultOpenWorkFilters(),
      capabilities: ['ui', 'typescript'],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/os/open-work?capability=typescript&capability=ui',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer operator-token' },
      }),
    )
  })

  it('passes backend brief text and digest through unchanged', () => {
    const exactBrief = 'Delivery pending for Agent OS job pending\n\nKeep this trailing line.\n'
    const preview = parseBriefPreview({
      preview: {
        job_market: contractEnvelope().job_market,
        validation: { mode: 'publish', valid: true, errors: [], warnings: [] },
        agent_brief: exactBrief,
        agent_brief_sha256: 'a'.repeat(64),
      },
    })
    expect(preview.agent_brief).toBe(exactBrief)
    expect(preview.agent_brief_sha256).toBe('a'.repeat(64))
  })

  it('uses exact CAS request paths and bodies for contract and matching operations', async () => {
    const envelope = contractEnvelope()
    const draft = contractDraftFromEnvelope(envelope)
    const preview = {
      preview: {
        job_market: { ...envelope.job_market, market_version: 5 },
        validation: { mode: 'publish', valid: true, errors: [], warnings: [] },
        agent_brief: 'Exact hypothetical preview',
        agent_brief_sha256: 'a'.repeat(64),
      },
    }
    const responses: unknown[] = [
      envelope,
      preview,
      envelope,
      { match: matchFixture() },
    ]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await openWorkApi.updateContract(42, draft, 4)
    await openWorkApi.previewBrief(42, draft, 4)
    await openWorkApi.publishContract(42, 4)
    await openWorkApi.match(42, 4)

    expect(fetchMock.mock.calls.map(([path, request]) => [
      path,
      request?.method,
      JSON.parse(String(request?.body)),
    ])).toEqual([
      [
        '/api/v1/os/cards/42/contract',
        'PUT',
        { ...draft, expected_market_version: 4, actor: 'human' },
      ],
      [
        '/api/v1/os/cards/42/contract/brief-preview',
        'POST',
        { contract: draft, expected_market_version: 4 },
      ],
      [
        '/api/v1/os/cards/42/contract/publish',
        'POST',
        { actor: 'human', expected_market_version: 4 },
      ],
      [
        '/api/v1/os/cards/42/open-work/match',
        'POST',
        { expected_market_version: 4 },
      ],
    ])
  })

  it('accepts a nullable no-winner decision but refuses to build dispatch input', () => {
    const noWinner = parseMatchResponse({
      match: {
        ...matchFixture(),
        eligible: false,
        eligible_agent_count: 0,
        selected_agent: null,
        decision_sha256: null,
        candidates: [{
          ...selectedAgent,
          provider: null,
          model: null,
          access_profile: null,
          workspace_id: null,
          eligible: false,
          ineligibility_reasons: ['capacity unavailable'],
        }],
      },
    })
    expect(noWinner.selected_agent).toBeNull()
    expect(noWinner.decision_sha256).toBeNull()
    expect(noWinner.candidates[0]).toMatchObject({
      provider: null,
      model: null,
      access_profile: null,
      workspace_id: null,
    })
    expect(() => dispatchInputFromMatch(noWinner)).toThrow(/dispatch requires/)
  })

  it('builds a deliberate dispatch identity with no fallback fields', async () => {
    const match = matchFixture()
    expect(dispatchInputFromMatch(match)).toEqual({
      card_id: 42,
      market_version: 4,
      profile_id: 'profile-river',
      provider: 'codex',
      model: 'gpt-5.4',
      access_profile: 'workspace_write',
      workspace_id: 'workspace-river',
      agent_brief_sha256: 'b'.repeat(64),
      decision_sha256: 'd'.repeat(64),
    })
    expect(createDispatchIdempotencyKey(42, match.decision_sha256!, 'fixed-nonce'))
      .toBe('open-work:dispatch:42:dddddddddddd:fixed-nonce')

    const response = {
      replayed: false,
      match,
      assignment: { id: 'assignment-1', profile_id: 'profile-river' },
      job: { id: 'job-1', status: 'running' },
      dispatch: { started: ['job-1'], completed: [], blocked: [], deferred: [] },
      agent_brief: 'Realized exact brief',
      agent_brief_sha256: 'b'.repeat(64),
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await openWorkApi.dispatch(42, match, 'dispatch-key-retained-on-retry')
    const [, request] = fetchMock.mock.calls[0]
    expect(request).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
        'idempotency-key': 'dispatch-key-retained-on-retry',
      },
    })
    expect(JSON.parse(String(request?.body))).toEqual({
      match: dispatchInputFromMatch(match),
      confirm: true,
    })
  })
})

describe('deterministic Open Work presentation', () => {
  it('orders ready work before blocked work, then priority and stable identities', () => {
    const items = openWorkFixture().items
    const reversed = stableOpenWorkItems([...items].reverse())
    expect(reversed.map((item) => item.card_id)).toEqual([42, 43])
    expect(openWorkCounts(items)).toEqual({ total: 2, ready: 1, blocked: 1, matched: 1 })
  })

  it('retains previous results as explicitly stale after a refresh failure', () => {
    const loaded = openWorkReducer(initialOpenWorkState(), { type: 'load' })
    expect(loaded.phase).toBe('loading')
    const ready = openWorkReducer(loaded, { type: 'loaded', response: openWorkFixture() })
    const refreshing = openWorkReducer(ready, { type: 'load' })
    const stale = openWorkReducer(refreshing, { type: 'failed', error: 'network unavailable' })
    expect(stale).toMatchObject({
      phase: 'ready',
      stale: true,
      error: 'network unavailable',
    })
    expect(stale.items).toHaveLength(2)
    const conflict = openWorkReducer(stale, { type: 'conflict', error: 'market version changed' })
    expect(conflict.conflict).toBe('market version changed')
  })

  it('builds stable filter chips and list inputs', () => {
    const filters = {
      repository: '/work/orchestra',
      capabilities: ['ui', 'typescript', 'ui'],
      priority: -4,
      dependencyReadiness: 'ready' as const,
      maxTokens: 12_500,
      maxCostCents: null,
      maxTimeSeconds: null,
    }
    expect(activeFilterChips(filters).map(({ key, value }) => [key, value])).toEqual([
      ['repository', '/work/orchestra'],
      ['capability:typescript', 'typescript'],
      ['capability:ui', 'ui'],
      ['priority', '-4'],
      ['dependency', 'ready'],
      ['tokens', '12,500'],
    ])
    expect(splitListInput(' ui,typescript\nui ')).toEqual(['typescript', 'ui'])
    expect(nextStableId('criterion', ['criterion-1', 'custom', 'criterion-3']))
      .toBe('criterion-2')
  })
})

describe('contract editing readiness', () => {
  it('preserves stable records, typed constraints, and signed priorities', () => {
    const draft = contractDraftFromEnvelope(contractEnvelope())
    expect(draft).toMatchObject({
      objective: 'Expose dependency-ready work.',
      priority: -2,
      required_capabilities: ['typescript', 'ui'],
      provider_constraints: ['codex'],
      budget_time_seconds: 5_400,
    })
    expect(draft.acceptance_criteria[0]).toMatchObject({
      id: 'a11y',
      priority: -10,
      verifier: { kind: 'human' },
    })
    expect(validateContractDraft(draft)).toEqual({})
    draft.budget_retries = 0
    expect(validateContractDraft(draft)).toEqual({})
  })

  it('preserves artifact metadata and duplicate occurrence order while editing kinds', () => {
    const existing = [
      { kind: 'report', name: 'Primary', description: 'Signed result' },
      { kind: 'report', name: 'Secondary', description: 'Raw log' },
      { kind: 'screenshot', name: 'Desktop', description: '1440px viewport' },
    ]
    expect(reconcileRequiredArtifacts(existing, 'report, screenshot, report, trace')).toEqual([
      existing[0],
      existing[2],
      existing[1],
      { kind: 'trace', name: null, description: null },
    ])
  })

  it('maps local and backend validation to stable editor fields', () => {
    const draft = contractDraftFromEnvelope(contractEnvelope())
    draft.objective = ''
    draft.acceptance_criteria[0].verifier = { kind: 'command', command: '' }
    draft.dependency_rules[0].blocking_reason = ''
    draft.budget_time_seconds = -1
    expect(validateContractDraft(draft)).toMatchObject({
      objective: ['Objective is required.'],
      'criteria.a11y.verifier': ['A command verifier needs an exact command.'],
      'dependencies.21.blocking_reason': ['Blocking reason is required.'],
      'budgets.budget_time_seconds': ['Use a positive whole number or leave this blank.'],
    })
    expect(mapBackendValidation({
      errors: [
        'criterion a11y command verifier needs a command',
        'dependency 21 is not complete',
        'provider claude is not allowed',
      ],
      warnings: ['required capabilities must be checked by the scheduler'],
    })).toEqual({
      'criteria.a11y': ['criterion a11y command verifier needs a command'],
      'dependencies.21': ['dependency 21 is not complete'],
      constraints: ['provider claude is not allowed'],
      warnings: ['required capabilities must be checked by the scheduler'],
    })
  })

  it('only enables publish readiness for a current, valid backend preview', () => {
    const envelope = contractEnvelope()
    const draft = contractDraftFromEnvelope(envelope)
    const preview = {
      // Preview runs in a rollback transaction and can expose a hypothetical next version.
      job_market: { ...envelope.job_market, market_version: 5 },
      validation: { mode: 'publish' as const, valid: true, errors: [], warnings: [] },
      agent_brief: 'Draft brief',
      agent_brief_sha256: 'c'.repeat(64),
    }
    expect(contractEditorStatus(draft, preview, 4, 4, 0, 0)).toMatchObject({
      localReady: true,
      dirty: false,
      previewCurrent: true,
      publishReady: true,
    })
    expect(contractEditorStatus(draft, preview, 4, 5, 0, 0)).toMatchObject({
      localReady: true,
      previewCurrent: false,
      publishReady: false,
    })
    expect(contractEditorStatus(draft, preview, 4, 4, 2, 1)).toMatchObject({
      localReady: true,
      dirty: true,
      previewCurrent: false,
      publishReady: false,
    })
  })

  it('locks a cached contract as soon as the queue exposes a different market version', () => {
    expect(contractVersionIsStale(4, 4)).toBe(false)
    expect(contractVersionIsStale(4, 5)).toBe(true)
    expect(contractVersionIsStale(null, 5)).toBe(false)
  })
})
