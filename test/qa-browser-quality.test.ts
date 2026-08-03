import { describe, expect, it } from 'vitest'
import baseline from '../docs/qa-browser-performance-baseline.json'
import observation1 from '../docs/qa-evidence/browser-quality/observation-1.json'
import observation2 from '../docs/qa-evidence/browser-quality/observation-2.json'
import observation3 from '../docs/qa-evidence/browser-quality/observation-3.json'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACCESSIBILITY_GATES,
  AUTHENTICATED_DATA_READY_EXPRESSION,
  BETA_EXPERIENCE_BUDGETS_MS,
  BROWSER_BASELINE_SCHEMA_VERSION,
  BROWSER_JOURNEYS,
  BROWSER_OVERFLOW_AUDIT_EXPRESSION,
  BROWSER_QUALITY_SCHEMA_VERSION,
  EXPECTED_BROWSER_LOGIN_CYCLES,
  EVIDENCE_MAX_ARRAY_LENGTH,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_STRING_LENGTH,
  FATAL_VIEWPORT_DIAGNOSTIC_MAX_ENTRIES,
  FIXTURE_SEED_EXPECTED_COMMAND_STARTS,
  FIXTURE_SEED_EXPECTED_PROVIDER_STARTS,
  FIXTURE_SEED_EXPECTED_REQUEST_STARTS,
  PERFORMANCE_SURFACES,
  REQUEST_BUDGET_CEILING,
  REQUEST_BUDGET_MAX_LIFECYCLE_STARTS,
  REQUEST_BUDGET_RESERVE,
  REQUEST_BUDGET_WINDOW_MS,
  RESPONSIVE_VIEWPORTS,
  SEED_COMMAND_BUDGET_CEILING,
  SEED_COMMAND_BUDGET_RESERVE,
  SEED_COMMAND_BUDGET_WINDOW_MS,
  SEED_MAX_IN_FLIGHT,
  SEED_PROVIDER_BUDGET_CEILING,
  SEED_PROVIDER_BUDGET_RESERVE,
  SEED_PROVIDER_BUDGET_WINDOW_MS,
  STARTUP_CDP_WINDOW_OVERHEAD_TOLERANCE_MS,
  STARTUP_COMPETITOR_RESOURCE_ROUTE_DIGESTS,
  STARTUP_CRITICAL_RESOURCE_ROUTE_DIGESTS,
  assertFinalBuildManifest,
  attachRequestBudgetPacer,
  compositeRgba,
  contrastRatio,
  checkedBudget,
  compactJourneyEvidence,
  createFatalLifecycleDiagnosticTracker,
  createRequestBudgetPacer,
  createSeedBudgetPacer,
  createStartupCompetitorStartTracker,
  deriveRegressionBudgetMs,
  evidenceDigest,
  finalizeBrowserEvidence,
  finalizeValidatedBrowserEvidence,
  navigateFreshInteractionMode,
  performanceSampleForJourney,
  redactEvidence,
  canonicalRepositoryName,
  resolveApprovedArtifactPath,
  resolveApprovedEvidencePath,
  validateBaselineAgainstCaptures,
  validateArtifactIdentity,
  validateBuildSourceIdentity,
  validateFatalViewportDiagnostics,
  validatePerformanceBaseline,
  validateBrowserQualityEvidence,
  verifiableDocumentDigest,
  writeBrowserArtifact,
} from '../scripts/lib/browser-quality.mjs'
import {
  LOCAL_OWNER_CHALLENGE_DIGESTS,
  LOCAL_OWNER_CHALLENGE_PATHS,
  createLocalOwnerChallengeTracker,
  localOwnerChallengeEndpointDigest,
  recordLocalOwnerHttpFailure,
} from '../scripts/lib/browser-auth-challenges.mjs'

const chromeForDomFixture = [
  process.env.ORCHESTRA_QA_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))

const passingEvidence = () => {
  const reset = (name: string, mode: string) => ({
    strategy: 'fresh_page_navigation',
    loader_sha256: evidenceDigest(`${name}:${mode}`),
    navigation_synchronization: {
      expected_loader_sha256: evidenceDigest(`${name}:${mode}`),
      observed_loader_sha256: evidenceDigest(`${name}:${mode}`),
      main_frame_loader_matched: true,
      location_matched: true,
      time_origin_changed: true,
      document_complete: true,
      load_event_observed: true,
      elapsed_ms: 20,
      time_origin_delta_ms: 10,
    },
  })
  const evidence: any = {
  schema_version: BROWSER_QUALITY_SCHEMA_VERSION,
  source: {
    repository: 'agentboard',
    commit: 'a'.repeat(40),
    source_status: 'clean',
    binding_status: 'passed_preflight_and_final',
    source_tree_sha256: 'd'.repeat(64),
    build_manifest_sha256: 'e'.repeat(64),
    artifact_identity: { root_dist_sha256: 'b'.repeat(64), web_dist_sha256: 'c'.repeat(64) },
  },
  request_budget_pacing: {
    observed_request_starts: 900,
    wait_count: 1,
    total_wait_ms: 60_000,
    window_ms: REQUEST_BUDGET_WINDOW_MS,
    ceiling: REQUEST_BUDGET_CEILING,
    reserve: REQUEST_BUDGET_RESERVE,
    max_lifecycle_request_starts: 120,
    rate_limit_response_count: 0,
  },
  seed_budget_pacing: {
    request: {
      observed_starts: FIXTURE_SEED_EXPECTED_REQUEST_STARTS,
      completed_responses: FIXTURE_SEED_EXPECTED_REQUEST_STARTS,
      window_ms: REQUEST_BUDGET_WINDOW_MS,
      ceiling: REQUEST_BUDGET_CEILING,
      reserve: REQUEST_BUDGET_RESERVE,
      limit: REQUEST_BUDGET_CEILING + REQUEST_BUDGET_RESERVE,
      wait_count: 0,
      wait_ms: 0,
      response_to_boundary_elapsed_ms: [],
    },
    command: {
      observed_starts: FIXTURE_SEED_EXPECTED_COMMAND_STARTS,
      completed_responses: FIXTURE_SEED_EXPECTED_COMMAND_STARTS,
      window_ms: SEED_COMMAND_BUDGET_WINDOW_MS,
      ceiling: SEED_COMMAND_BUDGET_CEILING,
      reserve: SEED_COMMAND_BUDGET_RESERVE,
      limit: SEED_COMMAND_BUDGET_CEILING + SEED_COMMAND_BUDGET_RESERVE,
      wait_count: 1,
      wait_ms: SEED_COMMAND_BUDGET_WINDOW_MS,
      response_to_boundary_elapsed_ms: [SEED_COMMAND_BUDGET_WINDOW_MS],
    },
    provider: {
      observed_starts: FIXTURE_SEED_EXPECTED_PROVIDER_STARTS,
      completed_responses: FIXTURE_SEED_EXPECTED_PROVIDER_STARTS,
      window_ms: SEED_PROVIDER_BUDGET_WINDOW_MS,
      ceiling: SEED_PROVIDER_BUDGET_CEILING,
      reserve: SEED_PROVIDER_BUDGET_RESERVE,
      limit: SEED_PROVIDER_BUDGET_CEILING + SEED_PROVIDER_BUDGET_RESERVE,
      wait_count: 0,
      wait_ms: 0,
      response_to_boundary_elapsed_ms: [],
    },
    final_drain_ms: REQUEST_BUDGET_WINDOW_MS,
    max_in_flight: SEED_MAX_IN_FLIGHT,
    rate_limit_response_count: 0,
  },
  scenario: {
    transcript_events: 250,
    graph_agents: 18,
  },
  viewports: RESPONSIVE_VIEWPORTS.map((viewport) => ({
    ...viewport,
    horizontal_overflow_px: 0,
    overflow_measurement: { visible_overflow_px: 0, document_extent_overflow_px: 0 },
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    authentication_challenges: Array.from({ length: EVIDENCE_MAX_ARRAY_LENGTH }, (_, index) => ({
      label: 'expected_local_owner_challenge',
      status: 401,
      endpoint_sha256: LOCAL_OWNER_CHALLENGE_DIGESTS[
        LOCAL_OWNER_CHALLENGE_PATHS[index % LOCAL_OWNER_CHALLENGE_PATHS.length]
      ],
    })),
    authentication_challenge_inventory: {
      passed: true,
      login_cycles: EXPECTED_BROWSER_LOGIN_CYCLES,
      total_count: LOCAL_OWNER_CHALLENGE_PATHS.length * EXPECTED_BROWSER_LOGIN_CYCLES,
      pending_request_count: 0,
      endpoints: LOCAL_OWNER_CHALLENGE_PATHS.map((path) => ({
        endpoint_sha256: LOCAL_OWNER_CHALLENGE_DIGESTS[path],
        count: EXPECTED_BROWSER_LOGIN_CYCLES,
      })),
    },
    accessibility: Object.fromEntries(ACCESSIBILITY_GATES.map((gate) => [gate, { passed: true }])),
    readiness: { dependency_graph_nodes_rendered: 1, transcript_events_rendered: 250, search_matches_rendered: 5 },
    journeys: BROWSER_JOURNEYS.map((name) => ({
      name,
      interaction_modes: {
        pointer: {
          passed: true, counts_toward_pass: true, elapsed_ms: 10, performance_eligible: true,
          diagnostic_only: false, reset: reset(name, 'pointer'),
        },
        keyboard: {
          passed: true, counts_toward_pass: true, elapsed_ms: 20, performance_eligible: false, diagnostic_only: false,
          action_evidence: {
            focus_acquisition: 'tab_navigation', programmatic_focus: false, tab_events: 3,
            xterm_focus_encounters: 0, xterm_escape_paths: [],
          },
          reset: reset(name, 'keyboard'),
        },
        dom_fallback: {
          passed: true, counts_toward_pass: false, elapsed_ms: 1, performance_eligible: false,
          diagnostic_only: true, reset: reset(name, 'dom_fallback'),
        },
      },
      elapsed_ms: 10,
      performance_sample_mode: ['graph overview', 'durable transcript', 'conversation search'].includes(name)
        ? 'pointer' : 'diagnostic_only',
      accessibility: Object.fromEntries(ACCESSIBILITY_GATES.map((gate) => [gate, {
        passed: true,
        ...(gate === 'keyboard_focus' ? { xterm_focus_encounters: 0, xterm_escape_paths: [] } : {}),
      }])),
    })),
    performance: Object.fromEntries(PERFORMANCE_SURFACES.map((surface) => [surface, {
      observed_ms: surface === 'startup' ? 4 : surface === 'snapshot_loading' ? 3 : 10,
      measurement_mode: surface === 'startup' ? 'authenticated_submit_to_ready'
        : surface === 'snapshot_loading' ? 'authenticated_fetch' : 'pointer',
      quality_gate_passed: true,
      budget_ms: 100,
      budget_source: 'checked_observation',
      ...(surface === 'startup' ? { provenance: {
        loader_sha256: evidenceDigest(`startup:${viewport.id}`),
        navigation_synchronization: {
          expected_loader_sha256: evidenceDigest(`startup:${viewport.id}`),
          observed_loader_sha256: evidenceDigest(`startup:${viewport.id}`),
          main_frame_loader_matched: true,
          location_matched: true,
          time_origin_changed: true,
          document_complete: true,
          load_event_observed: true,
          elapsed_ms: 4,
          time_origin_delta_ms: 10,
        },
        time_origin_ms: 1_000 + RESPONSIVE_VIEWPORTS.findIndex((candidate) => candidate.id === viewport.id),
        navigation_start_ms: 0,
        navigation_type: 'navigate',
        navigation_path: '/',
        navigation_viewport: viewport.id,
        login_form_ready_ms: 4,
        login_entry_ms: 2,
        submit_to_command_center_ms: 1,
        command_center_ready_ms: 7,
        command_center_to_data_ready_ms: 3,
        submit_to_data_ready_ms: 4,
        navigation_to_data_ready_ms: 10,
        snapshot_resource_ms: 3,
        resource_timing: {
          window: 'submit_to_data_ready',
          window_start_ms: 6,
          window_end_ms: 10,
          critical_resource_count: 4,
          competitor_resource_count: 0,
          competitor_request_start_count: 0,
          competitor_request_window_ms: 4,
          critical_resources: [
            { category: 'boards', start_ms: 6, response_end_ms: 6.5, duration_ms: 0.5 },
            { category: 'snapshot', start_ms: 6.5, response_end_ms: 9.5, duration_ms: 3 },
            { category: 'jobs', start_ms: 6.25, response_end_ms: 7.25, duration_ms: 1 },
            { category: 'profiles', start_ms: 6.25, response_end_ms: 7.25, duration_ms: 1 },
          ].map((entry) => ({
            ...entry,
            route_sha256: STARTUP_CRITICAL_RESOURCE_ROUTE_DIGESTS[entry.category],
            endpoint_sha256: evidenceDigest(`endpoint:${entry.category}`),
          })),
          competitor_resources: [],
          competitor_request_starts: [],
          long_tasks: { supported: true, count: 0, total_duration_ms: 0, max_duration_ms: 0 },
        },
        data_ready_selector: '.cc-shell[data-connection="live"]',
      } } : {}),
    }])),
  })),
  }
  return finalizeBrowserEvidence(evidence, [])
}

const passingFatalViewportDiagnostics = () => {
  const emptyStatuses = () => ({
    informational: 0,
    successful: 0,
    redirection: 0,
    client_error: 0,
    server_error: 0,
    other: 0,
  })
  const route = (path: '/api/v1/boards' | '/api/v1/events') => ({
    route_sha256: LOCAL_OWNER_CHALLENGE_DIGESTS[path],
    request_start_count: 0,
    response_count: 0,
    status_category_counts: emptyStatuses(),
    loading_finished_count: 0,
    loading_failed_count: 0,
    from_service_worker_count: 0,
    event_source_open_count: 0,
    event_source_close_count: 0,
    pending_request_count: 0,
  })
  return {
    viewport_id: 'desktop',
    context: {
      journey: 'Settings primary view',
      interaction_mode: 'keyboard',
      stage: 'owner_login',
      lifecycle_ordinal: 32,
    },
    dom_surface: {
      document_complete: true,
      login: false,
      connecting: true,
      initial_offline: false,
      application: false,
    },
    document_state: { ready_state: 'complete', surface: 'connecting' },
    service_worker: {
      controller: true,
      registration_count: 1,
      active: true,
      waiting: false,
      installing: false,
    },
    navigation_synchronization: {
      expected_loader_sha256: 'a'.repeat(64),
      observed_loader_sha256: 'a'.repeat(64),
      main_frame_loader_matched: true,
      location_matched: true,
      time_origin_changed: true,
      document_complete: true,
      load_event_observed: true,
      elapsed_ms: 12,
      time_origin_delta_ms: 10,
    },
    authentication_challenge_inventory: {
      login_cycles: 1,
      total_count: 0,
      pending_request_count: 2,
      endpoints: LOCAL_OWNER_CHALLENGE_PATHS.map((path) => ({
        endpoint_sha256: LOCAL_OWNER_CHALLENGE_DIGESTS[path], count: 0,
      })),
    },
    local_evidence: {
      failed_request_count: 0,
      failed_requests: [],
      authentication_challenge_count: 0,
      authentication_challenges: [],
      console_error_count: 0,
      console_errors: [],
      page_error_count: 0,
      page_errors: [],
    },
    last_lifecycle: {
      request_start_count: 0,
      response_count: 0,
      status_category_counts: emptyStatuses(),
      loading_finished_count: 0,
      from_service_worker_count: 0,
      pending_request_count: 0,
      routes: { boards: route('/api/v1/boards'), events: route('/api/v1/events') },
      loading_failed_count: 0,
      loading_failed: [],
    },
  }
}

const currentBaseline = () => {
  const upgraded = structuredClone(baseline) as any
  upgraded.schema_version = BROWSER_BASELINE_SCHEMA_VERSION
  for (const viewport of upgraded.viewports) {
    viewport.performance.startup.measurement_mode = 'authenticated_submit_to_ready'
  }
  upgraded.sha256 = verifiableDocumentDigest(upgraded)
  return upgraded
}

describe('QA-013–QA-015 browser quality evidence contract', () => {
  it('uses the breaking schema-v8 contract for authenticated browser evidence', () => {
    expect(BROWSER_QUALITY_SCHEMA_VERSION).toBe(8)
    expect(BROWSER_BASELINE_SCHEMA_VERSION).toBe(4)
    expect(EXPECTED_BROWSER_LOGIN_CYCLES).toBe(37)
    expect(passingEvidence().viewports[0].authentication_challenge_inventory).toMatchObject({
      login_cycles: 37,
      total_count: 74,
      pending_request_count: 0,
    })
    const staleDiagnostic = passingEvidence()
    staleDiagnostic.schema_version = 7
    staleDiagnostic.sha256 = verifiableDocumentDigest(staleDiagnostic)
    expect(validateBrowserQualityEvidence(staleDiagnostic)).toContain('schema version is invalid')
  })

  it('does not close startup on navigation or an offline command center', () => {
    const evaluateReady = (connection: 'absent' | 'offline' | 'live') => Function(
      'document',
      `return ${AUTHENTICATED_DATA_READY_EXPRESSION}`,
    )({
      querySelector: (selector: string) => selector === '.cc-shell[data-connection="live"]'
        && connection === 'live' ? { dataset: { connection: 'live' } } : null,
    })
    expect(evaluateReady('absent')).toBe(false)
    expect(evaluateReady('offline')).toBe(false)
    expect(evaluateReady('live')).toBe(true)
  })

  it('retains exact current-lifecycle boards, EventSource, and service-worker-safe fatal evidence', () => {
    const tracker = createFatalLifecycleDiagnosticTracker('http://127.0.0.1:4312')
    tracker.beginLifecycle()
    expect(tracker.observeRequest(
      'boards-current', 'http://127.0.0.1:4312/api/v1/boards?secret=never-retained', 'Fetch',
    )).toBe(true)
    expect(tracker.observeResponse(
      'boards-current', 401, 'http://127.0.0.1:4312/api/v1/boards?secret=never-retained', true,
    )).toBe(true)
    expect(tracker.observeFinished('boards-current')).toBe(true)
    expect(tracker.observeRequest(
      'events-current', 'http://127.0.0.1:4312/api/v1/events?token=never-retained', 'EventSource',
    )).toBe(true)
    expect(tracker.observeResponse(
      'events-current', 200, 'http://127.0.0.1:4312/api/v1/events?token=never-retained', false,
    )).toBe(true)
    expect(tracker.observeFailure('events-current', 'net::ERR_ABORTED private-url', true)).toBe(true)
    const evidence = tracker.evidence()
    expect(evidence).toMatchObject({
      request_start_count: 2,
      response_count: 2,
      loading_finished_count: 1,
      loading_failed_count: 1,
      pending_request_count: 0,
      from_service_worker_count: 1,
      routes: {
        boards: {
          request_start_count: 1,
          response_count: 1,
          loading_finished_count: 1,
          loading_failed_count: 0,
          from_service_worker_count: 1,
          event_source_open_count: 0,
          event_source_close_count: 0,
          pending_request_count: 0,
        },
        events: {
          request_start_count: 1,
          response_count: 1,
          loading_finished_count: 0,
          loading_failed_count: 1,
          from_service_worker_count: 0,
          event_source_open_count: 1,
          event_source_close_count: 1,
          pending_request_count: 0,
        },
      },
    })
    expect(JSON.stringify(evidence)).not.toMatch(/boards-current|events-current|secret|token|private-url|\/api\//)

    const diagnostics = passingFatalViewportDiagnostics()
    diagnostics.last_lifecycle = evidence
    expect(validateFatalViewportDiagnostics(diagnostics)).toEqual([])
  })

  it('ignores late prior-lifecycle terminals and does not call a rejected EventSource closed', () => {
    const tracker = createFatalLifecycleDiagnosticTracker('http://127.0.0.1:4312')
    tracker.observeRequest('prior-events', 'http://127.0.0.1:4312/api/v1/events', 'EventSource')
    tracker.beginLifecycle()
    expect(tracker.observeResponse(
      'prior-events', 200, 'http://127.0.0.1:4312/api/v1/events', true,
    )).toBe(false)
    expect(tracker.observeFailure('prior-events', 'late failure', true)).toBe(false)
    expect(tracker.evidence()).toEqual(passingFatalViewportDiagnostics().last_lifecycle)

    tracker.observeRequest('rejected-events', 'http://127.0.0.1:4312/api/v1/events', 'EventSource')
    tracker.observeResponse('rejected-events', 401, 'http://127.0.0.1:4312/api/v1/events', true)
    tracker.observeFinished('rejected-events')
    expect(tracker.evidence().routes.events).toMatchObject({
      event_source_open_count: 0,
      event_source_close_count: 0,
      loading_finished_count: 1,
    })
  })

  it('rejects fatal diagnostic privacy, shape, bounds, and lifecycle-accounting violations', () => {
    expect(validateFatalViewportDiagnostics(passingFatalViewportDiagnostics())).toEqual([])
    const adversarialCases: Array<(diagnostics: any) => void> = [
      (diagnostics) => { diagnostics.service_worker.scope = '/private/scope' },
      (diagnostics) => { diagnostics.context.journey = 'raw dynamic journey' },
      (diagnostics) => { diagnostics.last_lifecycle.routes.boards.request_id = 'raw-request' },
      (diagnostics) => { diagnostics.last_lifecycle.routes.events.route_sha256 = 'not-a-digest' },
      (diagnostics) => { diagnostics.last_lifecycle.routes.boards.pending_request_count = 1 },
      (diagnostics) => { diagnostics.last_lifecycle.response_count = 1 },
      (diagnostics) => { diagnostics.local_evidence.authentication_challenge_count = 1 },
      (diagnostics) => {
        diagnostics.last_lifecycle.loading_failed = Array.from(
          { length: FATAL_VIEWPORT_DIAGNOSTIC_MAX_ENTRIES + 1 },
          () => ({ error_sha256: 'a'.repeat(64), route_sha256: null, canceled: false }),
        )
      },
    ]
    for (const mutate of adversarialCases) {
      const diagnostics = passingFatalViewportDiagnostics()
      mutate(diagnostics)
      expect(validateFatalViewportDiagnostics(diagnostics).length).toBeGreaterThan(0)
    }
  })

  it('retains bounded hashed competitor starts even when no response completes', () => {
    let now = 100
    const tracker = createStartupCompetitorStartTracker('http://127.0.0.1:4312', () => now)
    expect(tracker.observeRequest('before', 'http://127.0.0.1:4312/api/v1/system')).toBe(false)
    tracker.beginWindow()
    now = 101
    expect(tracker.observeRequest('in-flight-system', 'http://127.0.0.1:4312/api/v1/system')).toBe(true)
    expect(tracker.observeRequest('critical', 'http://127.0.0.1:4312/api/v1/boards')).toBe(false)
    expect(tracker.observeRequest('foreign', 'https://example.invalid/api/v1/os/open-work')).toBe(false)
    now = 103
    expect(tracker.observeRequest('in-flight-open-work', 'http://127.0.0.1:4312/api/v1/os/open-work')).toBe(true)
    now = 105
    tracker.endWindow()
    expect(tracker.observeRequest('after', 'http://127.0.0.1:4312/api/v1/os/devices/self')).toBe(false)
    const evidence = tracker.evidence()
    expect(evidence).toMatchObject({
      competitor_request_start_count: 2,
      competitor_request_window_ms: 5,
    })
    expect(evidence.competitor_request_starts).toHaveLength(2)
    expect(evidence.competitor_request_starts.every((entry: any) =>
      /^[a-f0-9]{64}$/.test(entry.endpoint_sha256)
      && /^[a-f0-9]{64}$/.test(entry.request_sha256))).toBe(true)
    expect(JSON.stringify(evidence)).not.toContain('/api/')
    expect(JSON.stringify(evidence)).not.toContain('in-flight-system')

    const bounded = createStartupCompetitorStartTracker('http://127.0.0.1:4312', () => 1)
    bounded.beginWindow()
    for (let index = 0; index < 30; index += 1) {
      bounded.observeRequest(`request-${index}`, 'http://127.0.0.1:4312/api/v1/system')
    }
    bounded.endWindow()
    expect(bounded.evidence()).toMatchObject({
      competitor_request_start_count: 30,
      competitor_request_starts: expect.any(Array),
    })
    expect(bounded.evidence().competitor_request_starts).toHaveLength(25)
  })

  it('shares one request-budget listener across viewport lifecycle transitions', async () => {
    let now = 1_000
    const pacer = createRequestBudgetPacer('http://127.0.0.1:4312', {
      now: () => now,
      sleep: async (milliseconds: number) => { now += milliseconds },
    })
    const listeners = new Map<string, Set<(event: any) => void>>()
    const client = {
      on: (event: string, listener: (value: any) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)!.add(listener)
        return () => listeners.get(event)?.delete(listener)
      },
    }
    const emit = (event: string, value: any) => {
      for (const listener of listeners.get(event) ?? []) listener(value)
    }
    const detach = attachRequestBudgetPacer(client, pacer)
    await pacer.beforeLifecycle()
    emit('Network.requestWillBeSent', { request: { url: 'http://127.0.0.1:4312/api/v1/boards' } })
    emit('Network.requestWillBeSent', { request: { url: 'https://example.invalid/api/v1/boards' } })
    await pacer.beforeLifecycle()
    emit('Network.requestWillBeSent', { request: { url: 'http://127.0.0.1:4312/api/v1/events' } })
    pacer.finishLifecycle()
    expect(pacer.evidence()).toMatchObject({
      observed_request_starts: 2,
      max_lifecycle_request_starts: 1,
      rate_limit_response_count: 0,
    })
    detach()
    emit('Network.requestWillBeSent', { request: { url: 'http://127.0.0.1:4312/api/v1/system' } })
    expect(pacer.evidence().observed_request_starts).toBe(2)
  })

  it('paces the rolling browser request window before starting another lifecycle', async () => {
    let now = 0
    const waits: number[] = []
    const pacer = createRequestBudgetPacer('http://127.0.0.1:4312', {
      now: () => now,
      sleep: async (milliseconds: number) => { waits.push(milliseconds); now += milliseconds },
    })
    for (let lifecycle = 0; lifecycle < 4; lifecycle += 1) {
      await pacer.beforeLifecycle()
      for (let request = 0; request < REQUEST_BUDGET_MAX_LIFECYCLE_STARTS; request += 1) {
        expect(pacer.observeRequest('http://127.0.0.1:4312/api/v1/boards')).toBe(true)
      }
    }
    await pacer.beforeLifecycle()
    expect(waits).toEqual([60_000])
    expect(pacer.evidence()).toEqual({
      observed_request_starts: REQUEST_BUDGET_CEILING,
      wait_count: 1,
      total_wait_ms: 60_000,
      window_ms: REQUEST_BUDGET_WINDOW_MS,
      ceiling: REQUEST_BUDGET_CEILING,
      reserve: REQUEST_BUDGET_RESERVE,
      max_lifecycle_request_starts: REQUEST_BUDGET_MAX_LIFECYCLE_STARTS,
      rate_limit_response_count: 0,
    })
    expect(JSON.stringify(pacer.evidence())).not.toMatch(/api|request_id|url/i)
  })

  it('fails closed on operational 429s and per-lifecycle request explosions', async () => {
    let now = 0
    const pacer = createRequestBudgetPacer('http://127.0.0.1:4312', { now: () => now })
    await pacer.beforeLifecycle()
    for (let index = 0; index <= REQUEST_BUDGET_MAX_LIFECYCLE_STARTS; index += 1) {
      pacer.observeRequest('http://127.0.0.1:4312/api/v1/boards')
    }
    expect(() => pacer.assertHealthy()).toThrow(/maximum is 200/)

    const limited = createRequestBudgetPacer('http://127.0.0.1:4312', { now: () => now })
    await limited.beforeLifecycle()
    limited.observeRequest('http://127.0.0.1:4312/api/v1/system')
    expect(limited.observeResponse(429, 'http://127.0.0.1:4312/api/v1/system')).toBe(true)
    expect(() => limited.assertHealthy()).toThrow(/operational 429/)
    expect(limited.failedRequests()).toEqual([{
      label: 'http_failure', status: 429,
      endpoint_sha256: localOwnerChallengeEndpointDigest('/api/v1/system'),
    }])
    expect(JSON.stringify(limited.failedRequests())).not.toContain('/api/v1/system')
  })

  it('paces concurrent fixture requests across exact request, command, and provider policies', async () => {
    let now = 0
    const waits: number[] = []
    const pacer = createSeedBudgetPacer({
      now: () => now,
      sleep: async (milliseconds: number) => { waits.push(milliseconds); now += milliseconds },
    })
    const issue = async (family: 'request' | 'command' | 'provider', count: number) => {
      for (let offset = 0; offset < count; offset += 20) {
        const size = Math.min(20, count - offset)
        const reservations = await Promise.all(Array.from({ length: size }, () => pacer.beforeRequest(family)))
        now += 1
        for (const reservation of reservations) {
          pacer.completeRequest(reservation, 200, 'http://127.0.0.1:4312/api/v1/fixture')
        }
      }
    }

    await issue('command', FIXTURE_SEED_EXPECTED_COMMAND_STARTS)
    await issue('request', 1)
    await issue('provider', FIXTURE_SEED_EXPECTED_PROVIDER_STARTS)
    await pacer.finishAndDrain()

    expect(pacer.evidence()).toEqual({
      request: {
        observed_starts: FIXTURE_SEED_EXPECTED_REQUEST_STARTS,
        completed_responses: FIXTURE_SEED_EXPECTED_REQUEST_STARTS,
        window_ms: REQUEST_BUDGET_WINDOW_MS,
        ceiling: REQUEST_BUDGET_CEILING,
        reserve: REQUEST_BUDGET_RESERVE,
        limit: REQUEST_BUDGET_CEILING + REQUEST_BUDGET_RESERVE,
        wait_count: 0,
        wait_ms: 0,
        response_to_boundary_elapsed_ms: [],
      },
      command: {
        observed_starts: FIXTURE_SEED_EXPECTED_COMMAND_STARTS,
        completed_responses: FIXTURE_SEED_EXPECTED_COMMAND_STARTS,
        window_ms: SEED_COMMAND_BUDGET_WINDOW_MS,
        ceiling: SEED_COMMAND_BUDGET_CEILING,
        reserve: SEED_COMMAND_BUDGET_RESERVE,
        limit: SEED_COMMAND_BUDGET_CEILING + SEED_COMMAND_BUDGET_RESERVE,
        wait_count: 1,
        wait_ms: SEED_COMMAND_BUDGET_WINDOW_MS,
        response_to_boundary_elapsed_ms: [SEED_COMMAND_BUDGET_WINDOW_MS],
      },
      provider: {
        observed_starts: FIXTURE_SEED_EXPECTED_PROVIDER_STARTS,
        completed_responses: FIXTURE_SEED_EXPECTED_PROVIDER_STARTS,
        window_ms: SEED_PROVIDER_BUDGET_WINDOW_MS,
        ceiling: SEED_PROVIDER_BUDGET_CEILING,
        reserve: SEED_PROVIDER_BUDGET_RESERVE,
        limit: SEED_PROVIDER_BUDGET_CEILING + SEED_PROVIDER_BUDGET_RESERVE,
        wait_count: 0,
        wait_ms: 0,
        response_to_boundary_elapsed_ms: [],
      },
      final_drain_ms: REQUEST_BUDGET_WINDOW_MS,
      max_in_flight: SEED_MAX_IN_FLIGHT,
      rate_limit_response_count: 0,
    })
    expect(waits).toEqual([SEED_COMMAND_BUDGET_WINDOW_MS, REQUEST_BUDGET_WINDOW_MS])
    expect(JSON.stringify(pacer.evidence())).not.toMatch(/api\/|request_id|url|session/i)
  })

  it('anchors a new seed segment to the latest response and tolerates early and oversleeping clocks', async () => {
    let now = 0
    const requestedWaits: number[] = []
    const pacer = createSeedBudgetPacer({
      now: () => now,
      sleep: async (milliseconds: number) => {
        requestedWaits.push(milliseconds)
        now += requestedWaits.length === 1 ? Math.floor(milliseconds / 2) : milliseconds + 500
      },
    })
    for (let offset = 0; offset < SEED_COMMAND_BUDGET_CEILING; offset += 20) {
      const reservations = await Promise.all(Array.from({ length: 20 }, () => pacer.beforeRequest('command')))
      now += 1
      for (const reservation of reservations) {
        pacer.completeRequest(reservation, 200, 'http://127.0.0.1:4312/api/v1/fixture')
      }
    }
    now = 100
    const next = await pacer.beforeRequest('command')
    expect(requestedWaits).toEqual([59_910, 29_955])
    expect(now).toBe(60_510)
    pacer.completeRequest(next, 200, 'http://127.0.0.1:4312/api/v1/fixture')
    expect(pacer.evidence().command).toMatchObject({
      observed_starts: SEED_COMMAND_BUDGET_CEILING + 1,
      wait_count: 2,
      wait_ms: 60_410,
      response_to_boundary_elapsed_ms: [60_500],
    })
  })

  it('records exact response-boundary elapsed time when scheduler delay precedes a one-ms sleep', async () => {
    let now = 0
    const waits: number[] = []
    const pacer = createSeedBudgetPacer({
      now: () => now,
      sleep: async (milliseconds: number) => { waits.push(milliseconds); now += milliseconds },
    })
    for (let offset = 0; offset < SEED_COMMAND_BUDGET_CEILING; offset += SEED_MAX_IN_FLIGHT) {
      const reservations = await Promise.all(Array.from(
        { length: SEED_MAX_IN_FLIGHT },
        () => pacer.beforeRequest('command'),
      ))
      for (const reservation of reservations) {
        pacer.completeRequest(reservation, 200, 'http://127.0.0.1:4312/api/v1/fixture')
      }
    }
    now = SEED_COMMAND_BUDGET_WINDOW_MS - 1
    const next = await pacer.beforeRequest('command')
    expect(waits).toEqual([1])
    expect(pacer.evidence().command).toMatchObject({
      wait_count: 1,
      wait_ms: 1,
      response_to_boundary_elapsed_ms: [SEED_COMMAND_BUDGET_WINDOW_MS],
    })
    pacer.completeRequest(next, 200, 'http://127.0.0.1:4312/api/v1/fixture')
    now += REQUEST_BUDGET_WINDOW_MS - 1
    await pacer.finishAndDrain()
    expect(waits).toEqual([1, 1])
    expect(pacer.evidence().final_drain_ms).toBe(REQUEST_BUDGET_WINDOW_MS)
  })

  it('repeats response-anchored pacing across multiple slow command windows', async () => {
    let now = 0
    const waits: number[] = []
    const pacer = createSeedBudgetPacer({
      now: () => now,
      sleep: async (milliseconds: number) => { waits.push(milliseconds); now += milliseconds },
    })
    const issueWindow = async (count: number) => {
      for (let offset = 0; offset < count; offset += 20) {
        const size = Math.min(20, count - offset)
        const reservations = await Promise.all(Array.from({ length: size }, () => pacer.beforeRequest('command')))
        now += 100
        for (const reservation of reservations) {
          pacer.completeRequest(reservation, 200, 'http://127.0.0.1:4312/api/v1/fixture')
        }
      }
    }

    await issueWindow(SEED_COMMAND_BUDGET_CEILING)
    await issueWindow(SEED_COMMAND_BUDGET_CEILING)
    await issueWindow(1)
    expect(waits).toEqual([SEED_COMMAND_BUDGET_WINDOW_MS, SEED_COMMAND_BUDGET_WINDOW_MS])
    expect(pacer.evidence().command).toMatchObject({
      observed_starts: SEED_COMMAND_BUDGET_CEILING * 2 + 1,
      wait_count: 2,
      wait_ms: SEED_COMMAND_BUDGET_WINDOW_MS * 2,
      response_to_boundary_elapsed_ms: [
        SEED_COMMAND_BUDGET_WINDOW_MS,
        SEED_COMMAND_BUDGET_WINDOW_MS,
      ],
    })
    expect(pacer.evidence().max_in_flight).toBe(SEED_MAX_IN_FLIGHT)
  })

  it('fails closed before fixture concurrency can exceed twenty requests', async () => {
    const pacer = createSeedBudgetPacer()
    const reservations = await Promise.all(Array.from(
      { length: SEED_MAX_IN_FLIGHT },
      () => pacer.beforeRequest('command'),
    ))
    await expect(pacer.beforeRequest('command')).rejects.toThrow(/concurrency exceeds 20/)
    for (const reservation of reservations) {
      pacer.completeRequest(reservation, 200, 'http://127.0.0.1:4312/api/v1/fixture')
    }
    expect(pacer.evidence().max_in_flight).toBe(SEED_MAX_IN_FLIGHT)
  })

  it('fails fixture seeding closed on a hashed 429 without raw request data', async () => {
    let now = 0
    const pacer = createSeedBudgetPacer({ now: () => now })
    const reservation = await pacer.beforeRequest('provider')
    now = 5
    pacer.completeRequest(reservation, 429, 'http://127.0.0.1:4312/api/v1/os/boards/secret/jobs')
    expect(() => pacer.assertHealthy()).toThrow(/operational 429/)
    expect(pacer.evidence()).toMatchObject({
      provider: { observed_starts: 1 },
      rate_limit_response_count: 1,
    })
    expect(pacer.failedRequests()).toEqual([{
      label: 'http_failure',
      status: 429,
      endpoint_sha256: localOwnerChallengeEndpointDigest('/api/v1/os/boards/secret/jobs'),
    }])
    expect(JSON.stringify({ evidence: pacer.evidence(), failures: pacer.failedRequests() }))
      .not.toMatch(/secret|api\/|url|request_id/i)
  })

  it('admits only request-id-bound pre-submit owner challenges and fails post-submit 401 closed', () => {
    const tracker = createLocalOwnerChallengeTracker('http://127.0.0.1:4312')
    tracker.beginLoginCycle()
    expect(tracker.observeRequest('boards-pre', 'http://127.0.0.1:4312/api/v1/boards')).toBe(true)
    expect(tracker.observeRequest('events-pre', 'http://127.0.0.1:4312/api/v1/events')).toBe(true)
    for (const [index, path] of ['/api/v1/system', '/api/v1/os/open-work', '/api/v1/os/devices/self'].entries()) {
      expect(tracker.observeRequest(`competitor-${index}`, `http://127.0.0.1:4312${path}`)).toBe(false)
    }
    expect(tracker.observeRequest('snapshot-pre', 'http://127.0.0.1:4312/api/v1/boards/7/snapshot')).toBe(false)
    expect(tracker.observeRequest('foreign-pre', 'https://example.invalid/api/v1/boards')).toBe(false)
    tracker.closePreSubmitPhase()
    expect(tracker.observeRequest('boards-post', 'http://127.0.0.1:4312/api/v1/boards')).toBe(false)
    expect(tracker.observeResponse('boards-pre', 401).expected).toBe(true)
    expect(tracker.observeResponse('events-pre', 401).expected).toBe(true)
    expect(tracker.observeResponse('snapshot-pre', 401).expected).toBe(false)
    expect(tracker.observeResponse('boards-post', 401).expected).toBe(false)
    const inventory = tracker.inventory()
    expect(inventory).toMatchObject({
      passed: true,
      login_cycles: 1,
      total_count: LOCAL_OWNER_CHALLENGE_PATHS.length,
    })
    expect(inventory.endpoints).toHaveLength(LOCAL_OWNER_CHALLENGE_PATHS.length)
    expect(inventory.endpoints).toEqual(expect.arrayContaining(LOCAL_OWNER_CHALLENGE_PATHS.map((path) => ({
      endpoint_sha256: LOCAL_OWNER_CHALLENGE_DIGESTS[path],
      count: 1,
    }))))
  })

  it('retains an adversarial post-submit 401 as a failed request', () => {
    const tracker = createLocalOwnerChallengeTracker('http://127.0.0.1:4312')
    const authenticationChallenges: any[] = []
    const failedRequests: any[] = []
    tracker.beginLoginCycle()
    tracker.observeRequest('boards-pre', 'http://127.0.0.1:4312/api/v1/boards')
    tracker.closePreSubmitPhase()
    recordLocalOwnerHttpFailure({
      tracker,
      requestId: 'boards-pre',
      status: 401,
      entry: { label: 'http_failure', status: 401 },
      authenticationChallenges,
      failedRequests,
      retain: (target: any[], entry: any) => target.push(entry),
    })
    expect(authenticationChallenges).toHaveLength(1)
    for (const [index, path] of ['/api/v1/system', '/api/v1/os/open-work', '/api/v1/os/devices/self'].entries()) {
      const requestId = `competitor-post-${index}`
      expect(tracker.observeRequest(requestId, `http://127.0.0.1:4312${path}`)).toBe(false)
      recordLocalOwnerHttpFailure({
        tracker,
        requestId,
        status: 401,
        entry: { label: 'http_failure', status: 401 },
        authenticationChallenges,
        failedRequests,
        retain: (target: any[], entry: any) => target.push(entry),
      })
    }
    expect(failedRequests).toEqual(Array.from({ length: 3 }, () => ({ label: 'http_failure', status: 401 })))
  })

  it('rejects a challenge inventory that did not prove every login cycle through boards', () => {
    const tracker = createLocalOwnerChallengeTracker('http://127.0.0.1:4312')
    tracker.beginLoginCycle()
    tracker.observeRequest('events-only', 'http://127.0.0.1:4312/api/v1/events')
    tracker.closePreSubmitPhase()
    expect(tracker.observeResponse('events-only', 401).expected).toBe(true)
    expect(tracker.inventory()).toMatchObject({ passed: false, login_cycles: 1, total_count: 1 })
  })

  it('freezes the desktop, tablet, and phone matrix and all required quality surfaces', () => {
    expect(RESPONSIVE_VIEWPORTS).toEqual([
      { id: 'desktop', width: 1440, height: 1000, mobile: false },
      { id: 'tablet', width: 834, height: 1194, mobile: true },
      { id: 'phone', width: 390, height: 844, mobile: true },
    ])
    expect(ACCESSIBILITY_GATES).toEqual([
      'accessible_names', 'keyboard_focus', 'screen_reader_tree', 'text_contrast',
    ])
    expect(PERFORMANCE_SURFACES).toEqual([
      'startup', 'snapshot_loading', 'transcript_loading', 'graph_view', 'search',
    ])
    expect(BROWSER_JOURNEYS).toEqual([
      'graph overview', 'durable transcript', 'conversation search',
      'work command center view', 'discussions command center view', 'knowledge command center view',
      'outcomes command center view', 'activity command center view',
      'Organization primary view', 'Roadmap primary view', 'Settings primary view', 'Command center primary view',
    ])
  })

  it('caps checked regression bounds with explicit beta experience ceilings', () => {
    expect(BETA_EXPERIENCE_BUDGETS_MS).toEqual({
      startup: 1500, snapshot_loading: 3000, transcript_loading: 3500, graph_view: 1000, search: 750,
    })
    expect(deriveRegressionBudgetMs(25)).toBe(175)
    expect(deriveRegressionBudgetMs(80)).toBe(230)
    expect(deriveRegressionBudgetMs(80, { multiplier: 2, additiveMs: 300 })).toBe(380)
    expect(checkedBudget('snapshot_loading', 2_000)).toEqual({
      budget_ms: 3_000,
      experience_budget_ms: 3_000,
      regression_budget_ms: 4_000,
      budget_source: 'checked_observation',
    })
    expect(() => deriveRegressionBudgetMs(0)).toThrow(/positive finite/)
  })

  it('compacts successful journey evidence while retaining failure diagnostics', () => {
    const journey = passingEvidence().viewports[0].journeys[0]
    journey.interaction_modes.pointer.readiness_asserted = 'x'.repeat(10_000)
    journey.interaction_modes.pointer.action_evidence = { traversal: Array.from({ length: 100 }, (_, index) => index) }
    const escapePath = {
      escape_path: 'Escape+Tab', documented: true, armed: true, advanced: true,
      from: 'Terminal input', to: 'BUTTON:6',
    }
    journey.interaction_modes.keyboard.action_evidence.xterm_escape_paths = [escapePath]
    journey.interaction_modes.keyboard.action_evidence.xterm_focus_encounters = 1
    journey.accessibility.keyboard_focus = {
      passed: true, checked: 20, focus_order: Array.from({ length: 100 }, (_, index) => index),
      xterm_focus_encounters: 1, xterm_escape_paths: [escapePath],
    }
    const compact = compactJourneyEvidence(journey)
    expect(compact.interaction_modes.pointer).not.toHaveProperty('readiness_asserted')
    expect(compact.interaction_modes.pointer).not.toHaveProperty('action_evidence')
    expect(compact.interaction_modes.keyboard.action_evidence.xterm_escape_paths).toEqual([escapePath])
    expect(compact.accessibility.keyboard_focus).toEqual({
      passed: true, checked: 20, xterm_escape_paths: [escapePath], xterm_focus_encounters: 1,
    })

    journey.interaction_modes.pointer.passed = false
    journey.interaction_modes.pointer.error = 'pointer did not activate'
    journey.accessibility.text_contrast = { passed: false, checked: true, violations: [{ ratio: 4.2 }] }
    const failed = compactJourneyEvidence(journey)
    expect(failed.interaction_modes.pointer).toMatchObject({
      passed: false,
      error: 'pointer did not activate',
      readiness_asserted: 'x'.repeat(10_000),
      action_evidence: { traversal: Array.from({ length: 100 }, (_, index) => index) },
    })
    expect(failed.accessibility.text_contrast.violations).toEqual([{ ratio: 4.2 }])

    journey.horizontal_overflow_px = 18
    journey.overflow_measurement = {
      visible_overflow_px: 18,
      document_extent_overflow_px: 21,
      offenders: [{ class_name: 'real-overflow', right: 408 }],
    }
    const overflowFailure = compactJourneyEvidence(journey)
    expect(overflowFailure.overflow_measurement).toEqual(journey.overflow_measurement)

    const matrix = passingEvidence()
    for (const viewport of matrix.viewports) {
      viewport.journeys = viewport.journeys.map((rawJourney: any) => compactJourneyEvidence({
        ...rawJourney,
        horizontal_overflow_px: 0,
        overflow_measurement: { offenders: Array.from({ length: 100 }, (_, index) => ({ index })) },
        interaction_modes: Object.fromEntries(Object.entries(rawJourney.interaction_modes)
          .map(([mode, result]: [string, any]) => [mode, {
            ...result,
            readiness_asserted: 'selector'.repeat(2_000),
            action_evidence: mode === 'keyboard'
              ? { ...result.action_evidence, traversal: Array.from({ length: 500 }, (_, index) => ({ index })) }
              : { payload: 'diagnostic'.repeat(2_000) },
          }])),
        accessibility: Object.fromEntries(ACCESSIBILITY_GATES.map((gate) => [gate, {
          passed: true,
          checked: 250,
          traversal: Array.from({ length: 500 }, (_, index) => ({ index })),
        }])),
      }))
    }
    expect(Buffer.byteLength(JSON.stringify(matrix))).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES)
    expect(matrix.viewports).toHaveLength(3)
    expect(matrix.viewports.every((viewport: any) => viewport.journeys.length === BROWSER_JOURNEYS.length)).toBe(true)
  })

  it('binds every performance budget to the maximum of three retained observations', () => {
    const checked = currentBaseline()
    expect(checked.schema_version).toBe(BROWSER_BASELINE_SCHEMA_VERSION)
    expect(checked.methodology.runs).toBe(3)
    expect(checked.capture_artifacts).toHaveLength(3)
    expect(validatePerformanceBaseline(checked)).toEqual([])
    for (const viewport of checked.viewports) {
      expect(RESPONSIVE_VIEWPORTS.some((candidate) => candidate.id === viewport.id)).toBe(true)
      for (const surface of PERFORMANCE_SURFACES) {
        const metric = viewport.performance[surface as keyof typeof viewport.performance]
        expect(metric.samples_ms).toHaveLength(3)
        expect(metric.observed_p95_ms).toBe(Math.max(...metric.samples_ms))
        expect(metric).toMatchObject(checkedBudget(surface, metric.observed_p95_ms))
      }
    }
  })

  it('rejects missing, non-finite, self-derived, or digest-tampered checked budgets', () => {
    const checked = currentBaseline()
    const missing = structuredClone(checked) as any
    delete missing.viewports[0].performance.search.budget_ms
    missing.sha256 = verifiableDocumentDigest(missing)
    expect(validatePerformanceBaseline(missing)).toContain('baseline desktop search budget_ms is invalid')

    const nonFinite = structuredClone(checked) as any
    nonFinite.viewports[0].performance.search.budget_ms = Number.POSITIVE_INFINITY
    nonFinite.sha256 = verifiableDocumentDigest(nonFinite)
    expect(validatePerformanceBaseline(nonFinite)).toContain('baseline desktop search budget_ms is invalid')

    const selfDerived = structuredClone(checked) as any
    selfDerived.viewports[0].performance.search.budget_source = 'capture_only'
    selfDerived.sha256 = verifiableDocumentDigest(selfDerived)
    expect(validatePerformanceBaseline(selfDerived)).toContain('baseline desktop search budget source is invalid')

    const tampered = structuredClone(checked) as any
    tampered.methodology.runs = 99
    expect(validatePerformanceBaseline(tampered)).toContain('baseline digest is invalid')

    const evidence = passingEvidence()
    delete evidence.viewports[0].performance.search.budget_ms
    evidence.sha256 = verifiableDocumentDigest(evidence)
    expect(validateBrowserQualityEvidence(evidence)).toContain('desktop has invalid search budget provenance')
  })

  it('recomputes samples, p95, and budgets from captures so a self-digested edit cannot pass', () => {
    const captures = [observation1, observation2, observation3] as any[]
    const checked = currentBaseline()
    expect(validateBaselineAgainstCaptures(checked, captures)).toEqual([])
    const exploit = structuredClone(checked) as any
    const metric = exploit.viewports[0].performance.search
    metric.samples_ms = metric.samples_ms.map((sample: number) => sample + 10)
    metric.observed_p95_ms = Math.max(...metric.samples_ms)
    Object.assign(metric, checkedBudget('search', metric.observed_p95_ms))
    exploit.sha256 = verifiableDocumentDigest(exploit)
    expect(validatePerformanceBaseline(exploit)).toEqual([])
    expect(validateBaselineAgainstCaptures(exploit, captures)).toEqual(expect.arrayContaining([
      'baseline desktop search samples do not match captures',
      'baseline desktop search p95 does not match captures',
    ]))
  })

  it('never permits DOM fallback timing to enter retained performance samples', () => {
    const interactionModes = {
      pointer: { elapsed_ms: 137, performance_eligible: true, passed: true },
      keyboard: { elapsed_ms: 211, performance_eligible: false },
      dom_fallback: { elapsed_ms: 1, performance_eligible: false, diagnostic_only: true },
    }
    expect(performanceSampleForJourney(interactionModes)).toBe(137)
    interactionModes.dom_fallback.elapsed_ms = 99_999
    expect(performanceSampleForJourney(interactionModes)).toBe(137)
    interactionModes.dom_fallback.performance_eligible = true
    expect(() => performanceSampleForJourney(interactionModes)).toThrow(/diagnostic-only/)
    interactionModes.dom_fallback.performance_eligible = false
    interactionModes.pointer.passed = false
    expect(() => performanceSampleForJourney(interactionModes)).toThrow(/failed pointer/)
  })

  it('rejects dirty or stale source identity before trusting build artifacts', () => {
    const manifest = {
      repository: 'agentboard',
      source_status: 'clean', source_commit: 'a'.repeat(40), source_tree_sha256: 'b'.repeat(64),
      source_checked_at: '2026-08-02T10:00:00.000Z', artifacts_built_at: '2026-08-02T10:00:01.000Z',
    }
    expect(validateBuildSourceIdentity(manifest, {
      repository: 'agentboard',
      source_status: 'clean', source_commit: manifest.source_commit, source_tree_sha256: manifest.source_tree_sha256,
    })).toEqual([])
    expect(validateBuildSourceIdentity(manifest, {
      repository: 'agentboard',
      source_status: 'dirty', source_commit: manifest.source_commit, source_tree_sha256: manifest.source_tree_sha256,
    })).toContain('tracked source tree is dirty')
    expect(validateBuildSourceIdentity(manifest, {
      repository: 'linked-worktree-name',
      source_status: 'clean', source_commit: manifest.source_commit, source_tree_sha256: manifest.source_tree_sha256,
    })).toContain('build manifest repository identity is stale')
    expect(validateBuildSourceIdentity(manifest, {
      repository: 'agentboard',
      source_status: 'clean', source_commit: 'f'.repeat(40), source_tree_sha256: manifest.source_tree_sha256,
    })).toContain('build manifest source commit is stale')
    expect(validateArtifactIdentity({ artifact_identity: {
      root_dist_sha256: 'c'.repeat(64), web_dist_sha256: 'd'.repeat(64),
    } }, {
      root_dist_sha256: 'c'.repeat(64), web_dist_sha256: 'e'.repeat(64),
    })).toContain('build artifact web_dist_sha256 digest is stale')
    expect(validateArtifactIdentity({ artifact_identity: {
      root_dist_sha256: 'c'.repeat(64), web_dist_sha256: 'd'.repeat(64),
    } }, {
      root_dist_sha256: 'e'.repeat(64), web_dist_sha256: 'd'.repeat(64),
    })).toContain('build artifact root_dist_sha256 digest is stale')
    expect(canonicalRepositoryName('/workspace/agentboard/.git')).toBe('agentboard')
    expect(canonicalRepositoryName('/workspace/agentboard.git')).toBe('agentboard.git')
    const commonDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: process.cwd(), encoding: 'utf8',
    })
    expect(commonDir.status).toBe(0)
    expect(canonicalRepositoryName(commonDir.stdout.trim())).toBe('agentboard')
  })

  it('confines retained observations to real non-symlink files in the approved directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-evidence-path-'))
    try {
      const approved = join(root, 'docs', 'qa-evidence', 'browser-quality')
      mkdirSync(approved, { recursive: true })
      writeFileSync(join(approved, 'capture.json'), '{}')
      writeFileSync(join(root, 'docs', 'qa-evidence', 'not-approved.json'), '{}')
      symlinkSync(join(approved, 'capture.json'), join(approved, 'linked.json'))
      expect(resolveApprovedEvidencePath(root, 'docs/qa-evidence/browser-quality/capture.json'))
        .toBe(realpathSync(join(approved, 'capture.json')))
      expect(() => resolveApprovedEvidencePath(root, 'docs/qa-evidence/browser-quality/linked.json')).toThrow(/symlink/)
      expect(() => resolveApprovedEvidencePath(root, 'docs/qa-evidence/not-approved.json')).toThrow(/outside/)
      expect(() => resolveApprovedEvidencePath(root, join(approved, 'capture.json'))).toThrow(/relative/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('confines runtime artifacts to the canonical root and writes them atomically', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-runtime-artifact-'))
    try {
      const approved = join(root, 'artifacts', 'qa', 'browser-quality')
      mkdirSync(approved, { recursive: true })
      const target = join(approved, 'evidence.json')
      expect(resolveApprovedArtifactPath(root, target)).toBe(join(realpathSync(root), 'artifacts', 'qa', 'browser-quality', 'evidence.json'))
      expect(() => resolveApprovedArtifactPath(root, join(root, 'outside.json'))).toThrow(/outside/)
      writeBrowserArtifact(root, target, { status: 'first' })
      expect(() => writeBrowserArtifact(root, target, { invalid: 1n })).toThrow()
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ status: 'first' })
      const oversized = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [
        `field_${index}`, 'x'.repeat(EVIDENCE_MAX_STRING_LENGTH),
      ]))
      expect(() => writeBrowserArtifact(root, target, oversized)).toThrow(/bounded retention size/)
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ status: 'first' })
      writeBrowserArtifact(root, target, { status: 'replacement' })
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ status: 'replacement' })
      expect(readdirSync(approved)).toEqual(['evidence.json'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects symlinked artifact parents and existing symlink targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-runtime-symlink-'))
    try {
      const approved = join(root, 'artifacts', 'qa', 'browser-quality')
      const outside = join(root, 'outside')
      mkdirSync(approved, { recursive: true })
      mkdirSync(outside)
      writeFileSync(join(outside, 'target.json'), '{}')
      symlinkSync(outside, join(approved, 'linked-parent'))
      symlinkSync(join(outside, 'target.json'), join(approved, 'linked-target.json'))
      expect(() => resolveApprovedArtifactPath(root, join(approved, 'linked-parent', 'capture.json'))).toThrow(/symlink/)
      expect(() => resolveApprovedArtifactPath(root, join(approved, 'linked-target.json'))).toThrow(/symlink/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects absolute artifact CLI arguments before any write', () => {
    const absoluteOutput = join(process.cwd(), 'artifacts', 'qa', 'browser-quality', 'absolute-rejected.json')
    rmSync(absoluteOutput, { force: true })
    const result = spawnSync(process.execPath, [
      'scripts/qa-browser-gates.mjs', '--capture-only', '--output', absoluteOutput,
    ], { cwd: process.cwd(), encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--output must be repository-relative')
    expect(existsSync(absoluteOutput)).toBe(false)
  })

  it('rejects output and manifest aliases before they can overwrite provenance', () => {
    const artifactRootRelative = join('artifacts', 'qa', 'browser-quality')
    const artifactRoot = join(process.cwd(), artifactRootRelative)
    const manifestRelative = join(artifactRootRelative, 'adversarial-alias-manifest.json')
    const manifest = join(process.cwd(), manifestRelative)
    const symlinkRelative = join(artifactRootRelative, 'adversarial-alias-link.json')
    const symlink = join(process.cwd(), symlinkRelative)
    const writeAliasRelative = join(artifactRootRelative, 'adversarial-write-alias.json')
    const writeAlias = join(process.cwd(), writeAliasRelative)
    const caseManifestRelative = join(artifactRootRelative, 'Adversarial-Case-Manifest.JSON')
    const caseManifest = join(process.cwd(), caseManifestRelative)
    const caseOutputRelative = join(artifactRootRelative, 'adversarial-case-manifest.json')
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(manifest, '{}')
    symlinkSync(manifest, symlink)
    try {
      const samePath = spawnSync(process.execPath, [
        'scripts/qa-browser-gates.mjs', '--capture-only',
        '--artifact-manifest', manifestRelative, '--output', manifestRelative,
      ], { cwd: process.cwd(), encoding: 'utf8' })
      expect(samePath.status).not.toBe(0)
      expect(samePath.stderr).toContain('must resolve to distinct files')
      expect(readFileSync(manifest, 'utf8')).toBe('{}')

      const symlinkAlias = spawnSync(process.execPath, [
        'scripts/qa-browser-gates.mjs', '--capture-only',
        '--artifact-manifest', manifestRelative, '--output', symlinkRelative,
      ], { cwd: process.cwd(), encoding: 'utf8' })
      expect(symlinkAlias.status).not.toBe(0)
      expect(symlinkAlias.stderr).toContain('may not use symlink components')
      expect(readFileSync(manifest, 'utf8')).toBe('{}')

      writeFileSync(writeAlias, '{"retained":true}')
      const writeModeAlias = spawnSync(process.execPath, [
        'scripts/qa-browser-gates.mjs', '--output', writeAliasRelative,
        '--write-artifact-manifest', writeAliasRelative,
      ], { cwd: process.cwd(), encoding: 'utf8' })
      expect(writeModeAlias.status).not.toBe(0)
      expect(writeModeAlias.stderr).toContain('must resolve to distinct files')
      expect(readFileSync(writeAlias, 'utf8')).toBe('{"retained":true}')

      writeFileSync(caseManifest, '{"case_retained":true}')
      const caseFoldAlias = spawnSync(process.execPath, [
        'scripts/qa-browser-gates.mjs', '--capture-only',
        '--artifact-manifest', caseManifestRelative, '--output', caseOutputRelative,
      ], { cwd: process.cwd(), encoding: 'utf8' })
      expect(caseFoldAlias.status).not.toBe(0)
      expect(caseFoldAlias.stderr).toContain('must resolve to distinct files')
      expect(readFileSync(caseManifest, 'utf8')).toBe('{"case_retained":true}')
    } finally {
      rmSync(symlink, { force: true })
      rmSync(manifest, { force: true })
      rmSync(writeAlias, { force: true })
      rmSync(caseManifest, { force: true })
      rmSync(join(process.cwd(), caseOutputRelative), { force: true })
    }
  })

  it('redacts nested credentials, bearer values, assignments, and URL credentials before artifacts', () => {
    const redacted = redactEvidence({
      authorization: 'Bearer top-secret',
      nested: {
        message: 'ORCHESTRA_TOKEN=abc123 GET /?token=url-secret&safe=1',
        safe: 'job-123',
      },
    })
    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      nested: {
        message: 'ORCHESTRA_TOKEN=[REDACTED] GET /?token=[REDACTED]&safe=1',
        safe: 'job-123',
      },
    })
    expect(evidenceDigest(redacted)).toMatch(/^[a-f0-9]{64}$/)
    expect(redactEvidence('x'.repeat(EVIDENCE_MAX_STRING_LENGTH + 10))).toHaveLength(EVIDENCE_MAX_STRING_LENGTH)
    expect(redactEvidence(Array.from({ length: EVIDENCE_MAX_ARRAY_LENGTH + 10 }, (_, index) => index)))
      .toHaveLength(EVIDENCE_MAX_ARRAY_LENGTH)
    expect(redactEvidence('password: abc API_key=mixed Cookie=session Authorization=BasicValue https://user:pass@example.test')).toBe(
      'password=[REDACTED] API_key=[REDACTED] Cookie=[REDACTED] Authorization=[REDACTED] https://[REDACTED]@example.test',
    )
  })

  it('calculates WCAG contrast ratios after alpha-compositing foregrounds', () => {
    expect(contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)')).toBeCloseTo(21, 5)
    expect(contrastRatio('rgb(119, 119, 119)', 'rgb(255, 255, 255)')).toBeCloseTo(4.478, 2)
    expect(contrastRatio('rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)')).toBeCloseTo(3.977, 2)
    expect(compositeRgba('rgba(255, 255, 255, 0.5)', 'rgb(0, 0, 0)')).toEqual({
      red: 127.5, green: 127.5, blue: 127.5, alpha: 1,
    })
    expect(contrastRatio('rgba(0, 0, 0, 0.5)', 'rgba(255, 255, 255, 0.5)')).toBeNull()
  })

  it('fails closed when a viewport, accessibility gate, performance surface, or redaction is absent', () => {
    const complete = passingEvidence()
    expect(validateBrowserQualityEvidence(complete)).toEqual([])

    const incomplete = structuredClone(complete)
    incomplete.viewports = incomplete.viewports.filter((viewport) => viewport.id !== 'tablet')
    incomplete.viewports[0].horizontal_overflow_px = 4
    incomplete.viewports[0].accessibility.keyboard_focus.passed = false
    delete incomplete.viewports[0].performance.search
    delete incomplete.viewports[1].performance.graph_view.quality_gate_passed
    delete incomplete.source.source_tree_sha256
    ;(incomplete as any).token = 'unsafe'
    incomplete.sha256 = verifiableDocumentDigest(incomplete)

    expect(validateBrowserQualityEvidence(incomplete)).toEqual(expect.arrayContaining([
      'missing tablet viewport',
      'desktop has horizontal overflow',
      'desktop failed keyboard_focus',
      'desktop is missing search performance evidence',
      'phone graph_view is missing quality-linked performance status',
      'evidence source binding is incomplete',
      'evidence contains secret-shaped fields or values',
    ]))
  })

  it('rejects forged request-budget pacing provenance after self-digesting', () => {
    const mutations = [
      (evidence: any) => { delete evidence.request_budget_pacing },
      (evidence: any) => { evidence.request_budget_pacing.observed_request_starts = 0 },
      (evidence: any) => {
        evidence.request_budget_pacing.observed_request_starts = RESPONSIVE_VIEWPORTS.length
          * LOCAL_OWNER_CHALLENGE_PATHS.length * EXPECTED_BROWSER_LOGIN_CYCLES - 1
      },
      (evidence: any) => { evidence.request_budget_pacing.window_ms = 59_999 },
      (evidence: any) => { evidence.request_budget_pacing.ceiling = 801 },
      (evidence: any) => { evidence.request_budget_pacing.reserve = 199 },
      (evidence: any) => { evidence.request_budget_pacing.max_lifecycle_request_starts = 201 },
      (evidence: any) => { evidence.request_budget_pacing.max_lifecycle_request_starts = 1 },
      (evidence: any) => { evidence.request_budget_pacing.rate_limit_response_count = 1 },
      (evidence: any) => {
        evidence.request_budget_pacing.wait_count = 0
        evidence.request_budget_pacing.total_wait_ms = 1
      },
      (evidence: any) => { evidence.request_budget_pacing.url = '/api/v1/boards' },
    ]
    for (const mutate of mutations) {
      const evidence = passingEvidence()
      mutate(evidence)
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence))
        .toContain('request budget pacing provenance is invalid')
    }
  })

  it('rejects re-digested impossible seed-budget provenance', () => {
    const mutations = [
      (evidence: any) => { delete evidence.seed_budget_pacing },
      (evidence: any) => { evidence.seed_budget_pacing.request.observed_starts = 274 },
      (evidence: any) => { evidence.seed_budget_pacing.request.completed_responses = 274 },
      (evidence: any) => { evidence.seed_budget_pacing.command.observed_starts = 274 },
      (evidence: any) => { evidence.seed_budget_pacing.provider.observed_starts = 0 },
      (evidence: any) => { evidence.seed_budget_pacing.request.window_ms = 59_999 },
      (evidence: any) => { evidence.seed_budget_pacing.command.ceiling = 201 },
      (evidence: any) => { evidence.seed_budget_pacing.command.reserve = 39 },
      (evidence: any) => { evidence.seed_budget_pacing.command.limit = 239 },
      (evidence: any) => { evidence.seed_budget_pacing.provider.ceiling = 51 },
      (evidence: any) => { evidence.seed_budget_pacing.provider.reserve = 9 },
      (evidence: any) => {
        evidence.seed_budget_pacing.command.wait_count = 0
        evidence.seed_budget_pacing.command.wait_ms = 0
      },
      (evidence: any) => {
        evidence.seed_budget_pacing.request.wait_count = 1
        evidence.seed_budget_pacing.request.wait_ms = 60_000
      },
      (evidence: any) => {
        evidence.seed_budget_pacing.command.wait_count = 1
        evidence.seed_budget_pacing.command.wait_ms = 1
        evidence.seed_budget_pacing.command.response_to_boundary_elapsed_ms = [1]
      },
      (evidence: any) => { evidence.seed_budget_pacing.final_drain_ms = 1 },
      (evidence: any) => { evidence.seed_budget_pacing.final_drain_ms = 0 },
      (evidence: any) => { evidence.seed_budget_pacing.max_in_flight = 21 },
      (evidence: any) => { evidence.seed_budget_pacing.rate_limit_response_count = 1 },
      (evidence: any) => { evidence.seed_budget_pacing.command.url = '/api/v1/private' },
      (evidence: any) => { evidence.scenario.transcript_events = 249 },
      (evidence: any) => { evidence.scenario.graph_agents = 17 },
    ]
    for (const mutate of mutations) {
      const evidence = passingEvidence()
      mutate(evidence)
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence))
        .toContain('seed budget pacing provenance is invalid')
    }
  })

  it('accepts exact response-boundary elapsed provenance despite a one-ms recorded sleep', () => {
    const evidence = passingEvidence()
    evidence.seed_budget_pacing.command.wait_count = 1
    evidence.seed_budget_pacing.command.wait_ms = 1
    evidence.seed_budget_pacing.command.response_to_boundary_elapsed_ms = [SEED_COMMAND_BUDGET_WINDOW_MS]
    evidence.seed_budget_pacing.final_drain_ms = REQUEST_BUDGET_WINDOW_MS
    evidence.sha256 = verifiableDocumentDigest(evidence)
    expect(validateBrowserQualityEvidence(evidence)).toEqual([])
  })

  it('rejects missing, mismatched, duplicate, or unknown authentication challenge evidence', () => {
    const mutations = [
      (viewport: any) => { delete viewport.authentication_challenge_inventory },
      (viewport: any) => {
        viewport.authentication_challenge_inventory.endpoints[0].count = 0
        viewport.authentication_challenge_inventory.total_count = 1
      },
      (viewport: any) => {
        viewport.authentication_challenge_inventory.endpoints[1]
          = { ...viewport.authentication_challenge_inventory.endpoints[0] }
      },
      (viewport: any) => { viewport.authentication_challenges[0].endpoint_sha256 = 'f'.repeat(64) },
      (viewport: any) => { viewport.authentication_challenges.pop() },
      (viewport: any) => { viewport.authentication_challenge_inventory.login_cycles = 1 },
    ]
    for (const mutate of mutations) {
      const evidence = passingEvidence()
      mutate(evidence.viewports[0])
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence))
        .toContain('desktop has invalid authentication challenge inventory')
    }
  })

  it('rejects stale, reused, or internally inconsistent startup navigation provenance', () => {
    const inconsistent = passingEvidence()
    inconsistent.viewports[0].performance.startup.provenance.command_center_ready_ms = 9
    inconsistent.sha256 = verifiableDocumentDigest(inconsistent)
    expect(validateBrowserQualityEvidence(inconsistent)).toContain('desktop has invalid startup navigation provenance')

    const mismatchedSnapshot = passingEvidence()
    mismatchedSnapshot.viewports[0].performance.startup.provenance.snapshot_resource_ms = 8
    mismatchedSnapshot.sha256 = verifiableDocumentDigest(mismatchedSnapshot)
    expect(validateBrowserQualityEvidence(mismatchedSnapshot))
      .toContain('desktop has invalid startup navigation provenance')

    const reused = passingEvidence()
    reused.viewports[1].performance.startup.provenance.loader_sha256
      = reused.viewports[0].performance.startup.provenance.loader_sha256
    reused.viewports[1].performance.startup.provenance.time_origin_ms
      = reused.viewports[0].performance.startup.provenance.time_origin_ms
    reused.sha256 = verifiableDocumentDigest(reused)
    expect(validateBrowserQualityEvidence(reused)).toContain('startup navigation provenance is not unique across viewports')
  })

  it('rejects missing, duplicate, extra, completed, or in-flight competitor startup evidence', () => {
    const mutations = [
      (timing: any) => {
        timing.critical_resources = timing.critical_resources.filter((entry: any) => entry.category !== 'jobs')
        timing.critical_resource_count = timing.critical_resources.length
      },
      (timing: any) => {
        timing.critical_resources.push({
          category: 'unknown',
          route_sha256: evidenceDigest('unknown-route'),
          endpoint_sha256: evidenceDigest('unknown-endpoint'),
          start_ms: 7,
          response_end_ms: 8,
          duration_ms: 1,
        })
        timing.critical_resource_count = timing.critical_resources.length
      },
      (timing: any) => {
        timing.critical_resources.push({ ...timing.critical_resources[0] })
        timing.critical_resource_count = timing.critical_resources.length
      },
      (timing: any) => {
        timing.competitor_resources.push({
          category: 'system',
          route_sha256: STARTUP_COMPETITOR_RESOURCE_ROUTE_DIGESTS.system,
          endpoint_sha256: evidenceDigest('system-endpoint'),
          start_ms: 7,
          response_end_ms: 8,
          duration_ms: 1,
        })
        timing.competitor_resource_count = 1
      },
      (timing: any) => { timing.critical_resources[0].url = '/api/v1/boards?raw=id' },
      (timing: any) => {
        timing.competitor_request_starts.push({
          category: 'device_self',
          route_sha256: STARTUP_COMPETITOR_RESOURCE_ROUTE_DIGESTS.device_self,
          endpoint_sha256: evidenceDigest('device-self-endpoint'),
          request_sha256: evidenceDigest('in-flight-request-id'),
          start_offset_ms: 2,
        })
        timing.competitor_request_start_count = 1
      },
      (timing: any) => {
        timing.competitor_resources.push({
          category: 'open_work',
          route_sha256: STARTUP_COMPETITOR_RESOURCE_ROUTE_DIGESTS.open_work,
          endpoint_sha256: evidenceDigest('open-work-endpoint'),
          start_ms: 7,
          response_end_ms: 12,
          duration_ms: 5,
        })
        timing.competitor_resource_count = 1
      },
    ]
    for (const mutate of mutations) {
      const evidence = passingEvidence()
      mutate(evidence.viewports[0].performance.startup.provenance.resource_timing)
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence))
        .toContain('desktop has invalid startup navigation provenance')
    }
  })

  it('rejects zero or unbound CDP competitor request windows after self-digesting', () => {
    for (const mutate of [
      (provenance: any) => { provenance.resource_timing.competitor_request_window_ms = 0 },
      (provenance: any) => {
        provenance.resource_timing.competitor_request_window_ms
          = provenance.submit_to_data_ready_ms + STARTUP_CDP_WINDOW_OVERHEAD_TOLERANCE_MS + 1
      },
    ]) {
      const evidence = passingEvidence()
      mutate(evidence.viewports[0].performance.startup.provenance)
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence))
        .toContain('desktop has invalid startup navigation provenance')
    }
  })

  it('rejects impossible supported long-task summaries after self-digesting', () => {
    for (const summary of [
      { supported: true, count: 1, total_duration_ms: 0, max_duration_ms: 0 },
      { supported: true, count: 1, total_duration_ms: 49, max_duration_ms: 49 },
      { supported: true, count: 2, total_duration_ms: 99, max_duration_ms: 50 },
    ]) {
      const evidence = passingEvidence()
      evidence.viewports[0].performance.startup.provenance.resource_timing.long_tasks = summary
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence))
        .toContain('desktop has invalid startup navigation provenance')
    }
  })

  it('accepts the explicit CDP overhead and long-task definition boundaries', () => {
    const evidence = passingEvidence()
    const provenance = evidence.viewports[0].performance.startup.provenance
    provenance.resource_timing.competitor_request_window_ms
      = provenance.submit_to_data_ready_ms + STARTUP_CDP_WINDOW_OVERHEAD_TOLERANCE_MS
    provenance.resource_timing.long_tasks = {
      supported: true,
      count: 2,
      total_duration_ms: 100,
      max_duration_ms: 50,
    }
    evidence.sha256 = verifiableDocumentDigest(evidence)
    expect(validateBrowserQualityEvidence(evidence)).toEqual([])
  })

  it('rejects an xterm escape claim that did not prove documented focus advancement', () => {
    const evidence = passingEvidence()
    evidence.viewports[0].journeys[0].accessibility.keyboard_focus.xterm_focus_encounters = 1
    evidence.viewports[0].journeys[0].accessibility.keyboard_focus.xterm_escape_paths = [{
      escape_path: 'Escape+Tab', documented: true, armed: true, advanced: false,
      from: 'Terminal input', to: 'Terminal input',
    }]
    evidence.sha256 = verifiableDocumentDigest(evidence)
    expect(validateBrowserQualityEvidence(evidence))
      .toContain('desktop graph overview has invalid xterm keyboard escape evidence')
  })

  it('rejects xterm encounters whose escape path evidence was deleted', () => {
    for (const evidenceSource of ['action', 'audit']) {
      const evidence = passingEvidence()
      const journey = evidence.viewports[0].journeys[0]
      const source = evidenceSource === 'action'
        ? journey.interaction_modes.keyboard.action_evidence
        : journey.accessibility.keyboard_focus
      source.xterm_focus_encounters = 1
      source.xterm_escape_paths = []
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence))
        .toContain('desktop graph overview has invalid xterm keyboard escape evidence')
    }
  })

  it('rejects duplicate, missing, or unknown canonical journeys', () => {
    for (const mutate of [
      (evidence: any) => { evidence.viewports[0].journeys.pop() },
      (evidence: any) => { evidence.viewports[0].journeys[11].name = evidence.viewports[0].journeys[0].name },
      (evidence: any) => { evidence.viewports[0].journeys[11].name = 'invented journey' },
      (evidence: any) => { evidence.viewports[0].journeys.reverse() },
    ]) {
      const evidence = passingEvidence()
      mutate(evidence)
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence)).toContain('desktop journey inventory is not exact and unique')
    }
  })

  it('rejects negative or non-finite overflow claims', () => {
    for (const mutate of [
      (viewport: any) => { viewport.horizontal_overflow_px = -1; viewport.overflow_measurement.visible_overflow_px = -1 },
      (viewport: any) => { viewport.overflow_measurement.document_extent_overflow_px = -1 },
      (viewport: any) => { viewport.horizontal_overflow_px = Number.NaN; viewport.overflow_measurement.visible_overflow_px = Number.NaN },
      (viewport: any) => { viewport.horizontal_overflow_px = Number.POSITIVE_INFINITY; viewport.overflow_measurement.visible_overflow_px = Number.POSITIVE_INFINITY },
      (viewport: any) => { viewport.horizontal_overflow_px = 0.5; viewport.overflow_measurement.visible_overflow_px = 0.5 },
    ]) {
      const evidence = passingEvidence()
      mutate(evidence.viewports[0])
      evidence.sha256 = verifiableDocumentDigest(evidence)
      expect(validateBrowserQualityEvidence(evidence)).toContain('desktop has invalid overflow measurement provenance')
    }
  })

  it('rejects self-digested evidence that exceeds bounded retention limits', () => {
    const evidence = passingEvidence()
    evidence.viewports[0].journeys[0].interaction_modes.pointer.error = 'x'.repeat(EVIDENCE_MAX_STRING_LENGTH + 1)
    evidence.sha256 = verifiableDocumentDigest(evidence)
    expect(validateBrowserQualityEvidence(evidence)).toContain('evidence exceeds bounded retention limits')
    const oversized = passingEvidence()
    oversized.extra = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [
      `field_${index}`, 'x'.repeat(EVIDENCE_MAX_STRING_LENGTH),
    ]))
    oversized.sha256 = verifiableDocumentDigest(oversized)
    expect(validateBrowserQualityEvidence(oversized)).toContain('evidence exceeds bounded retention limits')
    expect(EVIDENCE_MAX_BYTES).toBe(512 * 1024)
  })

  it('rejects missing, forged, or reused mode navigation isolation', () => {
    for (const mutate of [
      (journey: any) => { delete journey.interaction_modes.keyboard.reset },
      (journey: any) => { journey.interaction_modes.pointer.reset.strategy = 'dom_setup' },
      (journey: any) => {
        journey.interaction_modes.keyboard.reset.loader_sha256 = journey.interaction_modes.pointer.reset.loader_sha256
      },
    ]) {
      const evidence = passingEvidence()
      mutate(evidence.viewports[0].journeys[0])
      evidence.sha256 = verifiableDocumentDigest(evidence)
      const errors = validateBrowserQualityEvidence(evidence)
      expect(errors.some((error) => error.includes('fresh navigation isolation')
        || error.includes('unique page lifecycles'))).toBe(true)
    }
  })

  it('rejects startup provenance without a synchronized initial document boundary', () => {
    const evidence = passingEvidence()
    evidence.viewports[0].performance.startup.provenance.navigation_synchronization.time_origin_changed = false
    evidence.sha256 = verifiableDocumentDigest(evidence)
    expect(validateBrowserQualityEvidence(evidence))
      .toContain('desktop has invalid startup navigation provenance')
  })

  it('creates 36 distinct page loaders for the exact journey and mode inventory', async () => {
    const navigations: string[] = []
    let readinessChecks = 0
    let currentHref = 'about:blank'
    let currentLoader = 'initial-loader'
    let timeOrigin = 1_000
    const listeners = new Map<string, Set<(event: any) => void>>()
    const emit = (method: string, event: any) => {
      for (const listener of listeners.get(method) ?? []) listener(event)
    }
    const client = {
      on(method: string, listener: (event: any) => void) {
        const methodListeners = listeners.get(method) ?? new Set()
        methodListeners.add(listener)
        listeners.set(method, methodListeners)
        return () => methodListeners.delete(listener)
      },
      async send(method: string, params: any = {}) {
        if (method === 'Page.setLifecycleEventsEnabled') return {}
        if (method === 'Runtime.evaluate') return { result: { value: {
          href: currentHref, time_origin_ms: timeOrigin, document_complete: true,
        } } }
        if (method === 'Page.getFrameTree') return {
          frameTree: { frame: { loaderId: currentLoader, url: currentHref } },
        }
        expect(method).toBe('Page.navigate')
        navigations.push(params.url)
        currentHref = new URL(params.url).href
        currentLoader = `loader-${navigations.length}`
        timeOrigin += 10
        emit('Page.frameNavigated', { frame: { loaderId: currentLoader, url: currentHref } })
        emit('Page.lifecycleEvent', { name: 'load', loaderId: currentLoader })
        return { loaderId: currentLoader }
      },
    }
    const resets = []
    for (const journey of BROWSER_JOURNEYS) {
      for (const mode of ['pointer', 'keyboard', 'dom_fallback']) {
        resets.push(await navigateFreshInteractionMode({
          client,
          url: `http://127.0.0.1/?journey=${encodeURIComponent(journey)}&mode=${mode}`,
          name: journey,
          mode,
          waitForReady: async () => { readinessChecks += 1 },
        }))
      }
    }
    expect(navigations).toHaveLength(36)
    expect(new Set(navigations)).toHaveLength(36)
    expect(readinessChecks).toBe(36)
    expect(new Set(resets.map((reset) => reset.loader_sha256))).toHaveLength(36)
    expect(resets.every((reset) => reset.strategy === 'fresh_page_navigation')).toBe(true)
    expect(resets.every((reset) => reset.navigation_synchronization.main_frame_loader_matched)).toBe(true)
    expect([...listeners.values()].every((methodListeners) => methodListeners.size === 0)).toBe(true)
  })

  it.each(['before', 'after'])('synchronizes lifecycle events delivered %s Page.navigate resolves', async (timing) => {
    const expectedUrl = 'http://127.0.0.1:4747/?journey=settings&mode=keyboard'
    const expectedLoader = 'new-main-loader'
    let currentHref = 'http://127.0.0.1:4747/?retiring=settings'
    let currentLoader = 'retiring-loader'
    let timeOrigin = 1_000
    let navigationResolved = false
    let emitted = false
    let readinessChecks = 0
    let fakeNow = 0
    const listeners = new Map<string, Set<(event: any) => void>>()
    const emitLifecycle = () => {
      if (emitted) return
      emitted = true
      currentHref = new URL(expectedUrl).href
      currentLoader = expectedLoader
      timeOrigin = 2_000
      for (const listener of listeners.get('Page.frameNavigated') ?? []) {
        listener({ frame: { loaderId: expectedLoader, url: currentHref } })
      }
      for (const listener of listeners.get('Page.lifecycleEvent') ?? []) {
        listener({ name: 'load', loaderId: expectedLoader })
      }
    }
    const client = {
      on(method: string, listener: (event: any) => void) {
        const methodListeners = listeners.get(method) ?? new Set()
        methodListeners.add(listener)
        listeners.set(method, methodListeners)
        return () => methodListeners.delete(listener)
      },
      async send(method: string, params: any = {}) {
        if (method === 'Page.setLifecycleEventsEnabled') return {}
        if (method === 'Runtime.evaluate') return { result: { value: {
          href: currentHref, time_origin_ms: timeOrigin, document_complete: true,
        } } }
        if (method === 'Page.navigate') {
          expect(params.url).toBe(expectedUrl)
          if (timing === 'before') emitLifecycle()
          navigationResolved = true
          return { loaderId: expectedLoader }
        }
        if (method === 'Page.getFrameTree') {
          expect(navigationResolved).toBe(true)
          if (timing === 'after') emitLifecycle()
          return { frameTree: { frame: { loaderId: currentLoader, url: currentHref } } }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }
    const result = await navigateFreshInteractionMode({
      client,
      url: expectedUrl,
      name: 'Settings primary view',
      mode: 'keyboard',
      waitForReady: async () => { readinessChecks += 1 },
      now: () => fakeNow,
      sleep: async (milliseconds: number) => { fakeNow += milliseconds },
      synchronizationTimeoutMs: 100,
    })
    expect(readinessChecks).toBe(1)
    expect(result.navigation_synchronization).toMatchObject({
      main_frame_loader_matched: true,
      location_matched: true,
      time_origin_changed: true,
      document_complete: true,
      load_event_observed: true,
    })
    expect([...listeners.values()].every((methodListeners) => methodListeners.size === 0)).toBe(true)
  })

  it('does not let a stale retiring document pass readiness', async () => {
    const expectedUrl = 'http://127.0.0.1:4747/?journey=settings&mode=keyboard'
    const expectedHref = new URL(expectedUrl).href
    const expectedLoader = 'new-main-loader'
    let boundaryReads = 0
    let readinessChecks = 0
    let fakeNow = 0
    const listeners = new Map<string, Set<(event: any) => void>>()
    const client = {
      on(method: string, listener: (event: any) => void) {
        const methodListeners = listeners.get(method) ?? new Set()
        methodListeners.add(listener)
        listeners.set(method, methodListeners)
        return () => methodListeners.delete(listener)
      },
      async send(method: string, params: any = {}) {
        if (method === 'Page.setLifecycleEventsEnabled') return {}
        if (method === 'Runtime.evaluate') {
          boundaryReads += 1
          const isNewDocument = boundaryReads >= 4
          return { result: { value: {
            href: isNewDocument ? expectedHref : 'http://127.0.0.1:4747/?retiring=settings',
            time_origin_ms: isNewDocument ? 2_000 : 1_000,
            document_complete: true,
          } } }
        }
        if (method === 'Page.navigate') {
          for (const listener of listeners.get('Page.frameNavigated') ?? []) {
            listener({ frame: { loaderId: expectedLoader, url: expectedHref } })
          }
          for (const listener of listeners.get('Page.lifecycleEvent') ?? []) {
            listener({ name: 'load', loaderId: expectedLoader })
          }
          return { loaderId: expectedLoader }
        }
        if (method === 'Page.getFrameTree') return {
          frameTree: { frame: { loaderId: expectedLoader, url: expectedHref } },
        }
        throw new Error(`unexpected method ${method}`)
      },
    }
    await navigateFreshInteractionMode({
      client,
      url: expectedUrl,
      name: 'Settings primary view',
      mode: 'keyboard',
      waitForReady: async () => { readinessChecks += 1 },
      now: () => fakeNow,
      sleep: async (milliseconds: number) => { fakeNow += milliseconds },
      synchronizationTimeoutMs: 100,
    })
    expect(boundaryReads).toBe(4)
    expect(readinessChecks).toBe(1)
  })

  it('rejects a mismatched main-frame loader and removes lifecycle listeners', async () => {
    let fakeNow = 0
    const listeners = new Map<string, Set<(event: any) => void>>()
    const client = {
      on(method: string, listener: (event: any) => void) {
        const methodListeners = listeners.get(method) ?? new Set()
        methodListeners.add(listener)
        listeners.set(method, methodListeners)
        return () => methodListeners.delete(listener)
      },
      async send(method: string) {
        if (method === 'Page.setLifecycleEventsEnabled') return {}
        if (method === 'Runtime.evaluate') return { result: { value: {
          href: fakeNow ? 'http://127.0.0.1:4747/?fresh=1' : 'about:blank',
          time_origin_ms: fakeNow ? 2_000 : 1_000,
          document_complete: true,
        } } }
        if (method === 'Page.navigate') return { loaderId: 'expected-loader' }
        if (method === 'Page.getFrameTree') return {
          frameTree: { frame: { loaderId: 'wrong-loader', url: 'http://127.0.0.1:4747/?fresh=1' } },
        }
        throw new Error(`unexpected method ${method}`)
      },
    }
    await expect(navigateFreshInteractionMode({
      client,
      url: 'http://127.0.0.1:4747/?fresh=1',
      name: 'Settings primary view',
      mode: 'keyboard',
      waitForReady: async () => { throw new Error('readiness must not run') },
      now: () => fakeNow,
      sleep: async (milliseconds: number) => { fakeNow += milliseconds },
      synchronizationTimeoutMs: 20,
    })).rejects.toThrow(/did not synchronize/)
    expect([...listeners.values()].every((methodListeners) => methodListeners.size === 0)).toBe(true)
  })

  it('does not correlate a load lifecycle event from a different loader', async () => {
    let fakeNow = 0
    const href = 'http://127.0.0.1:4747/?fresh=1'
    const listeners = new Map<string, Set<(event: any) => void>>()
    const client = {
      on(method: string, listener: (event: any) => void) {
        const methodListeners = listeners.get(method) ?? new Set()
        methodListeners.add(listener)
        listeners.set(method, methodListeners)
        return () => methodListeners.delete(listener)
      },
      async send(method: string) {
        if (method === 'Page.setLifecycleEventsEnabled') return {}
        if (method === 'Runtime.evaluate') return { result: { value: {
          href: fakeNow ? href : 'about:blank',
          time_origin_ms: fakeNow ? 2_000 : 1_000,
          document_complete: true,
        } } }
        if (method === 'Page.navigate') {
          for (const listener of listeners.get('Page.frameNavigated') ?? []) {
            listener({ frame: { loaderId: 'expected-loader', url: href } })
          }
          for (const listener of listeners.get('Page.lifecycleEvent') ?? []) {
            listener({ name: 'load', loaderId: 'unrelated-loader' })
          }
          return { loaderId: 'expected-loader' }
        }
        if (method === 'Page.getFrameTree') return {
          frameTree: { frame: { loaderId: 'expected-loader', url: href } },
        }
        throw new Error(`unexpected method ${method}`)
      },
    }
    await expect(navigateFreshInteractionMode({
      client,
      url: href,
      name: 'Settings primary view',
      mode: 'keyboard',
      waitForReady: async () => { throw new Error('readiness must not run') },
      now: () => fakeNow,
      sleep: async (milliseconds: number) => { fakeNow += milliseconds },
      synchronizationTimeoutMs: 20,
    })).rejects.toThrow(/did not synchronize/)
  })

  it('rejects artifact identity mutation between preflight and finalization', () => {
    const initial = {
      sha256: 'a'.repeat(64),
      artifact_identity: { root_dist_sha256: 'b'.repeat(64), web_dist_sha256: 'c'.repeat(64) },
    }
    expect(() => assertFinalBuildManifest(initial, structuredClone(initial))).not.toThrow()
    const mutated = structuredClone(initial)
    mutated.artifact_identity.web_dist_sha256 = 'd'.repeat(64)
    mutated.sha256 = 'e'.repeat(64)
    expect(() => assertFinalBuildManifest(initial, mutated)).toThrow(/changed during browser verification/)
  })

  it('binds the retained gate outcome and error digest into the evidence digest', () => {
    const passed = finalizeBrowserEvidence(passingEvidence(), [])
    expect(passed.gate_result).toEqual({
      status: 'passed', validation_error_count: 0, validation_errors_sha256: evidenceDigest([]),
    })
    expect(validateBrowserQualityEvidence(passed)).toEqual([])

    const tampered = structuredClone(passed)
    tampered.validation_errors = ['gate failed']
    expect(tampered.sha256).toBe(passed.sha256)
    expect(validateBrowserQualityEvidence(tampered)).toEqual(expect.arrayContaining([
      'evidence digest is invalid', 'evidence gate result binding is invalid',
    ]))

    const removed = structuredClone(passed)
    delete removed.gate_result
    delete removed.validation_errors
    removed.sha256 = verifiableDocumentDigest(removed)
    expect(validateBrowserQualityEvidence(removed)).toContain('evidence gate result binding is missing')

    const runnerCandidate = structuredClone(passed)
    delete runnerCandidate.sha256
    delete runnerCandidate.gate_result
    delete runnerCandidate.validation_errors
    const runnerResult = finalizeValidatedBrowserEvidence(
      runnerCandidate,
      (document) => validateBrowserQualityEvidence(document),
    )
    expect(runnerResult.gate_result.status).toBe('passed')
    expect(runnerResult.validation_errors).toEqual([])
    expect(validateBrowserQualityEvidence(runnerResult)).toEqual([])
  })

  it.skipIf(!chromeForDomFixture)('counts visible aria-hidden overflow but excludes a real clipped sr-only DOM box', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-overflow-dom-'))
    const html = join(root, 'fixture.html')
    const profile = join(root, 'profile')
    const script = `window.addEventListener('load', () => {
      const result = eval(${JSON.stringify(BROWSER_OVERFLOW_AUDIT_EXPRESSION)});
      document.body.setAttribute('data-audit', encodeURIComponent(JSON.stringify(result)));
    });`
    writeFileSync(html, `<!doctype html><style>
      html,body{margin:0;width:100%;height:100%;overflow:visible}
      #visible{position:absolute;left:780px;top:20px;width:100px;height:20px}
      .sr-only{position:absolute;left:900px;top:40px;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    </style><body><div id="visible" aria-hidden="true">visible</div><div id="reader" class="sr-only">reader only</div><script>${script}</script></body>`)
    try {
      const result = spawnSync(chromeForDomFixture!, [
        '--headless=new', '--no-sandbox', '--no-first-run', '--disable-gpu', '--window-size=800,600',
        `--user-data-dir=${profile}`, '--dump-dom', `file://${html}`,
      ], { encoding: 'utf8', timeout: 20_000 })
      expect(result.status).toBe(0)
      const encoded = result.stdout.match(/data-audit="([^"]+)"/)?.[1]
      expect(encoded).toBeTruthy()
      const audit = JSON.parse(decodeURIComponent(encoded!))
      expect(audit.offenders.map((row: any) => row.id)).toContain('visible')
      expect(audit.offenders.map((row: any) => row.id)).not.toContain('reader')
      expect(audit.excluded_nonvisual_or_contained).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'reader', reason: 'own_zero_area_paint_clip' }),
      ]))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  it('retains bounded fatal evidence when the manifest is missing or stale', () => {
    const artifactRootRelative = join('artifacts', 'qa', 'browser-quality')
    const artifactRoot = join(process.cwd(), artifactRootRelative)
    mkdirSync(artifactRoot, { recursive: true })
    const cases = [
      { name: 'missing', manifest: join(artifactRootRelative, 'adversarial-missing-manifest.json') },
      { name: 'stale', manifest: join(artifactRootRelative, 'adversarial-stale-manifest.json'), body: '{}' },
    ]
    try {
      for (const testCase of cases) {
        const output = join(artifactRoot, `adversarial-${testCase.name}-failure.json`)
        const outputRelative = join(artifactRootRelative, `adversarial-${testCase.name}-failure.json`)
        rmSync(output, { force: true })
        rmSync(join(process.cwd(), testCase.manifest), { force: true })
        if (testCase.body) writeFileSync(join(process.cwd(), testCase.manifest), testCase.body)
        const result = spawnSync(process.execPath, [
          'scripts/qa-browser-gates.mjs', '--capture-only',
          '--artifact-manifest', testCase.manifest, '--output', outputRelative,
        ], { cwd: process.cwd(), encoding: 'utf8' })
        expect(result.status).not.toBe(0)
        expect(existsSync(output)).toBe(true)
        const evidence = JSON.parse(readFileSync(output, 'utf8'))
        expect(evidence.incomplete).toBe(true)
        expect(evidence.source.binding_status).toBe('failed_or_unavailable')
        expect(evidence.source.artifact_identity).toBeNull()
        expect(evidence.diagnostics.manifest_error).toMatch(testCase.name === 'missing' ? /missing build manifest/ : /schema version/)
        expect(Buffer.byteLength(readFileSync(output))).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES)
      }
    } finally {
      for (const testCase of cases) {
        rmSync(join(process.cwd(), testCase.manifest), { force: true })
        rmSync(join(artifactRoot, `adversarial-${testCase.name}-failure.json`), { force: true })
      }
    }
  })

  it('locks actual runner source against retaining raw response or page content', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'qa-browser-gates.mjs'), 'utf8')
    const authSource = readFileSync(join(process.cwd(), 'scripts', 'lib', 'browser-auth-challenges.mjs'), 'utf8')
    const qualitySource = readFileSync(join(process.cwd(), 'scripts', 'lib', 'browser-quality.mjs'), 'utf8')
    expect(source).not.toContain('response.status}: ${String(text)')
    expect(source).not.toContain('text: text.slice')
    expect(source).not.toContain("localStorage.setItem('orchestra-token'")
    expect(authSource).toContain("label: 'expected_local_owner_challenge'")
    expect(source).toContain("type: 'keyDown'")
    expect(source).toContain("...(result.violations ?? []), ...(result.unsupported ?? [])")
    expect(source).toContain('for (const unsubscribe of subscriptions) unsubscribe()')
    expect(source).toContain("escape_path: shift ? 'Escape+Shift+Tab' : 'Escape+Tab'")
    expect(source).toContain('AUTHENTICATED_DATA_READY_EXPRESSION')
    expect(source).toContain('first-connection surface')
    expect(source).toContain('authenticated data readiness')
    expect(source).toContain("client.on('Network.requestWillBeSent'")
    expect(qualitySource).toContain('request_sha256')
    expect(source).toContain('observer?.takeRecords?.()')
    expect(source).toContain('candidate.start_ms === entry.start_ms && candidate.duration_ms === entry.duration_ms')
    expect(source).toContain('seedBudgetPacer = createSeedBudgetPacer()')
    expect(source).toContain('await seedBudgetPacer.finishAndDrain()')
    expect(source.indexOf('await seedBudgetPacer.finishAndDrain()'))
      .toBeLessThan(source.indexOf('requestBudgetPacer = createRequestBudgetPacer(baseUrl)'))
    expect(source).toContain("}, { ...authHeaders, 'idempotency-key': 'qa-browser-job' }, 'provider')")
    expect(source).toContain('seedBudgetPacer.completeRequest(reservation, response?.status ?? 0, url)')
    expect(source).toContain('attachRequestBudgetPacer(client, requestBudgetPacer)')
    expect(source.match(/attachRequestBudgetPacer\(client, requestBudgetPacer\)/g)).toHaveLength(1)
    expect(source).toContain('chromeProfile: join(runRoot, `chrome-profile-${viewport.id}`)')
    expect(source.indexOf('for (const viewport of viewportMatrix)'))
      .toBeLessThan(source.indexOf('const isolatedBrowser = await startIsolatedBrowser'))
    expect(source).toContain('await stopChild(chrome)')
    expect(source).toContain('await requestBudgetPacer.beforeLifecycle()')
    expect(source).not.toContain('mayRetryFixtureMutation')
    expect(source).toContain('fatal_viewport_diagnostics: fatalViewportDiagnostics')
    expect(source).toContain('navigator.serviceWorker?.controller')
    expect(source).not.toContain('registration.scope')
    expect(source).not.toContain('registration.active.scriptURL')
    expect(qualitySource).toContain("client.on('Page.lifecycleEvent'")
    expect(qualitySource).not.toContain("client.on('Page.loadEventFired'")
  })
})
