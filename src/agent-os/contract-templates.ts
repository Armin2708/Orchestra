import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import {
  JobMarketService,
  type ContractAccessNeed,
  type CriterionVerifier,
  type JobMarketContract,
  type RequiredArtifact,
} from './job-market.js'

export const BUILT_IN_TASK_CONTRACT_TEMPLATE_IDS = [
  'bug-fix',
  'feature',
  'research',
  'review',
  'test',
  'release',
] as const

export type BuiltInTaskContractTemplateId = typeof BUILT_IN_TASK_CONTRACT_TEMPLATE_IDS[number]
export type TemplateConflictStrategy = 'reject' | 'replace'

export interface TaskContractTemplateVariable {
  key: string
  label: string
  description: string
  required: true
  max_length: number
}

export interface TaskContractTemplateDescriptor {
  id: BuiltInTaskContractTemplateId
  version: 1
  order: number
  name: string
  description: string
  variables: TaskContractTemplateVariable[]
  publishes_contract: false
  default_conflict_strategy: 'reject'
}

export interface TemplateDeliverableInput {
  id: string
  text: string
  required: true
  metadata: {
    template_id: BuiltInTaskContractTemplateId
    template_version: 1
    template_role: string
  }
}

export interface TemplateCriterionInput {
  id: string
  text: string
  required: true
  deliverable_ids: string[]
  metadata: {
    template_id: BuiltInTaskContractTemplateId
    template_version: 1
    template_role: string
  }
  description: string
  verifier: CriterionVerifier
  required_artifacts: RequiredArtifact[]
  priority: number
  owner: null
}

export interface TaskContractTemplateContract {
  objective: string
  deliverables: TemplateDeliverableInput[]
  acceptance_criteria: TemplateCriterionInput[]
  base_ref: 'HEAD'
  verify_commands: string[]
  non_goals: string[]
  risks: string[]
  budget_tokens: number
  budget_cents: number
  priority: number
  required_capabilities: string[]
  provider_constraints: string[]
  model_constraints: string[]
  access_needs: ContractAccessNeed[]
  budget_time_seconds: number
  budget_retries: number
  budget_coordination_tokens: number
  budget_coordination_messages: number
}

export interface TaskContractTemplatePreview {
  template: TaskContractTemplateDescriptor
  variables: Record<string, string>
  contract: TaskContractTemplateContract
}

export interface ApplyTaskContractTemplateResult extends TaskContractTemplatePreview {
  conflict_strategy: TemplateConflictStrategy
  changed: boolean
  replaced_fields: string[]
  job_market: JobMarketContract
}

interface TemplateDefinition {
  descriptor: TaskContractTemplateDescriptor
  build(values: Record<string, string>): TaskContractTemplateContract
}

const MAX_VARIABLE_LENGTH = 2_000

const variable = (
  key: string,
  label: string,
  description: string,
  maxLength = MAX_VARIABLE_LENGTH,
): TaskContractTemplateVariable => ({
  key,
  label,
  description,
  required: true,
  max_length: maxLength,
})

function definition(
  id: BuiltInTaskContractTemplateId,
  order: number,
  name: string,
  description: string,
  variables: TaskContractTemplateVariable[],
  build: TemplateDefinition['build'],
): TemplateDefinition {
  return {
    descriptor: {
      id,
      version: 1,
      order,
      name,
      description,
      variables,
      publishes_contract: false,
      default_conflict_strategy: 'reject',
    },
    build,
  }
}

const TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [
  definition(
    'bug-fix',
    1,
    'Bug fix',
    'Reproduce, correct, and prove a bounded defect without broadening scope.',
    [
      variable('objective', 'Objective', 'The defect to correct and the expected outcome.'),
      variable('affected_area', 'Affected area', 'The component, workflow, or files in scope.'),
      variable('reproduction', 'Reproduction', 'A deterministic description of the failing behavior.'),
    ],
    (values) => buildContract({
      id: 'bug-fix',
      objective: values.objective,
      deliverables: [
        ['fix', `A bounded correction in ${values.affected_area}.`, 'implementation'],
        ['regression-proof', `Regression coverage for: ${values.reproduction}`, 'evidence'],
      ],
      criteria: [
        commandCriterion('reproduced', 'The original defect is reproduced before the fix and absent afterward.',
          'npm test', ['regression-proof'], 'test-log'),
        commandCriterion('focused-tests', 'Focused and relevant regression tests pass.',
          'npm test', ['fix', 'regression-proof'], 'test-log'),
      ],
      verifyCommands: ['npm test'],
      nonGoals: [`Unrelated refactors outside ${values.affected_area}.`],
      risks: [
        `The correction may regress adjacent behavior in ${values.affected_area}.`,
        'The reproduction may not cover every production variant.',
      ],
      capabilities: ['code-change', 'debugging', 'testing'],
      access: ['workspace_write'],
      budgets: [20_000, 500, 3_600, 2, 2_000, 12],
      priority: 6,
    }),
  ),
  definition(
    'feature',
    2,
    'Feature',
    'Implement a user-visible outcome with bounded scope and production-build evidence.',
    [
      variable('objective', 'Objective', 'The feature to implement.'),
      variable('user_outcome', 'User outcome', 'What a user can accomplish when the work is complete.'),
      variable('affected_area', 'Affected area', 'The component, workflow, or files in scope.'),
    ],
    (values) => buildContract({
      id: 'feature',
      objective: values.objective,
      deliverables: [
        ['implementation', `Feature implementation in ${values.affected_area}.`, 'implementation'],
        ['user-outcome', `A working path that lets users ${values.user_outcome}.`, 'product'],
        ['verification', 'Focused tests and a production build record.', 'evidence'],
      ],
      criteria: [
        commandCriterion('tests', `Tests prove users can ${values.user_outcome}.`,
          'npm test', ['implementation', 'user-outcome'], 'test-log'),
        commandCriterion('build', 'The production build completes successfully.',
          'npm run build', ['implementation', 'verification'], 'build-log'),
      ],
      verifyCommands: ['npm test', 'npm run build'],
      nonGoals: [`Unrequested behavior outside ${values.affected_area}.`],
      risks: [
        `The new path may alter existing behavior in ${values.affected_area}.`,
        'The user outcome may require compatibility handling not visible in the initial scope.',
      ],
      capabilities: ['code-change', 'product-implementation', 'testing'],
      access: ['workspace_write'],
      budgets: [40_000, 1_000, 7_200, 2, 4_000, 20],
      priority: 5,
    }),
  ),
  definition(
    'research',
    3,
    'Research',
    'Answer a bounded question with cited evidence, alternatives, and a decision-ready recommendation.',
    [
      variable('question', 'Question', 'The question the research must answer.'),
      variable('scope', 'Scope', 'The repositories, documents, systems, or constraints to investigate.'),
      variable('decision', 'Decision', 'The decision this research must enable.'),
    ],
    (values) => buildContract({
      id: 'research',
      objective: `Answer: ${values.question}`,
      deliverables: [
        ['findings', `Evidence-backed findings within ${values.scope}.`, 'research'],
        ['recommendation', `A recommendation that enables: ${values.decision}`, 'decision'],
      ],
      criteria: [
        artifactCriterion('evidence', 'Claims are linked to primary evidence and uncertainties are explicit.',
          'research-report', ['findings']),
        artifactCriterion('decision', `The report directly supports the decision: ${values.decision}`,
          'decision-record', ['recommendation']),
      ],
      verifyCommands: [],
      nonGoals: [`Implementation work outside the research scope: ${values.scope}.`],
      risks: [
        'Available evidence may be incomplete or stale.',
        'A recommendation can be invalidated by assumptions that are not made explicit.',
      ],
      capabilities: ['research', 'evidence-analysis'],
      access: ['read_only'],
      budgets: [20_000, 400, 3_600, 1, 3_000, 20],
      priority: 3,
    }),
  ),
  definition(
    'review',
    4,
    'Review',
    'Perform an independent, severity-ranked review with reproducible evidence.',
    [
      variable('objective', 'Objective', 'The change or claim to review.'),
      variable('review_scope', 'Review scope', 'The commits, files, behavior, or evidence in scope.'),
      variable('review_standard', 'Review standard', 'The acceptance, security, or quality standard to apply.'),
    ],
    (values) => buildContract({
      id: 'review',
      objective: values.objective,
      deliverables: [
        ['findings', `P0-P2 findings for ${values.review_scope}.`, 'review'],
        ['verdict', `A pass/fail verdict against ${values.review_standard}.`, 'decision'],
      ],
      criteria: [
        artifactCriterion('findings', 'Every finding includes severity, location, impact, and reproduction evidence.',
          'review-report', ['findings']),
        artifactCriterion('verdict', `The verdict explicitly applies ${values.review_standard}.`,
          'review-verdict', ['verdict']),
      ],
      verifyCommands: [],
      nonGoals: ['Implementing fixes unless separately authorized.'],
      risks: [
        'The review may miss behavior outside the declared scope.',
        'A passing verdict is only as strong as the supplied evidence and review standard.',
      ],
      capabilities: ['code-review', 'evidence-analysis'],
      access: ['read_only'],
      budgets: [15_000, 300, 2_700, 1, 2_000, 15],
      priority: 4,
    }),
  ),
  definition(
    'test',
    5,
    'Test',
    'Add deterministic coverage for declared behavior and retain reproducible test evidence.',
    [
      variable('objective', 'Objective', 'The test outcome to deliver.'),
      variable('test_scope', 'Test scope', 'The subsystem, files, or execution path to exercise.'),
      variable('behavior', 'Behavior', 'The observable behavior and edge cases the tests must prove.'),
    ],
    (values) => buildContract({
      id: 'test',
      objective: values.objective,
      deliverables: [
        ['coverage', `Deterministic automated coverage for ${values.test_scope}.`, 'test'],
        ['evidence', `A passing test record proving: ${values.behavior}`, 'evidence'],
      ],
      criteria: [
        commandCriterion('focused-tests', `Focused tests prove: ${values.behavior}`,
          'npm test', ['coverage', 'evidence'], 'test-log'),
      ],
      verifyCommands: ['npm test'],
      nonGoals: [`Production behavior changes outside ${values.test_scope}.`],
      risks: [
        'Tests may pass while missing an unmodeled production integration.',
        'Nondeterministic fixtures can create false confidence or flakes.',
      ],
      capabilities: ['testing', 'test-design'],
      access: ['workspace_write'],
      budgets: [20_000, 400, 3_600, 2, 2_000, 12],
      priority: 4,
    }),
  ),
  definition(
    'release',
    6,
    'Release',
    'Prepare and verify a release without pushing, publishing, deploying, or changing remote state.',
    [
      variable('objective', 'Objective', 'The release-readiness outcome to deliver.'),
      variable('release_scope', 'Release scope', 'The commits, packages, or product surface included.'),
      variable('version', 'Version', 'The intended release version or release identifier.', 120),
    ],
    (values) => buildContract({
      id: 'release',
      objective: values.objective,
      deliverables: [
        ['candidate', `A locally verified ${values.version} candidate covering ${values.release_scope}.`, 'release'],
        ['evidence', 'Test/build evidence and a release-readiness checklist.', 'evidence'],
      ],
      criteria: [
        commandCriterion('tests', 'The complete relevant test gate passes locally.',
          'npm test', ['candidate', 'evidence'], 'test-log'),
        commandCriterion('build', 'The production build completes locally without publishing.',
          'npm run build', ['candidate', 'evidence'], 'build-log'),
        artifactCriterion('checklist', 'The release-readiness checklist names remaining gaps and operator actions.',
          'release-checklist', ['evidence']),
      ],
      verifyCommands: ['npm test', 'npm run build'],
      nonGoals: ['Pushing tags, publishing packages, deploying, or otherwise mutating remote release state.'],
      risks: [
        `The ${values.version} candidate may differ from the artifact an operator eventually publishes.`,
        'External release credentials, registries, and deployment systems are intentionally not exercised.',
      ],
      capabilities: ['release-readiness', 'testing', 'build-verification'],
      access: ['workspace_write'],
      budgets: [30_000, 800, 5_400, 1, 3_000, 20],
      priority: 8,
    }),
  ),
]

type ContractBuildInput = {
  id: BuiltInTaskContractTemplateId
  objective: string
  deliverables: Array<[id: string, text: string, role: string]>
  criteria: Array<Omit<TemplateCriterionInput, 'id' | 'metadata'> & { id: string }>
  verifyCommands: string[]
  nonGoals: string[]
  risks: string[]
  capabilities: string[]
  access: ContractAccessNeed[]
  budgets: [
    tokens: number,
    costCents: number,
    timeSeconds: number,
    retries: number,
    coordinationTokens: number,
    coordinationMessages: number,
  ]
  priority: number
}

function buildContract(input: ContractBuildInput): TaskContractTemplateContract {
  const [tokens, costCents, timeSeconds, retries, coordinationTokens, coordinationMessages] = input.budgets
  return {
    objective: input.objective,
    deliverables: input.deliverables.map(([id, text, role]) => ({
      id: `${input.id}:${id}`,
      text,
      required: true,
      metadata: {
        template_id: input.id,
        template_version: 1,
        template_role: role,
      },
    })),
    acceptance_criteria: input.criteria.map((criterion) => ({
      ...criterion,
      id: `${input.id}:${criterion.id}`,
      deliverable_ids: criterion.deliverable_ids.map((id) => `${input.id}:${id}`),
      metadata: {
        template_id: input.id,
        template_version: 1,
        template_role: 'acceptance',
      },
    })),
    base_ref: 'HEAD',
    verify_commands: input.verifyCommands,
    non_goals: input.nonGoals,
    risks: input.risks,
    budget_tokens: tokens,
    budget_cents: costCents,
    priority: input.priority,
    required_capabilities: input.capabilities,
    provider_constraints: [],
    model_constraints: [],
    access_needs: input.access,
    budget_time_seconds: timeSeconds,
    budget_retries: retries,
    budget_coordination_tokens: coordinationTokens,
    budget_coordination_messages: coordinationMessages,
  }
}

function commandCriterion(
  id: string,
  text: string,
  command: string,
  deliverableIds: string[],
  artifactKind: string,
): Omit<TemplateCriterionInput, 'id' | 'metadata'> & { id: string } {
  return {
    id,
    text,
    required: true,
    deliverable_ids: deliverableIds,
    description: text,
    verifier: { kind: 'command', command },
    required_artifacts: [{
      kind: artifactKind,
      name: `${id}-${artifactKind}`,
      description: `Evidence produced by ${command}.`,
    }],
    priority: 10,
    owner: null,
  }
}

function artifactCriterion(
  id: string,
  text: string,
  artifactKind: string,
  deliverableIds: string[],
): Omit<TemplateCriterionInput, 'id' | 'metadata'> & { id: string } {
  return {
    id,
    text,
    required: true,
    deliverable_ids: deliverableIds,
    description: text,
    verifier: { kind: 'artifact', artifact_kind: artifactKind },
    required_artifacts: [{
      kind: artifactKind,
      name: `${id}-${artifactKind}`,
      description: `Required ${artifactKind} evidence.`,
    }],
    priority: 10,
    owner: null,
  }
}

export function listTaskContractTemplates(): TaskContractTemplateDescriptor[] {
  return TEMPLATE_DEFINITIONS.map((template) => clone(template.descriptor))
}

export function previewTaskContractTemplate(
  templateId: string,
  rawVariables: unknown,
): TaskContractTemplatePreview {
  const template = findTemplate(templateId)
  const variables = normalizeVariables(template.descriptor, rawVariables)
  return {
    template: clone(template.descriptor),
    variables,
    contract: clone(template.build(variables)),
  }
}

export class TaskContractTemplateService {
  private readonly jobMarket: JobMarketService

  constructor(
    private readonly db: Database.Database,
    private readonly events?: EventStore,
  ) {
    this.jobMarket = new JobMarketService(db, events)
  }

  list(): TaskContractTemplateDescriptor[] {
    return listTaskContractTemplates()
  }

  preview(templateId: string, variables: unknown): TaskContractTemplatePreview {
    return previewTaskContractTemplate(templateId, variables)
  }

  apply(
    cardId: number,
    templateId: string,
    variables: unknown,
    conflictStrategy: TemplateConflictStrategy = 'reject',
    actor = 'human',
  ): ApplyTaskContractTemplateResult {
    if (!Number.isSafeInteger(cardId) || cardId <= 0) throw new ValidationError('card id must be a positive integer')
    if (!['reject', 'replace'].includes(conflictStrategy)) {
      throw new ValidationError('conflict_strategy must be reject or replace')
    }
    const preview = this.preview(templateId, variables)
    const apply = this.db.transaction(() => {
      const before = this.jobMarket.get(cardId)
      const replacedFields = templateConflictFields(before, preview.contract)
      if (!replacedFields.length) {
        return {
          ...preview,
          conflict_strategy: conflictStrategy,
          changed: false,
          replaced_fields: [],
          job_market: before,
        }
      }
      if (conflictStrategy !== 'replace') {
        throw new ConflictError(
          `template conflicts with existing contract fields: ${replacedFields.join(', ')}; retry with conflict_strategy=replace`,
        )
      }
      const after = this.jobMarket.update(cardId, preview.contract as unknown as Record<string, unknown>, actor)
      this.auditApplication(before, after, preview, actor, replacedFields)
      return {
        ...preview,
        conflict_strategy: conflictStrategy,
        changed: true,
        replaced_fields: replacedFields,
        job_market: after,
      }
    })
    return apply.immediate()
  }

  private auditApplication(
    before: JobMarketContract,
    after: JobMarketContract,
    preview: TaskContractTemplatePreview,
    actor: string,
    replacedFields: string[],
  ): void {
    if (!this.events) return
    const board = this.db.prepare('SELECT board_id FROM cards WHERE id=?')
      .get(after.card_id) as { board_id: number } | undefined
    if (!board) throw new NotFoundError('card not found')
    this.events.append({
      boardId: board.board_id,
      workspaceId: after.contract.workspace_id,
      cardId: after.card_id,
      contractId: `card:${after.card_id}:v${after.contract.version}`,
      kind: 'job_market.template_applied',
      source: 'job-market',
      payload: {
        actor: actor.trim() || 'human',
        template_id: preview.template.id,
        template_version: preview.template.version,
        conflict_strategy: 'replace',
        variable_keys: preview.template.variables.map((item) => item.key),
        replaced_fields: replacedFields,
        previous_contract_version: before.contract.version,
        contract_version: after.contract.version,
        market_version: after.market_version,
        published: false,
      },
    })
  }
}

function findTemplate(templateId: string): TemplateDefinition {
  const id = templateId.trim()
  const template = TEMPLATE_DEFINITIONS.find((candidate) => candidate.descriptor.id === id)
  if (!template) throw new NotFoundError(`task contract template ${id || '(empty)'} was not found`)
  return template
}

function normalizeVariables(
  descriptor: TaskContractTemplateDescriptor,
  rawVariables: unknown,
): Record<string, string> {
  if (!rawVariables || typeof rawVariables !== 'object' || Array.isArray(rawVariables)) {
    throw new ValidationError('variables must be an object')
  }
  const input = rawVariables as Record<string, unknown>
  const expected = new Set(descriptor.variables.map((item) => item.key))
  const unknown = Object.keys(input).filter((key) => !expected.has(key)).sort()
  if (unknown.length) throw new ValidationError(`unknown template variables: ${unknown.join(', ')}`)
  const values: Record<string, string> = {}
  for (const variable of descriptor.variables) {
    const value = input[variable.key]
    if (typeof value !== 'string' || !value.trim()) {
      throw new ValidationError(`template variable ${variable.key} is required`)
    }
    const normalized = value.trim().replace(/\r\n?/g, '\n')
    if (normalized.length > variable.max_length) {
      throw new ValidationError(`template variable ${variable.key} must be at most ${variable.max_length} characters`)
    }
    values[variable.key] = normalized
  }
  return values
}

function templateConflictFields(
  current: JobMarketContract,
  expected: TaskContractTemplateContract,
): string[] {
  const actualState = templateManagedState(current)
  const expectedState = templateExpectedState(expected)
  return Object.keys(expectedState).filter((field) =>
    stable(actualState[field]) !== stable(expectedState[field]))
}

function templateManagedState(market: JobMarketContract): Record<string, unknown> {
  return {
    objective: market.contract.objective,
    deliverables: market.contract.deliverables,
    acceptance_criteria: market.criteria,
    base_ref: market.contract.base_ref,
    verify_commands: market.contract.verify_commands,
    non_goals: market.contract.non_goals,
    risks: market.contract.risks,
    priority: market.contract.priority,
    required_capabilities: market.constraints.required_capabilities,
    provider_constraints: market.constraints.provider_constraints,
    model_constraints: market.constraints.model_constraints,
    access_needs: market.constraints.access_needs,
    budget_tokens: market.budgets.tokens,
    budget_cents: market.budgets.cost_cents,
    budget_time_seconds: market.budgets.time_seconds,
    budget_retries: market.budgets.retries,
    budget_coordination_tokens: market.budgets.coordination_tokens,
    budget_coordination_messages: market.budgets.coordination_messages,
  }
}

function templateExpectedState(contract: TaskContractTemplateContract): Record<string, unknown> {
  return {
    objective: contract.objective,
    deliverables: contract.deliverables,
    acceptance_criteria: contract.acceptance_criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      required: criterion.required,
      deliverable_ids: criterion.deliverable_ids,
      metadata: {
        ...criterion.metadata,
        verifier: criterion.verifier,
        required_artifacts: criterion.required_artifacts,
        priority: criterion.priority,
        owner: criterion.owner,
      },
      description: criterion.description,
      verifier: criterion.verifier,
      required_artifacts: criterion.required_artifacts,
      priority: criterion.priority,
      owner: criterion.owner,
    })),
    base_ref: contract.base_ref,
    verify_commands: contract.verify_commands,
    non_goals: contract.non_goals,
    risks: contract.risks,
    priority: contract.priority,
    required_capabilities: contract.required_capabilities,
    provider_constraints: contract.provider_constraints,
    model_constraints: contract.model_constraints,
    access_needs: contract.access_needs,
    budget_tokens: contract.budget_tokens,
    budget_cents: contract.budget_cents,
    budget_time_seconds: contract.budget_time_seconds,
    budget_retries: contract.budget_retries,
    budget_coordination_tokens: contract.budget_coordination_tokens,
    budget_coordination_messages: contract.budget_coordination_messages,
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
