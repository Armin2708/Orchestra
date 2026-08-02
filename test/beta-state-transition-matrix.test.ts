import { describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { DeliveryReportService, type DeliveryStatus } from '../src/agent-os/delivery-reports.js'
import { JobAssignmentService } from '../src/agent-os/job-assignments.js'
import { JOB_MARKET_STATUSES, JobMarketService, type JobMarketStatus } from '../src/agent-os/job-market.js'
import { MEMBERSHIP_STATES, OrganizationService, type MembershipState } from '../src/agent-os/organization.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { openDb } from '../src/db.js'

const actor = { type: 'human', id: 'beta-quality-matrix' } as const

function deliveryDatabase() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/beta-delivery', 'beta')")
    .run().lastInsertRowid)
  return { db, boardId }
}

function createDeliveryReport(
  db: ReturnType<typeof openDb>,
  boardId: number,
  suffix: string,
): string {
  const cardId = Number(db.prepare('INSERT INTO cards (board_id, title) VALUES (?, ?)')
    .run(boardId, `Delivery matrix ${suffix}`).lastInsertRowid)
  new TaskContractService(db).put(cardId, {
    objective: `Guard delivery transition ${suffix}`,
    deliverables: ['Transition evidence'],
    acceptance_criteria: ['Every transition is guarded'],
  })
  return new DeliveryReportService(db).createForCard(cardId, { actor: actor.id }).id
}

const DELIVERY_STATUSES: DeliveryStatus[] = ['draft', 'submitted', 'verified', 'accepted', 'rejected']
const DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  draft: ['submitted'],
  submitted: ['verified', 'rejected'],
  verified: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
}

function moveDeliveryTo(db: ReturnType<typeof openDb>, reportId: string, status: DeliveryStatus): void {
  if (status === 'draft') return
  db.prepare("UPDATE delivery_reports SET status='submitted' WHERE id=?").run(reportId)
  if (status === 'submitted') return
  if (status === 'rejected') {
    db.prepare("UPDATE delivery_reports SET status='rejected' WHERE id=?").run(reportId)
    return
  }
  db.prepare("UPDATE delivery_reports SET status='verified' WHERE id=?").run(reportId)
  if (status === 'accepted') db.prepare("UPDATE delivery_reports SET status='accepted' WHERE id=?").run(reportId)
}

function jobMarketFixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/beta-market', 'beta')")
    .run().lastInsertRowid)
  const cardId = Number(db.prepare("INSERT INTO cards (board_id, title, description) VALUES (?, 'Market matrix', 'Guard work')")
    .run(boardId).lastInsertRowid)
  const service = new JobMarketService(db)
  service.get(cardId)
  const profile = new AgentProfileService(db).create({
    boardId,
    name: 'Matrix assignee',
    actor,
    idempotencyKey: 'beta-matrix-job-profile',
  })
  return { db, cardId, service, profileId: profile.id }
}

const DIRECT_JOB_MARKET_TRANSITIONS: Record<JobMarketStatus, readonly JobMarketStatus[]> = {
  draft: ['open', 'cancelled', 'archived'],
  open: ['cancelled', 'archived'],
  assigned: ['running', 'cancelled', 'archived'],
  running: ['submitted', 'cancelled'],
  submitted: ['running', 'accepted', 'rejected', 'cancelled'],
  accepted: ['archived'],
  rejected: ['draft', 'open', 'archived'],
  cancelled: ['draft', 'open', 'archived'],
  archived: [],
}

function organizationFixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/beta-org', 'beta')")
    .run().lastInsertRowid)
  const profile = new AgentProfileService(db).create({
    boardId,
    name: 'Matrix member',
    actor,
    idempotencyKey: 'beta-matrix-profile',
  })
  const service = new OrganizationService(db)
  const organization = service.createOrganization({
    boardId,
    key: 'beta-matrix',
    name: 'Beta matrix',
    mission: 'Prove every membership rejection guard.',
    actor,
    idempotencyKey: 'beta-matrix-organization',
  })
  const team = service.createTeam({
    organizationId: organization.id,
    key: 'quality',
    name: 'Quality',
    mission: 'Own deterministic coverage.',
    actor,
    idempotencyKey: 'beta-matrix-team',
  })
  const membership = service.createMembership({
    organizationId: organization.id,
    teamId: team.id,
    agentProfileId: profile.id,
    state: 'candidate',
    reason: 'Exercise transition guards.',
    actor,
    idempotencyKey: 'beta-matrix-membership',
  })
  return { db, service, membershipId: membership.id }
}

const MEMBERSHIP_TRANSITIONS: Record<MembershipState, readonly MembershipState[]> = {
  candidate: ['onboarding', 'offboarded'],
  onboarding: ['active', 'suspended', 'offboarded'],
  active: ['leave', 'suspended', 'offboarded'],
  leave: ['active', 'suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  offboarded: [],
}

describe('beta state-transition rejection matrix', () => {
  it('enforces the complete DeliveryReport SQL transition matrix', () => {
    const { db, boardId } = deliveryDatabase()
    for (const from of DELIVERY_STATUSES) {
      for (const to of DELIVERY_STATUSES) {
        const reportId = createDeliveryReport(db, boardId, `${from}-${to}`)
        moveDeliveryTo(db, reportId, from)
        const update = () => db.prepare('UPDATE delivery_reports SET status=? WHERE id=?').run(to, reportId)
        if (from === to || DELIVERY_TRANSITIONS[from].includes(to)) expect(update).not.toThrow()
        else expect(update).toThrow(/invalid delivery status transition/)
      }
    }
    db.close()
  })

  it('rejects every disallowed direct Job Market transition', () => {
    let checked = 0
    const shared = jobMarketFixture()
    for (const from of JOB_MARKET_STATUSES) {
      for (const to of JOB_MARKET_STATUSES) {
        if (from === to || DIRECT_JOB_MARKET_TRANSITIONS[from].includes(to)) continue
        if (from === 'assigned') {
          const { db, cardId, service, profileId } = jobMarketFixture()
          new JobAssignmentService(db).assign({
            cardId,
            profileId,
            expectedMarketVersion: service.get(cardId).market_version,
            actor,
            idempotencyKey: `beta-matrix-assignment-${to}`,
          })
          expect(() => service.transition(cardId, to, actor.id), `${from} -> ${to}`).toThrow()
          expect(service.get(cardId).status).toBe(from)
          db.close()
        } else {
          shared.db.prepare('UPDATE job_market_contracts SET status=? WHERE card_id=?')
            .run(from, shared.cardId)
          expect(() => shared.service.transition(shared.cardId, to, actor.id), `${from} -> ${to}`)
            .toThrow()
          expect(shared.service.get(shared.cardId).status).toBe(from)
        }
        checked += 1
      }
    }
    expect(checked).toBe(51)
    shared.db.close()
  })

  it('rejects every disallowed organization membership transition', () => {
    const { db, service, membershipId } = organizationFixture()
    let checked = 0
    for (const from of MEMBERSHIP_STATES) {
      for (const to of MEMBERSHIP_STATES) {
        if (MEMBERSHIP_TRANSITIONS[from].includes(to)) continue
        db.prepare(`UPDATE os_team_memberships SET state=?,
          effective_until=CASE WHEN ?='offboarded' THEN datetime('now') ELSE NULL END
          WHERE id=?`).run(from, from, membershipId)
        expect(() => service.transitionMembership(membershipId, {
          toState: to,
          reason: 'This transition must remain rejected.',
          handoffRef: 'artifact://matrix-handoff',
          retentionPolicyRef: 'policy://matrix-retention',
          actor,
          idempotencyKey: `beta-matrix-${from}-${to}`,
        }), `${from} -> ${to}`).toThrow(/membership cannot transition/)
        expect(db.prepare('SELECT state FROM os_team_memberships WHERE id=?').get(membershipId))
          .toEqual({ state: from })
        checked += 1
      }
    }
    expect(checked).toBe(23)
    db.close()
  })
})
