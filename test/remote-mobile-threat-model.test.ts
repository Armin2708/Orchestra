import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'

type Classification = 'canonical' | 'compatibility' | 'legacy' | 'infrastructure'
type CurrentStatus = 'implemented' | 'partial'
type Likelihood = 'low' | 'medium' | 'high'
type Impact = 'low' | 'moderate' | 'high' | 'critical'
type Risk = 'low' | 'medium' | 'high' | 'critical'

type Evidence = {
  file: string
  contains: string
}

type CurrentControl = {
  id: string
  status: CurrentStatus
  description: string
  evidence: Evidence[]
}

type TargetControl = {
  id: string
  backlog_items: string[]
  description: string
  verification_ids: string[]
}

type Threat = {
  id: string
  title: string
  topic_ids: string[]
  likelihood: Likelihood
  impact: Impact
  risk: Risk
  assets: string[]
  actors: string[]
  boundaries: string[]
  current_control_ids: string[]
  gap: string
  target_control_ids: string[]
  abuse_case_ids: string[]
}

type AbuseCase = {
  id: string
  threat_ids: string[]
  preconditions: string
  action: string
  current_expected: string
  target_expected: string
}

type ThreatMatrix = {
  schema_version: number
  observed_at_commit: string
  backlog_item: string
  classification: string
  posture: string
  summary: string
  risk_model: {
    likelihood: Likelihood[]
    impact: Impact[]
    risk: Risk[]
  }
  standards: Array<{ id: string; title: string; url: string; relevance: string }>
  assets: Array<{ id: string; name: string; sensitivity: string }>
  actors: Array<{ id: string; name: string; trust: string }>
  trust_boundaries: Array<{ id: string; name: string; from: string; to: string }>
  required_topics: Array<{ id: string; name: string; threat_ids: string[] }>
  current_controls: CurrentControl[]
  target_controls: TargetControl[]
  scope_matrix: Array<{
    scope: string
    default_phone: boolean
    target_allows: string[]
    target_denies: string[]
    step_up: string
  }>
  remote_request_policy: {
    default: string
    read_rules: Array<{
      data_class: string
      examples: string[]
      required_scope: string
      requirements: string
    }>
    mutation_rules: Array<{ family: string; required_scope: string; step_up: string }>
    invariants: string[]
  }
  observed_read_surface: {
    inventory_file: string
    total_get_routes: number
    by_classification: Record<Classification, number>
    interpretation: string
  }
  observed_mutation_surface: {
    inventory_file: string
    total_non_get_routes: number
    by_classification: Record<Classification, number>
    interpretation: string
  }
  threats: Threat[]
  abuse_cases: AbuseCase[]
  rollout: Array<{ phase: string; name: string; entry: string; exit: string }>
  rollback_invariants: Array<{ id: string; statement: string }>
  release_gate: {
    name: string
    this_artifact_satisfies_release_gate: boolean
    required_before_safe_remote_beta: string[]
    forbidden_claims_until_gate_passes: string[]
  }
}

type SurfaceInventory = {
  http_routes: Record<Classification, string[]>
  database_tables: Record<Classification, string[]>
  planned_not_implemented: Array<{ noun: string; reason: string }>
}

const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const matrix = JSON.parse(read('docs/remote-mobile-threat-control-matrix.json')) as ThreatMatrix
const markdown = read('docs/remote-mobile-threat-model.md')
const inventory = JSON.parse(read(matrix.observed_mutation_surface.inventory_file)) as SurfaceInventory
const classifications: Classification[] = ['canonical', 'compatibility', 'legacy', 'infrastructure']
const idSet = <T extends { id: string }>(items: T[]) => new Set(items.map((item) => item.id))
const expectUnique = (label: string, values: string[]) => {
  expect(values, `${label} must be unique`).toHaveLength(new Set(values).size)
}
const expectReferences = (label: string, values: string[], known: Set<string>) => {
  expect(values.length, `${label} must not be empty`).toBeGreaterThan(0)
  for (const value of values) expect(known.has(value), `${label} references unknown ${value}`).toBe(true)
}

describe('REM-001 remote/mobile threat model', () => {
  it('stays explicitly evidence-only and cannot be mistaken for a release gate', () => {
    expect(matrix.schema_version).toBe(1)
    expect(matrix.observed_at_commit).toMatch(/^[0-9a-f]{40}$/)
    expect(matrix.backlog_item).toBe('REM-001')
    expect(matrix.classification).toBe('threat_model_only')
    expect(matrix.posture).toBe('functional_beta_not_safe_remote_beta')
    expect(matrix.summary.length).toBeGreaterThan(100)
    expect(matrix.release_gate.name).toBe('REM-GATE')
    expect(matrix.release_gate.this_artifact_satisfies_release_gate).toBe(false)
    expect(matrix.release_gate.required_before_safe_remote_beta.length).toBeGreaterThanOrEqual(10)
    expect(matrix.release_gate.forbidden_claims_until_gate_passes).toEqual([
      'plug-and-play',
      'shippable',
      'safe remote beta',
      'production-ready remote access',
    ])
    expect(markdown).toContain('Remote access is a functional beta, not a safe remote beta.')
    expect(markdown).toContain('This document is a threat-model deliverable only.')
    expect(markdown).toContain('It does not implement the controls and does not satisfy `REM-GATE`.')
    expect(markdown).toContain('Revocation cannot remotely erase a phone that is offline and unreachable.')
    expect(matrix.abuse_cases.find(({ id }) => id === 'AC-04')?.target_expected)
      .toContain('does not falsely claim it can erase an unreachable offline device')
  })

  it('uses unique definitions and keeps every structured definition human-readable', () => {
    const definitions = [
      ...matrix.standards.map(({ id }) => id),
      ...matrix.assets.map(({ id }) => id),
      ...matrix.actors.map(({ id }) => id),
      ...matrix.trust_boundaries.map(({ id }) => id),
      ...matrix.required_topics.map(({ id }) => id),
      ...matrix.current_controls.map(({ id }) => id),
      ...matrix.target_controls.map(({ id }) => id),
      ...matrix.threats.map(({ id }) => id),
      ...matrix.abuse_cases.map(({ id }) => id),
      ...matrix.rollout.map(({ phase }) => phase),
      ...matrix.rollback_invariants.map(({ id }) => id),
    ]
    expectUnique('all definition ids', definitions)
    expectUnique('scope names', matrix.scope_matrix.map(({ scope }) => scope))

    for (const id of definitions) {
      expect(markdown, `${id} is missing from the human-readable threat model`).toContain(id)
    }
  })

  it('covers every required topic with complete, closed threat references', () => {
    const topics = idSet(matrix.required_topics)
    const assets = idSet(matrix.assets)
    const actors = idSet(matrix.actors)
    const boundaries = idSet(matrix.trust_boundaries)
    const currentControls = idSet(matrix.current_controls)
    const targetControls = idSet(matrix.target_controls)
    const threats = idSet(matrix.threats)
    const abuseCases = idSet(matrix.abuse_cases)

    expect(matrix.required_topics.map(({ name }) => name).sort()).toEqual([
      'approvals',
      'audit_attribution',
      'csrf_origin_host',
      'lost_device_and_revocation',
      'message_confused_deputy',
      'offline_mutation',
      'read_authorization_and_data_minimization',
      'terminal_control_escalation',
      'token_theft',
      'tunnel_discovery',
    ])

    for (const topic of matrix.required_topics) {
      expectReferences(`${topic.id}.threat_ids`, topic.threat_ids, threats)
    }

    for (const threat of matrix.threats) {
      expect(threat.id).toMatch(/^REM-T\d{2}$/)
      expect(threat.title.length).toBeGreaterThan(10)
      expect(matrix.risk_model.likelihood).toContain(threat.likelihood)
      expect(matrix.risk_model.impact).toContain(threat.impact)
      expect(matrix.risk_model.risk).toContain(threat.risk)
      expectReferences(`${threat.id}.topic_ids`, threat.topic_ids, topics)
      expectReferences(`${threat.id}.assets`, threat.assets, assets)
      expectReferences(`${threat.id}.actors`, threat.actors, actors)
      expectReferences(`${threat.id}.boundaries`, threat.boundaries, boundaries)
      expectReferences(`${threat.id}.current_control_ids`, threat.current_control_ids, currentControls)
      expectReferences(`${threat.id}.target_control_ids`, threat.target_control_ids, targetControls)
      expectReferences(`${threat.id}.abuse_case_ids`, threat.abuse_case_ids, abuseCases)
      expect(threat.gap.length, `${threat.id} needs an explicit gap`).toBeGreaterThan(40)
      for (const topicId of threat.topic_ids) {
        expect(
          matrix.required_topics.find(({ id }) => id === topicId)?.threat_ids,
          `${topicId} must link back to ${threat.id}`,
        ).toContain(threat.id)
      }
      for (const abuseId of threat.abuse_case_ids) {
        expect(
          matrix.abuse_cases.find(({ id }) => id === abuseId)?.threat_ids,
          `${abuseId} must link back to ${threat.id}`,
        ).toContain(threat.id)
      }
    }

    for (const abuseCase of matrix.abuse_cases) {
      expect(abuseCase.id).toMatch(/^AC-\d{2}$/)
      expectReferences(`${abuseCase.id}.threat_ids`, abuseCase.threat_ids, threats)
      expect(abuseCase.preconditions.length).toBeGreaterThan(20)
      expect(abuseCase.action.length).toBeGreaterThan(20)
      expect(abuseCase.current_expected.length).toBeGreaterThan(20)
      expect(abuseCase.target_expected.length).toBeGreaterThan(20)
      for (const threatId of abuseCase.threat_ids) {
        expect(
          matrix.threats.find(({ id }) => id === threatId)?.abuse_case_ids,
          `${threatId} must link back to ${abuseCase.id}`,
        ).toContain(abuseCase.id)
      }
    }

    for (const target of matrix.target_controls) {
      expect(target.backlog_items.length, `${target.id} needs backlog ownership`).toBeGreaterThan(0)
      for (const backlogItem of target.backlog_items) {
        expect(backlogItem).toMatch(/^(?:BASE|REM|OPS|QA)-(?:\d{3}|GATE)$/)
      }
      expect(target.description.length).toBeGreaterThan(40)
      expectReferences(`${target.id}.verification_ids`, target.verification_ids, abuseCases)
      const row = markdown.split('\n').find((line) => line.startsWith(`| ${target.id} |`))
      expect(row, `${target.id} needs a human-readable target-control row`).toBeDefined()
      const documentedBacklog = row!.split('|')[3].trim().split(', ')
      expect(documentedBacklog, `${target.id} backlog mapping drifted from the matrix`)
        .toEqual(target.backlog_items)
    }

    const usedCurrent = new Set(matrix.threats.flatMap(({ current_control_ids }) => current_control_ids))
    const usedTarget = new Set(matrix.threats.flatMap(({ target_control_ids }) => target_control_ids))
    expect([...currentControls].filter((id) => !usedCurrent.has(id))).toEqual([])
    expect([...targetControls].filter((id) => !usedTarget.has(id))).toEqual([])
  })

  it('keeps every current control tied to exact observed source evidence', () => {
    for (const control of matrix.current_controls) {
      expect(['implemented', 'partial']).toContain(control.status)
      expect(control.description.length).toBeGreaterThan(40)
      expect(control.evidence.length, `${control.id} needs source evidence`).toBeGreaterThan(0)
      for (const evidence of control.evidence) {
        expect(path.isAbsolute(evidence.file), `${control.id} evidence must be repo-relative`).toBe(false)
        expect(evidence.file.includes('..'), `${control.id} evidence must stay inside the repo`).toBe(false)
        expect(
          read(evidence.file),
          `${control.id} no longer has ${JSON.stringify(evidence.contains)} in ${evidence.file}`,
        ).toContain(evidence.contains)
      }
    }
  })

  it('fails closed when credential, stream, read, message, framing, offline, PTY, or approval baseline changes', () => {
    expect(read('src/remote.ts')).toContain(
      'export const pairUrl = (s: RemoteState) => `${s.url}/#token=${ensureToken()}`',
    )
    expect(read('web/src/api.ts')).toContain(
      "export const getToken = () => localStorage.getItem('orchestra-token') ?? ''",
    )
    expect(read('web/src/api.ts')).toContain(
      'return token ? `/api/v1/events?token=${encodeURIComponent(token)}` : \'/api/v1/events\'',
    )
    expect(read('src/server.ts')).toContain('const given = bearer ?? query.token')
    expect(read('web/public/sw.js')).toContain(
      "if (url.origin !== location.origin || e.request.method !== 'GET') return",
    )
    expect(read('src/runtime/supervisor.ts')).toContain(
      "await this.emitFor(state, 'process.input', { source, bytes: Buffer.byteLength(data) })",
    )
    expect(read('src/server.ts')).toContain(
      "if ((kind === 'ask' || kind === 'reply' || kind === 'task') && toId && maestro?.isHired(toId)) targets.add(toId)",
    )
    expect(read('src/conductor.ts')).toContain('h.push(text, msg.id)')
    expect(read('src/agent-os/routes.ts')).toContain("'/processes/:id/output', (request) => {")
    expect(`${read('src/server.ts')}\n${read('web/index.html')}`.toLowerCase())
      .not.toMatch(/frame-ancestors|x-frame-options/)
    expect(read('src/runtime/drivers/codex.ts')).toContain(
      "actorId: source === 'operator'\n          ? null",
    )
    expect(read('src/agent-os/codex-native-events.ts')).toContain("raw_payload_state: 'withheld'")
    expect(read('src/agent-os/codex-native-events.ts')).toContain(
      "throw new ConflictError('Codex approval response has no matching durable request')",
    )
  })

  it('treats every observed read and mutation family as default-deny for future devices', () => {
    expect(matrix.remote_request_policy.default).toBe('deny')
    expect(matrix.remote_request_policy.invariants).toHaveLength(2)
    expect(matrix.remote_request_policy.invariants[0]).toContain('newly added route of any method')
    expect(matrix.remote_request_policy.invariants[1]).toContain('relayed through a tool-capable agent')
    expect(matrix.remote_request_policy.read_rules.map(({ data_class }) => data_class)).toEqual([
      'public_bootstrap',
      'redacted_observe',
      'sensitive_content',
      'secret_or_withheld',
    ])
    expect(
      matrix.remote_request_policy.read_rules.find(({ data_class }) =>
        data_class === 'sensitive_content')?.requirements,
    ).toContain('Unavailable remotely by default')
    expect(
      matrix.remote_request_policy.mutation_rules.find(({ family }) =>
        family === 'messages')?.step_up,
    ).toContain('no_tool_q_and_a_only')
    expect(matrix.scope_matrix.map(({ scope }) => scope).sort()).toEqual([
      'admin',
      'agent-control',
      'approve',
      'message',
      'observe',
      'terminal-write',
    ])
    expect(
      matrix.scope_matrix.filter(({ default_phone }) => default_phone).map(({ scope }) => scope).sort(),
    ).toEqual(['approve', 'message', 'observe'])
    expect(
      matrix.scope_matrix.filter(({ default_phone }) => !default_phone).map(({ scope }) => scope).sort(),
    ).toEqual(['admin', 'agent-control', 'terminal-write'])

    const actualReads = Object.fromEntries(classifications.map((classification) => [
      classification,
      inventory.http_routes[classification].filter((route) => route.startsWith('GET ')).length,
    ])) as Record<Classification, number>
    const actualMutations = Object.fromEntries(classifications.map((classification) => [
      classification,
      inventory.http_routes[classification].filter((route) => !route.startsWith('GET ')).length,
    ])) as Record<Classification, number>
    expect(actualReads).toEqual(matrix.observed_read_surface.by_classification)
    expect(Object.values(actualReads).reduce((sum, count) => sum + count, 0))
      .toBe(matrix.observed_read_surface.total_get_routes)
    expect(actualMutations).toEqual(matrix.observed_mutation_surface.by_classification)
    expect(Object.values(actualMutations).reduce((sum, count) => sum + count, 0))
      .toBe(matrix.observed_mutation_surface.total_non_get_routes)
  })

  it('keeps DeviceSession and PairingTicket classified as targets at this baseline', () => {
    const plannedDevice = inventory.planned_not_implemented.find(({ noun }) => noun === 'DeviceSession')
    expect(plannedDevice?.reason).toContain('named scoped revocable device credentials do not exist')

    const documentedTables = classifications.flatMap((classification) =>
      inventory.database_tables[classification])
    expect(documentedTables).not.toContain('device_sessions')
    expect(documentedTables).not.toContain('pairing_tickets')

    const db = openDb(':memory:')
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).all().map((row) => String((row as { name: string }).name))
      expect(tables).not.toContain('device_sessions')
      expect(tables).not.toContain('pairing_tickets')
    } finally {
      db.close()
    }
  })

  it('keeps standards links explicit without claiming their target mechanisms exist', () => {
    expect(matrix.standards.map(({ url }) => url)).toEqual([
      'https://www.rfc-editor.org/info/rfc6750',
      'https://www.rfc-editor.org/info/rfc9700',
      'https://www.rfc-editor.org/info/rfc9449',
      'https://www.w3.org/TR/fetch-metadata/',
      'https://www.w3.org/TR/webauthn-3/',
    ])
    expect(markdown).toContain('as a design reference, not as an implementation claim')
  })
})
