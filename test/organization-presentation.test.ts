import { describe, expect, it } from 'vitest'
import type { OrganizationControlCenter } from '../web/src/osApi.js'
import {
  organizationAttention,
  organizationCounts,
  organizationList,
  organizationText,
} from '../web/src/organizationPresentation.js'

const center = (): OrganizationControlCenter => ({
  organization: {
    organization: {
      id: 'org-1', board_id: 1, organization_key: 'orchestra', name: 'Orchestra',
      mission: 'Ship safely.', status: 'active', created_at: '', updated_at: '',
    },
    product_areas: [],
    teams: [{ id: 'team-1' }, { id: 'team-2' }],
    memberships: [{ state: 'active' }, { state: 'active' }, { state: 'suspended' }],
    roles: [], assignments: [], ownerships: [],
  },
  coordination: {
    interactions: [], responsibilities: [],
    objectives: [{ status: 'active' }, { status: 'achieved' }],
    goals: [], capacity: [], decisions: [{ id: 'decision-1' }],
    escalations: [{
      id: 'escalation-1', status: 'open', threshold: 'Service SLO breached',
      recommendation: 'Use the fallback.',
    }],
  },
  assurance: {
    organization_id: 'org-1',
    trace_nodes: [{ id: 'trace-1' }, { id: 'trace-2' }], trace_edges: [],
    provenance_attestations: [], quality_gate_definitions: [],
    quality_gate_runs: [
      { id: 'gate-pass', status: 'passed' },
      { id: 'gate-fail', status: 'blocked', subject_kind: 'build', subject_id: 'build-1' },
    ],
    metric_definitions: [], scorecards: [], metric_observations: [],
    access_certifications: [],
    appeals: [{ id: 'appeal-1', status: 'open', grounds: 'Evidence was incomplete.' }],
    incidents: [{ id: 'incident-1', status: 'open', severity: 'SEV1', title: 'API unavailable' }],
    postmortems: [], corrective_actions: [], knowledge_promotions: [],
    overdue_corrective_actions: [{ id: 'action-1', title: 'Add rollback test', due_at: '2026-08-01' }],
    stale_metric_observations: 0, overdue_access_certifications: 0,
    open_appeals: 1, insufficient_evidence_observations: 0,
  },
})

describe('organization control-center presentation', () => {
  it('summarizes governed delivery without activity-volume metrics', () => {
    expect(organizationCounts(center())).toEqual({
      teams: 2,
      activeMembers: 2,
      objectives: 1,
      decisions: 1,
      traceNodes: 2,
      gatesPassing: 1,
      needsYou: 4,
    })
  })

  it('prioritizes failed gates and incidents in the human attention queue', () => {
    const items = organizationAttention(center())
    expect(items.map((item) => item.kind)).toEqual([
      'gate', 'incident', 'escalation', 'appeal', 'corrective_action',
    ])
    expect(items[0]).toMatchObject({ severity: 'critical', title: 'Quality gate blocked' })
    expect(items[1]).toMatchObject({ severity: 'critical', title: 'API unavailable' })
  })

  it('reads stored JSON lists and fields fail-soft', () => {
    expect(organizationList('["a","b"]')).toEqual(['a', 'b'])
    expect(organizationList('{bad')).toEqual([])
    expect(organizationText({ name: '', title: 'Fallback title' }, ['name', 'title']))
      .toBe('Fallback title')
  })
})
