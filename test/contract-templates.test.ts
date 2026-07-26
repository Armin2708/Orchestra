import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  BUILT_IN_TASK_CONTRACT_TEMPLATE_IDS,
  TaskContractTemplateService,
  listTaskContractTemplates,
  previewTaskContractTemplate,
  type BuiltInTaskContractTemplateId,
} from '../src/agent-os/contract-templates.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { JobMarketService } from '../src/agent-os/job-market.js'

const variables: Record<BuiltInTaskContractTemplateId, Record<string, string>> = {
  'bug-fix': {
    objective: 'Stop duplicate dispatch',
    affected_area: 'the scheduler dispatch loop',
    reproduction: 'Two workers claim the same exclusive job',
  },
  feature: {
    objective: 'Add a visual queue',
    user_outcome: 'inspect queued work before launch',
    affected_area: 'the Job Market queue',
  },
  research: {
    question: 'Which local cache is authoritative?',
    scope: 'the scheduler and workspace stores',
    decision: 'select one recovery source',
  },
  review: {
    objective: 'Review the dispatch patch',
    review_scope: 'the final commit and focused tests',
    review_standard: 'no P0-P2 correctness or security findings',
  },
  test: {
    objective: 'Prove exclusive ownership',
    test_scope: 'the scheduler claim transaction',
    behavior: 'exactly one worker owns an exclusive job',
  },
  release: {
    objective: 'Prepare the next local release candidate',
    release_scope: 'the Agent OS package and web build',
    version: 'v0.2.0',
  },
}

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/templates', 'templates')",
  ).run().lastInsertRowid)
  const cardId = Number(db.prepare(
    "INSERT INTO cards (board_id, title, description) VALUES (?, 'Template card', 'Initial scope')",
  ).run(boardId).lastInsertRowid)
  const dependencyId = Number(db.prepare(
    "INSERT INTO cards (board_id, title, description, column_name) VALUES (?, 'Dependency', 'Keep me', 'done')",
  ).run(boardId).lastInsertRowid)
  return { db, boardId, cardId, dependencyId }
}

describe('built-in task contract templates', () => {
  it('lists exactly six stable built-ins in deterministic order with explicit required variables', () => {
    const first = listTaskContractTemplates()
    const second = listTaskContractTemplates()

    expect(first.map((template) => template.id)).toEqual(BUILT_IN_TASK_CONTRACT_TEMPLATE_IDS)
    expect(first.map((template) => template.order)).toEqual([1, 2, 3, 4, 5, 6])
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    for (const template of first) {
      expect(template).toMatchObject({
        version: 1,
        publishes_contract: false,
        default_conflict_strategy: 'reject',
      })
      expect(template.variables.length).toBeGreaterThan(0)
      expect(template.variables.every((item) =>
        item.required && item.max_length > 0 && item.max_length <= 2_000)).toBe(true)
    }
    expect(first.find((template) => template.id === 'release')?.variables
      .find((item) => item.key === 'version')?.max_length).toBe(120)
  })

  it('renders deterministic complete contracts with evidence and safe local verification defaults', () => {
    const destructive = /\b(?:deploy|publish|push|release)\b/i
    for (const templateId of BUILT_IN_TASK_CONTRACT_TEMPLATE_IDS) {
      const first = previewTaskContractTemplate(templateId, variables[templateId])
      const second = previewTaskContractTemplate(templateId, variables[templateId])

      expect(first).toEqual(second)
      expect(first.template.id).toBe(templateId)
      expect(first.contract.deliverables.length).toBeGreaterThan(0)
      expect(first.contract.acceptance_criteria.length).toBeGreaterThan(0)
      expect(first.contract.risks.length).toBeGreaterThan(0)
      expect(first.contract.budget_tokens).toBeGreaterThan(0)
      expect(first.contract.budget_cents).toBeGreaterThan(0)
      expect(first.contract.budget_time_seconds).toBeGreaterThan(0)
      expect(first.contract.budget_coordination_tokens).toBeGreaterThan(0)
      expect(first.contract.budget_coordination_messages).toBeGreaterThan(0)
      expect(first.contract.acceptance_criteria.every((criterion) =>
        criterion.required_artifacts.length > 0 && Boolean(criterion.verifier.kind))).toBe(true)
      expect(first.contract.verify_commands.some((command) => destructive.test(command))).toBe(false)
      expect(first.contract.acceptance_criteria
        .flatMap((criterion) => criterion.verifier.command ? [criterion.verifier.command] : [])
        .some((command) => destructive.test(command))).toBe(false)
    }

    expect(() => previewTaskContractTemplate('bug-fix', {}))
      .toThrow(/template variable objective is required/)
    expect(() => previewTaskContractTemplate('bug-fix', {
      ...variables['bug-fix'],
      typo: 'should fail closed',
    })).toThrow(/unknown template variables: typo/)
    expect(() => previewTaskContractTemplate('missing', variables['bug-fix']))
      .toThrow(/was not found/)
    expect(() => previewTaskContractTemplate('release', {
      ...variables.release,
      version: 'v'.repeat(121),
    })).toThrow(/template variable version must be at most 120 characters/)
    const boundedRelease = previewTaskContractTemplate('release', {
      ...variables.release,
      release_scope: 's'.repeat(2_000),
      version: 'v'.repeat(120),
    })
    expect(boundedRelease.contract.deliverables.every((item) => item.text.length <= 4_000)).toBe(true)
  })

  it('requires explicit replacement, audits a real apply, and makes identical reapply a zero-write no-op', () => {
    const { db, boardId, cardId, dependencyId } = fixture()
    const events = new EventStore(db)
    const market = new JobMarketService(db)
    const templates = new TaskContractTemplateService(db, events)
    const objectiveMarker = 'QA013_OBJECTIVE_SECRET'
    const affectedAreaMarker = 'QA013_AFFECTED_AREA_SECRET'
    const reproductionMarker = 'QA013_REPRODUCTION_SECRET'
    const metadataKeyMarker = 'QA013_METADATA_KEY_SECRET'
    const secretMarkers = [
      objectiveMarker,
      affectedAreaMarker,
      reproductionMarker,
      metadataKeyMarker,
    ]
    const secretVariables = {
      ...variables['bug-fix'],
      objective: objectiveMarker,
      affected_area: affectedAreaMarker,
      reproduction: reproductionMarker,
    }
    const workspaceId = 'template-workspace'
    const policyId = 'template-policy'
    db.prepare(`INSERT INTO workspaces (id, board_id, card_id, name, kind, root_path)
      VALUES (?, ?, ?, 'template', 'shared', '/templates')`).run(workspaceId, boardId, cardId)
    db.prepare(`INSERT INTO policies (id, board_id, name)
      VALUES (?, ?, 'template policy')`).run(policyId, boardId)
    market.update(cardId, {
      deliverables: [{
        id: 'legacy-deliverable',
        text: 'Replace this legacy deliverable.',
        required: true,
      }],
      acceptance_criteria: [{
        id: 'legacy-criterion',
        text: 'Replace this legacy criterion.',
        required: true,
        deliverable_ids: ['legacy-deliverable'],
        metadata: { [metadataKeyMarker]: 'Legacy metadata value.' },
        description: 'Legacy criterion description.',
        verifier: { kind: 'human', instructions: 'Inspect the legacy result.' },
        required_artifacts: [{ kind: 'legacy-log', name: 'legacy-result' }],
        priority: 2,
        owner: 'agent:legacy-owner',
      }],
      dependency_rules: [{
        card_id: dependencyId,
        blocking_reason: 'Preserve this dependency.',
        completion_condition: 'card_done',
      }],
      policy_id: policyId,
      workspace_id: workspaceId,
    }, 'test:setup')
    const initial = market.get(cardId)
    const initialEventCount = events.listBoard(boardId, { cardId, limit: 500 }).length
    const initialPreview = templates.previewForCard(cardId, 'bug-fix', secretVariables)

    expect(initialPreview.expected_state).toMatchObject({
      card_id: cardId,
      market_version: initial.market_version,
      contract_version: initial.contract.version,
      template_id: 'bug-fix',
      template_version: 1,
    })
    expect(initialPreview.expected_state.state_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(initialPreview.expected_state.preview_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(initialPreview.conflicting_fields).toContain('objective')

    expect(() => templates.apply(
      cardId,
      'bug-fix',
      secretVariables,
      initialPreview.expected_state,
    ))
      .toThrow(/retry with conflict_strategy=replace/)
    expect(market.get(cardId).contract.version).toBe(initial.contract.version)
    expect(events.listBoard(boardId, { cardId, limit: 500 })).toHaveLength(initialEventCount)

    const applied = templates.apply(
      cardId,
      'bug-fix',
      secretVariables,
      initialPreview.expected_state,
      'replace',
      'agent:planner',
    )
    expect(applied).toMatchObject({
      changed: true,
      conflict_strategy: 'replace',
      template: { id: 'bug-fix', publishes_contract: false },
      job_market: {
        card_id: cardId,
        status: initial.status,
        contract: {
          objective: secretVariables.objective,
          verify_commands: ['npm test'],
          dependencies: [dependencyId],
          policy_id: policyId,
          workspace_id: workspaceId,
        },
        dependency_rules: [{
          card_id: dependencyId,
          blocking_reason: 'Preserve this dependency.',
          completion_condition: 'card_done',
        }],
      },
    })
    expect(applied.replaced_fields).toEqual(expect.arrayContaining([
      'objective',
      'deliverables',
      'acceptance_criteria',
      'risks',
      'budget_tokens',
    ]))

    const afterApplyEvents = events.listBoard(boardId, { cardId, limit: 500 })
    const appliedAuditEvents = afterApplyEvents
      .filter((event) => (event.payload as { actor?: string }).actor === 'agent:planner')
      .reverse()
    expect(appliedAuditEvents.map((event) => event.kind)).toEqual([
      'task_contract.updated',
      'job_market.scope_changed',
      'job_market.criterion_changed',
      'job_market.owner_changed',
      'job_market.budget_changed',
      'job_market.template_applied',
    ])
    expect(appliedAuditEvents).toHaveLength(6)
    expect(afterApplyEvents.some((event) => event.kind === 'job_market.dependency_changed'
      && (event.payload as { actor?: string }).actor === 'agent:planner')).toBe(false)
    expect(afterApplyEvents.some((event) => event.kind === 'job_market.lifecycle_changed')).toBe(false)
    const templateAudit = afterApplyEvents.find((event) => event.kind === 'job_market.template_applied')!
    expect(templateAudit.payload).toEqual(expect.objectContaining({
      actor: 'agent:planner',
      template_id: 'bug-fix',
      template_version: 1,
      conflict_strategy: 'replace',
      variable_keys: ['objective', 'affected_area', 'reproduction'],
      expected_market_version: initial.market_version,
      expected_contract_version: initial.contract.version,
      expected_state_hash: initialPreview.expected_state.state_hash,
      preview_hash: initialPreview.expected_state.preview_hash,
      result_state_hash: applied.next_expected_state.state_hash,
      published: false,
    }))
    const authorizedRenderedContract = JSON.stringify(applied.contract)
    for (const marker of [objectiveMarker, affectedAreaMarker, reproductionMarker]) {
      expect(authorizedRenderedContract).toContain(marker)
    }
    const managedEventPayloads = JSON.stringify(afterApplyEvents.map((event) => event.payload))
    for (const marker of secretMarkers) expect(managedEventPayloads).not.toContain(marker)
    const projectedChanges = appliedAuditEvents
      .filter((event) => event.kind.startsWith('job_market.') && event.kind.endsWith('_changed'))
    expect(JSON.stringify(projectedChanges.map((event) => event.payload))).not.toContain('npm test')
    expect(JSON.stringify(projectedChanges.map((event) => event.payload))).not.toContain('test-log')
    expect(JSON.stringify(projectedChanges.map((event) => event.payload))).not.toContain('implementation')
    const projectedScope = afterApplyEvents.find((event) => event.kind === 'job_market.scope_changed')!
    expect(projectedScope.payload).toMatchObject({
      projection_format: 'sha256-shape-v1',
      changed_fields: expect.arrayContaining(['deliverables', 'non_goals', 'risks']),
      before: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), shape: { type: 'object' } },
      after: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), shape: { type: 'object' } },
    })

    const version = applied.job_market.contract.version
    const marketVersion = applied.job_market.market_version
    const eventCount = afterApplyEvents.length
    db.prepare('DELETE FROM job_market_criteria WHERE card_id=?').run(cardId)
    const criterionRowCount = () => (db.prepare(
      'SELECT COUNT(*) AS count FROM job_market_criteria WHERE card_id=?',
    ).get(cardId) as { count: number }).count
    expect(criterionRowCount()).toBe(0)
    const reapplied = templates.apply(
      cardId,
      'bug-fix',
      secretVariables,
      initialPreview.expected_state,
      'replace',
      'agent:planner',
    )
    expect(reapplied).toMatchObject({
      changed: false,
      replaced_fields: [],
      expected_state: initialPreview.expected_state,
      next_expected_state: applied.next_expected_state,
      job_market: {
        market_version: marketVersion,
        contract: { version },
      },
    })
    expect(events.listBoard(boardId, { cardId, limit: 500 })).toHaveLength(eventCount)
    expect(criterionRowCount()).toBe(0)
    const freshNoOpPreview = templates.previewForCard(cardId, 'bug-fix', secretVariables)
    expect(criterionRowCount()).toBe(0)
    expect(templates.apply(
      cardId,
      'bug-fix',
      secretVariables,
      freshNoOpPreview.expected_state,
    )).toMatchObject({
      changed: false,
      replaced_fields: [],
      next_expected_state: freshNoOpPreview.expected_state,
    })
    expect(criterionRowCount()).toBe(0)
    expect(events.listBoard(boardId, { cardId, limit: 500 })).toHaveLength(eventCount)
    expect(() => templates.apply(
      cardId,
      'bug-fix',
      secretVariables,
      { ...initialPreview.expected_state, state_hash: 'f'.repeat(64) },
      'replace',
      'agent:planner',
    )).toThrow(/changed since preview/)
    expect(events.listBoard(boardId, { cardId, limit: 500 })).toHaveLength(eventCount)
    expect(criterionRowCount()).toBe(0)
    const finalManagedEventPayloads = JSON.stringify(events.listBoard(boardId, { cardId, limit: 500 })
      .map((event) => event.payload))
    for (const marker of secretMarkers) expect(finalManagedEventPayloads).not.toContain(marker)

    const featurePreview = templates.previewForCard(cardId, 'feature', variables.feature)
    expect(() => templates.apply(
      cardId,
      'feature',
      variables.feature,
      featurePreview.expected_state,
    ))
      .toThrow(/template conflicts with existing contract fields/)
    expect(market.get(cardId).contract.version).toBe(version)
    db.close()
  })
})
