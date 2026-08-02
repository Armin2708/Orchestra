import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import { DiscussionService } from '../src/agent-os/discussions.js'
import { KnowledgeService } from '../src/agent-os/knowledge-service.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { OrganizationService } from '../src/agent-os/organization.js'
import { OrganizationCoordinationService } from '../src/agent-os/organization-coordination.js'
import { OrganizationAssuranceService } from '../src/agent-os/organization-assurance.js'
import { PlanningTeamService } from '../src/agent-os/team-planning.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import {
  AGENT_OS_DOMAIN_SERVICE_NAMES,
  createAgentOsDomainServiceBoundaries,
} from '../src/agent-os/service-boundaries.js'

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/repo', 'repo')",
  ).run().lastInsertRowid)
  const leftCardId = Number(db.prepare(
    `INSERT INTO cards (board_id, title, paths)
      VALUES (?, 'Left', '["src/**"]')`,
  ).run(boardId).lastInsertRowid)
  const rightCardId = Number(db.prepare(
    `INSERT INTO cards (board_id, title, paths)
      VALUES (?, 'Right', '["src/agent-os/**"]')`,
  ).run(boardId).lastInsertRowid)
  const scheduler = new JobScheduler(db)
  return { db, boardId, leftCardId, rightCardId, scheduler }
}

describe('Agent OS domain service boundaries', () => {
  it('publishes exactly ten focused boundaries with honest implementation states', () => {
    const { db, scheduler } = fixture()
    const boundaries = createAgentOsDomainServiceBoundaries(db, { scheduler })

    expect(Object.keys(boundaries)).toEqual(AGENT_OS_DOMAIN_SERVICE_NAMES)
    expect(Object.values(boundaries).map(({ implementation_state }) => implementation_state))
      .toEqual([
        'canonical',
        'canonical',
        'canonical',
        'canonical',
        'canonical',
        'canonical',
        'canonical',
        'canonical',
        'canonical',
        'reserved',
      ])
    expect(boundaries.orchestration.service).toBeInstanceOf(OrchestrationService)
    expect(boundaries.conversations.service).toBeInstanceOf(ConversationService)
    expect(boundaries.deliveries.service).toBeInstanceOf(DeliveryReportService)
    expect(boundaries.discussions.service).toBeInstanceOf(DiscussionService)
    expect(boundaries.knowledge.service).toBeInstanceOf(KnowledgeService)
    expect(boundaries.organization.service).toBeInstanceOf(OrganizationService)
    expect(boundaries.coordination.service).toBeInstanceOf(OrganizationCoordinationService)
    expect(boundaries.assurance.service).toBeInstanceOf(OrganizationAssuranceService)
    expect(boundaries.conflicts.service).toBeInstanceOf(PlanningTeamService)
    expect(boundaries.device_pairing.service).toBeNull()
    expect(Object.isFrozen(boundaries)).toBe(true)
    expect(Object.values(boundaries).every(Object.isFrozen)).toBe(true)
  })

  it('keeps canonical collaboration domains bounded and device pairing reserved', () => {
    const { db, scheduler } = fixture()
    const boundaries = createAgentOsDomainServiceBoundaries(db, { scheduler })

    expect(boundaries.discussions.excludes).toContain('messages wake transport')
    expect(boundaries.discussions.detail).toMatch(/canonical durable discussion/i)
    expect(boundaries.knowledge.excludes).toEqual(expect.arrayContaining([
      'unreviewed arbitrary-text promotion',
      'provider-reported token estimates as actual usage',
    ]))
    expect(boundaries.conflicts.excludes).toEqual(expect.arrayContaining([
      'implicit last-write-wins resolution',
      'unbounded negotiation fanout',
    ]))
    expect(boundaries.device_pairing.excludes).toContain('operator master-token QR bootstrap')
    expect(boundaries.device_pairing.detail).toMatch(/threat-model gates/i)
  })

  it('publishes the durable conflict lifecycle through the canonical boundary', () => {
    const { db, boardId, scheduler } = fixture()
    const boundaries = createAgentOsDomainServiceBoundaries(db, { scheduler })

    expect(boundaries.conflicts.service.listBoardConflicts(boardId)).toEqual([])
    expect(() => boundaries.conflicts.service.listBoardConflicts(0)).toThrow(/integer between 1/)
    expect(() => boundaries.conflicts.service.listBoardConflicts(boardId + 10_000))
      .toThrow(/board not found/)
  })

  it('accepts independent domain implementations without a route or server dependency', () => {
    const { db, scheduler } = fixture()
    const orchestration = new OrchestrationService(db, scheduler)
    const conversations = new ConversationService(db)
    const deliveries = new DeliveryReportService(db)
    const discussions = new DiscussionService(db)
    const knowledge = new KnowledgeService(db)
    const organization = new OrganizationService(db)
    const coordination = new OrganizationCoordinationService(db)
    const assurance = new OrganizationAssuranceService(db)
    const conflicts = new PlanningTeamService(db)

    const boundaries = createAgentOsDomainServiceBoundaries(db, {
      scheduler,
      orchestration,
      conversations,
      deliveries,
      discussions,
      knowledge,
      organization,
      coordination,
      assurance,
      conflicts,
    })

    expect(boundaries.orchestration.service).toBe(orchestration)
    expect(boundaries.conversations.service).toBe(conversations)
    expect(boundaries.deliveries.service).toBe(deliveries)
    expect(boundaries.discussions.service).toBe(discussions)
    expect(boundaries.knowledge.service).toBe(knowledge)
    expect(boundaries.organization.service).toBe(organization)
    expect(boundaries.coordination.service).toBe(coordination)
    expect(boundaries.assurance.service).toBe(assurance)
    expect(boundaries.conflicts.service).toBe(conflicts)
  })
})
