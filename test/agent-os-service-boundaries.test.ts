import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { ComputedWorkspaceConflictService } from '../src/agent-os/conflict-service.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import { KnowledgeService } from '../src/agent-os/knowledge-service.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { OrganizationService } from '../src/agent-os/organization.js'
import { OrganizationCoordinationService } from '../src/agent-os/organization-coordination.js'
import { OrganizationAssuranceService } from '../src/agent-os/organization-assurance.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import {
  AGENT_OS_DOMAIN_SERVICE_NAMES,
  createAgentOsDomainServiceBoundaries,
} from '../src/agent-os/service-boundaries.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'

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
        'reserved',
        'canonical',
        'canonical',
        'canonical',
        'canonical',
        'compatibility_only',
        'canonical',
      ])
    expect(boundaries.orchestration.service).toBeInstanceOf(OrchestrationService)
    expect(boundaries.conversations.service).toBeInstanceOf(ConversationService)
    expect(boundaries.deliveries.service).toBeInstanceOf(DeliveryReportService)
    expect(boundaries.knowledge.service).toBeInstanceOf(KnowledgeService)
    expect(boundaries.organization.service).toBeInstanceOf(OrganizationService)
    expect(boundaries.coordination.service).toBeInstanceOf(OrganizationCoordinationService)
    expect(boundaries.assurance.service).toBeInstanceOf(OrganizationAssuranceService)
    expect(boundaries.conflicts.service).toBeInstanceOf(ComputedWorkspaceConflictService)
    expect(boundaries.discussions.service).toBeNull()
    expect(boundaries.device_pairing.implementation_state).toBe('canonical')
    expect(boundaries.device_pairing.service.listDeviceSessions()).toEqual([])
    expect(Object.isFrozen(boundaries)).toBe(true)
    expect(Object.values(boundaries).every(Object.isFrozen)).toBe(true)
  })

  it('keeps reserved and partial domains from claiming future product behavior', () => {
    const { db, scheduler } = fixture()
    const boundaries = createAgentOsDomainServiceBoundaries(db, { scheduler })

    expect(boundaries.discussions.excludes).toContain('messages wake transport')
    expect(boundaries.discussions.detail).toMatch(/messages remain transport/i)
    expect(boundaries.knowledge.excludes).toEqual(expect.arrayContaining([
      'managed prompt injection',
      'automatic freshness or promotion',
    ]))
    expect(boundaries.conflicts.excludes).toEqual(expect.arrayContaining([
      'durable Conflict lifecycle',
      'enforcement or automatic resolution',
    ]))
    expect(boundaries.device_pairing.excludes).toContain('operator master-token QR bootstrap')
    expect(boundaries.device_pairing.detail).toMatch(/default-deny/i)
  })

  it('adapts current overlap detection without inventing a durable Conflict lifecycle', () => {
    const { db, boardId, leftCardId, rightCardId, scheduler } = fixture()
    const workspaces = new WorkspaceStore(db)
    const left = workspaces.create({
      boardId,
      cardId: leftCardId,
      name: 'left',
      rootPath: '/repo',
      worktreePath: '/repo-left',
      kind: 'worktree',
    })
    const right = workspaces.create({
      boardId,
      cardId: rightCardId,
      name: 'right',
      rootPath: '/repo',
      worktreePath: '/repo-right',
      kind: 'worktree',
    })
    const boundaries = createAgentOsDomainServiceBoundaries(db, { scheduler })

    const conflicts = boundaries.conflicts.service.listBoard(boardId)
    expect(conflicts).toHaveLength(1)
    expect(new Set(conflicts[0].workspace_ids)).toEqual(new Set([left.id, right.id]))
    expect(conflicts[0]).toMatchObject({
      kind: 'owned_paths',
      detail: 'card path ownership overlaps',
    })
    expect(() => boundaries.conflicts.service.listBoard(0)).toThrow(/positive integer/)
    expect(() => boundaries.conflicts.service.listBoard(boardId + 10_000))
      .toThrow(/board not found/)
  })

  it('accepts independent domain implementations without a route or server dependency', () => {
    const { db, scheduler } = fixture()
    const orchestration = new OrchestrationService(db, scheduler)
    const conversations = new ConversationService(db)
    const deliveries = new DeliveryReportService(db)
    const knowledge = new KnowledgeService(db)
    const organization = new OrganizationService(db)
    const coordination = new OrganizationCoordinationService(db)
    const assurance = new OrganizationAssuranceService(db)
    const conflicts = new ComputedWorkspaceConflictService(db)

    const boundaries = createAgentOsDomainServiceBoundaries(db, {
      scheduler,
      orchestration,
      conversations,
      deliveries,
      knowledge,
      organization,
      coordination,
      assurance,
      conflicts,
    })

    expect(boundaries.orchestration.service).toBe(orchestration)
    expect(boundaries.conversations.service).toBe(conversations)
    expect(boundaries.deliveries.service).toBe(deliveries)
    expect(boundaries.knowledge.service).toBe(knowledge)
    expect(boundaries.organization.service).toBe(organization)
    expect(boundaries.coordination.service).toBe(coordination)
    expect(boundaries.assurance.service).toBe(assurance)
    expect(boundaries.conflicts.service).toBe(conflicts)
  })
})
