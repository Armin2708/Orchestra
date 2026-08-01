import type { JsonObject, OrganizationControlCenter } from './osApi'

export type OrganizationAttention = {
  kind: 'escalation' | 'incident' | 'appeal' | 'corrective_action' | 'gate'
  id: string
  title: string
  detail: string
  severity: 'critical' | 'warning' | 'normal'
}

export const organizationText = (
  row: JsonObject,
  keys: string[],
  fallback = '—',
): string => {
  for (const key of keys) {
    const value = row[key]
    if (value !== null && value !== undefined && String(value).trim()) return String(value)
  }
  return fallback
}

export const organizationList = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function organizationCounts(center: OrganizationControlCenter) {
  const openEscalations = center.coordination.escalations
    .filter((row) => organizationText(row, ['status']) === 'open').length
  const activeIncidents = center.assurance.incidents
    .filter((row) => organizationText(row, ['status']) !== 'resolved').length
  return {
    teams: center.organization.teams.length,
    activeMembers: center.organization.memberships
      .filter((row) => organizationText(row, ['state']) === 'active').length,
    objectives: center.coordination.objectives
      .filter((row) => !['achieved', 'cancelled', 'superseded']
        .includes(organizationText(row, ['status']))).length,
    decisions: center.coordination.decisions.length,
    traceNodes: center.assurance.trace_nodes.length,
    gatesPassing: center.assurance.quality_gate_runs
      .filter((row) => organizationText(row, ['status']) === 'passed').length,
    needsYou: openEscalations + activeIncidents + center.assurance.open_appeals
      + center.assurance.overdue_corrective_actions.length,
  }
}

export function organizationAttention(center: OrganizationControlCenter): OrganizationAttention[] {
  const escalations = center.coordination.escalations
    .filter((row) => organizationText(row, ['status']) === 'open')
    .map((row): OrganizationAttention => ({
      kind: 'escalation',
      id: organizationText(row, ['id']),
      title: organizationText(row, ['threshold'], 'Escalation requires a decision'),
      detail: organizationText(row, ['recommendation', 'risk_of_waiting']),
      severity: 'warning',
    }))
  const incidents = center.assurance.incidents
    .filter((row) => organizationText(row, ['status']) !== 'resolved')
    .map((row): OrganizationAttention => ({
      kind: 'incident',
      id: organizationText(row, ['id']),
      title: organizationText(row, ['title'], 'Active incident'),
      detail: organizationText(row, ['impact', 'summary']),
      severity: ['SEV0', 'SEV1'].includes(organizationText(row, ['severity']))
        ? 'critical' : 'warning',
    }))
  const appeals = center.assurance.appeals
    .filter((row) => organizationText(row, ['status']) === 'open')
    .map((row): OrganizationAttention => ({
      kind: 'appeal',
      id: organizationText(row, ['id']),
      title: 'Review appeal requires independent resolution',
      detail: organizationText(row, ['grounds', 'requested_correction']),
      severity: 'normal',
    }))
  const corrective = center.assurance.overdue_corrective_actions
    .map((row): OrganizationAttention => ({
      kind: 'corrective_action',
      id: organizationText(row, ['id']),
      title: organizationText(row, ['title', 'action'], 'Corrective action overdue'),
      detail: `Due ${organizationText(row, ['due_at'])}`,
      severity: 'warning',
    }))
  const gates = center.assurance.quality_gate_runs
    .filter((row) => ['failed', 'blocked'].includes(organizationText(row, ['status'])))
    .map((row): OrganizationAttention => ({
      kind: 'gate',
      id: organizationText(row, ['id']),
      title: `Quality gate ${organizationText(row, ['status'])}`,
      detail: `${organizationText(row, ['subject_kind'])} · ${organizationText(row, ['subject_id'])}`,
      severity: 'critical',
    }))
  return [...gates, ...incidents, ...escalations, ...appeals, ...corrective]
}
