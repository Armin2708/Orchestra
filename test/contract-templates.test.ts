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
  return { db, boardId, cardId }
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
    const { db, boardId, cardId } = fixture()
    const events = new EventStore(db)
    const market = new JobMarketService(db, events)
    const templates = new TaskContractTemplateService(db, events)
    const initial = market.get(cardId)
    const initialEventCount = events.listBoard(boardId, { cardId, limit: 500 }).length

    expect(() => templates.apply(cardId, 'bug-fix', variables['bug-fix']))
      .toThrow(/retry with conflict_strategy=replace/)
    expect(market.get(cardId).contract.version).toBe(initial.contract.version)
    expect(events.listBoard(boardId, { cardId, limit: 500 })).toHaveLength(initialEventCount)

    const applied = templates.apply(cardId, 'bug-fix', variables['bug-fix'], 'replace', 'agent:planner')
    expect(applied).toMatchObject({
      changed: true,
      conflict_strategy: 'replace',
      template: { id: 'bug-fix', publishes_contract: false },
      job_market: {
        card_id: cardId,
        status: initial.status,
        contract: {
          objective: variables['bug-fix'].objective,
          verify_commands: ['npm test'],
        },
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
    expect(afterApplyEvents.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'job_market.scope_changed',
      'job_market.criterion_changed',
      'job_market.budget_changed',
      'job_market.template_applied',
    ]))
    expect(afterApplyEvents.some((event) => event.kind === 'job_market.lifecycle_changed')).toBe(false)
    const templateAudit = afterApplyEvents.find((event) => event.kind === 'job_market.template_applied')!
    expect(templateAudit.payload).toEqual(expect.objectContaining({
      actor: 'agent:planner',
      template_id: 'bug-fix',
      template_version: 1,
      conflict_strategy: 'replace',
      variable_keys: ['objective', 'affected_area', 'reproduction'],
      published: false,
    }))
    expect(JSON.stringify(templateAudit.payload)).not.toContain(variables['bug-fix'].reproduction)

    const version = applied.job_market.contract.version
    const marketVersion = applied.job_market.market_version
    const eventCount = afterApplyEvents.length
    const reapplied = templates.apply(cardId, 'bug-fix', variables['bug-fix'])
    expect(reapplied).toMatchObject({
      changed: false,
      replaced_fields: [],
      job_market: {
        market_version: marketVersion,
        contract: { version },
      },
    })
    expect(events.listBoard(boardId, { cardId, limit: 500 })).toHaveLength(eventCount)

    expect(() => templates.apply(cardId, 'feature', variables.feature))
      .toThrow(/template conflicts with existing contract fields/)
    expect(market.get(cardId).contract.version).toBe(version)
    db.close()
  })
})
