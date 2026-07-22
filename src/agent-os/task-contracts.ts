import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { integerArray, optionalInteger, parseJson, stringArray, timestamp } from './json.js'

export interface ContractDeliverable {
  id: string
  text: string
  required: boolean
  metadata: Record<string, unknown>
}

export interface ContractAcceptanceCriterion {
  id: string
  text: string
  required: boolean
  deliverable_ids: string[]
  metadata: Record<string, unknown>
}

export interface TaskContract {
  card_id: number
  objective: string
  deliverables: ContractDeliverable[]
  acceptance_criteria: ContractAcceptanceCriterion[]
  dependencies: number[]
  base_ref: string | null
  verify_commands: string[]
  non_goals: string[]
  risks: string[]
  budget_tokens: number | null
  budget_cents: number | null
  priority: number
  policy_id: string | null
  workspace_id: string | null
  version: number
  updated_at: string
}

export interface PutTaskContract {
  objective?: unknown
  deliverables?: unknown
  acceptance_criteria?: unknown
  dependencies?: unknown
  base_ref?: unknown
  verify_commands?: unknown
  non_goals?: unknown
  risks?: unknown
  budget_tokens?: unknown
  budget_cents?: unknown
  priority?: unknown
  policy_id?: unknown
  workspace_id?: unknown
}

const MAX_CONTRACT_RECORDS = 200
const MAX_CONTRACT_TEXT = 4_000
const MAX_CONTRACT_METADATA = 16_000
const MAX_CONTRACT_STRINGS = 200

export class TaskContractService {
  constructor(private readonly db: Database.Database, private readonly events?: EventStore) {}

  getOrCreate(cardId: number): TaskContract {
    const row = this.db.prepare('SELECT * FROM task_contracts WHERE card_id=?').get(cardId) as Record<string, unknown> | undefined
    if (row) {
      const contract = mapContract(row)
      this.persistNormalizedRecords(row, contract)
      return contract
    }
    const card = this.card(cardId)
    const dependencies = card.milestone_id == null || card.step_order == null ? [] :
      (this.db.prepare(`SELECT id FROM cards WHERE milestone_id=? AND step_order<? ORDER BY step_order, id`)
        .all(card.milestone_id, card.step_order) as Array<{ id: number }>).map((item) => item.id)
    const workspace = this.db.prepare(`SELECT id FROM workspaces WHERE card_id=? AND status!='archived'
      ORDER BY created_at DESC LIMIT 1`).get(cardId) as { id: string } | undefined
    const objective = card.description.trim() || card.title
    const compatibility = compatibilityRecords(objective)
    const at = timestamp()
    this.db.prepare(`INSERT INTO task_contracts
      (card_id, objective, deliverables, acceptance_criteria, dependencies, base_ref, verify_commands,
       non_goals, risks, budget_tokens, budget_cents, priority, policy_id, workspace_id, version, updated_at)
      VALUES (?, ?, ?, ?, ?, 'HEAD', '[]', '[]', '[]', NULL, NULL, 0, NULL, ?, 1, ?)`)
      .run(cardId, objective, JSON.stringify(compatibility.deliverables), JSON.stringify(compatibility.criteria),
        JSON.stringify(dependencies), workspace?.id ?? null, at)
    return this.getOrCreate(cardId)
  }

  put(cardId: number, input: PutTaskContract): TaskContract {
    const card = this.card(cardId)
    const current = this.getOrCreate(cardId)
    const objective = input.objective === undefined ? current.objective : String(input.objective).trim()
    if (!objective) throw new ValidationError('objective is required')
    if (objective.length > 20_000) throw new ValidationError('objective must be at most 20000 characters')

    const objectiveChanged = objective !== current.objective
    const fallback = compatibilityRecords(objective)
    const deliverables = input.deliverables === undefined
      ? objectiveChanged && current.deliverables.every(isCompatibilityRecord) ? fallback.deliverables : current.deliverables
      : normalizeDeliverables(input.deliverables, current.deliverables)
    const criteria = input.acceptance_criteria === undefined
      ? objectiveChanged && current.acceptance_criteria.every(isCompatibilityRecord) ? fallback.criteria : current.acceptance_criteria
      : normalizeAcceptanceCriteria(input.acceptance_criteria, current.acceptance_criteria)
    const promised = deliverables.length ? deliverables : compatibilityDeliverables(objective)
    const acceptance = criteria.length ? criteria : compatibilityCriteria(objective, promised)
    assertCriterionDeliverables(acceptance, promised)

    const dependencies = input.dependencies === undefined ? current.dependencies : integerArray(input.dependencies, 'dependencies')
    if (dependencies.includes(cardId)) throw new ValidationError('a task cannot depend on itself')
    this.assertDependencies(card.board_id, dependencies)
    if (this.createsDependencyCycle(cardId, dependencies)) throw new ValidationError('dependencies would create a cycle')
    const verifyCommands = input.verify_commands === undefined ? current.verify_commands
      : boundedContractStrings(stringArray(input.verify_commands, 'verify_commands'), 'verify_commands', 8_000)
    const nonGoals = input.non_goals === undefined ? current.non_goals
      : boundedContractStrings(stringArray(input.non_goals, 'non_goals'), 'non_goals', MAX_CONTRACT_TEXT)
    const risks = input.risks === undefined ? current.risks
      : boundedContractStrings(stringArray(input.risks, 'risks'), 'risks', MAX_CONTRACT_TEXT)
    const policyId = input.policy_id === undefined ? current.policy_id : nullableString(input.policy_id, 'policy_id')
    const workspaceId = input.workspace_id === undefined ? current.workspace_id : nullableString(input.workspace_id, 'workspace_id')
    this.assertPolicy(card.board_id, policyId)
    this.assertWorkspace(card.board_id, cardId, workspaceId)
    const priorityValue = input.priority === undefined ? current.priority : Number(input.priority)
    if (!Number.isSafeInteger(priorityValue)) throw new ValidationError('priority must be an integer')
    const next = {
      objective,
      deliverables: promised,
      acceptance_criteria: acceptance,
      dependencies,
      base_ref: input.base_ref === undefined ? current.base_ref : nullableString(input.base_ref, 'base_ref'),
      verify_commands: verifyCommands,
      non_goals: nonGoals,
      risks,
      budget_tokens: input.budget_tokens === undefined ? current.budget_tokens : optionalInteger(input.budget_tokens, 'budget_tokens'),
      budget_cents: input.budget_cents === undefined ? current.budget_cents : optionalInteger(input.budget_cents, 'budget_cents'),
      priority: priorityValue,
      policy_id: policyId,
    }
    const currentAsked = askedFields(current)
    const semanticChanged = stableStringify(next) !== stableStringify(currentAsked)
    const workspaceChanged = workspaceId !== current.workspace_id
    if (!semanticChanged && !workspaceChanged) return current

    if (semanticChanged) {
      this.db.prepare(`UPDATE task_contracts SET objective=@objective, deliverables=@deliverables,
        acceptance_criteria=@acceptance, dependencies=@dependencies, base_ref=@base_ref,
        verify_commands=@verify_commands, non_goals=@non_goals, risks=@risks,
        budget_tokens=@budget_tokens, budget_cents=@budget_cents, priority=@priority,
        policy_id=@policy_id, workspace_id=@workspace_id, version=@version, updated_at=@updated_at
        WHERE card_id=@card_id`).run({
        card_id: cardId,
        objective: next.objective,
        deliverables: JSON.stringify(next.deliverables),
        acceptance: JSON.stringify(next.acceptance_criteria),
        dependencies: JSON.stringify(next.dependencies),
        base_ref: next.base_ref,
        verify_commands: JSON.stringify(next.verify_commands),
        non_goals: JSON.stringify(next.non_goals),
        risks: JSON.stringify(next.risks),
        budget_tokens: next.budget_tokens,
        budget_cents: next.budget_cents,
        priority: next.priority,
        policy_id: next.policy_id,
        workspace_id: workspaceId,
        version: current.version + 1,
        updated_at: timestamp(),
      })
    } else {
      this.db.prepare('UPDATE task_contracts SET workspace_id=? WHERE card_id=?').run(workspaceId, cardId)
    }
    const contract = this.getOrCreate(cardId)
    this.events?.append({ boardId: card.board_id, cardId, workspaceId, kind: 'task_contract.updated', source: 'api',
      payload: { objective: contract.objective, dependencies: contract.dependencies, priority: contract.priority,
        version: contract.version, semantic_change: semanticChanged } })
    return contract
  }

  private persistNormalizedRecords(row: Record<string, unknown>, contract: TaskContract): void {
    const deliverables = JSON.stringify(contract.deliverables)
    const criteria = JSON.stringify(contract.acceptance_criteria)
    if (String(row.deliverables ?? '[]') === deliverables && String(row.acceptance_criteria ?? '[]') === criteria) return
    this.db.prepare('UPDATE task_contracts SET deliverables=?, acceptance_criteria=? WHERE card_id=?')
      .run(deliverables, criteria, contract.card_id)
  }

  private card(id: number): { id: number; board_id: number; title: string; description: string; milestone_id: number | null; step_order: number | null } {
    const card = this.db.prepare(`SELECT id, board_id, title, description, milestone_id, step_order FROM cards WHERE id=?`).get(id) as any
    if (!card) throw new NotFoundError('card not found')
    return card
  }

  private assertDependencies(boardId: number, ids: number[]): void {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(',')
    const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM cards WHERE board_id=? AND id IN (${placeholders})`)
      .get(boardId, ...ids) as { count: number }).count
    if (count !== ids.length) throw new ValidationError('dependencies must reference cards on the same board')
  }

  private assertPolicy(boardId: number, id: string | null): void {
    if (!id) return
    const row = this.db.prepare('SELECT board_id FROM policies WHERE id=?').get(id) as { board_id: number } | undefined
    if (!row) throw new NotFoundError('policy not found')
    if (row.board_id !== boardId) throw new ValidationError('policy belongs to a different board')
  }

  private assertWorkspace(boardId: number, cardId: number, id: string | null): void {
    if (!id) return
    const row = this.db.prepare('SELECT board_id, card_id FROM workspaces WHERE id=?').get(id) as { board_id: number; card_id: number | null } | undefined
    if (!row) throw new NotFoundError('workspace not found')
    if (row.board_id !== boardId) throw new ValidationError('workspace belongs to a different board')
    if (row.card_id != null && row.card_id !== cardId) throw new ValidationError('workspace is linked to a different card')
  }

  private createsDependencyCycle(cardId: number, dependencies: number[]): boolean {
    const pending = [...dependencies]
    const seen = new Set<number>()
    while (pending.length) {
      const dependency = pending.pop()!
      if (dependency === cardId) return true
      if (seen.has(dependency)) continue
      seen.add(dependency)
      const row = this.db.prepare('SELECT dependencies FROM task_contracts WHERE card_id=?').get(dependency) as { dependencies: string } | undefined
      pending.push(...parseJson<number[]>(row?.dependencies, []))
    }
    return false
  }
}

export function normalizeContractText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

export function normalizeDeliverables(value: unknown, current: ContractDeliverable[] = []): ContractDeliverable[] {
  if (!Array.isArray(value) || value.length > MAX_CONTRACT_RECORDS) {
    throw new ValidationError(`deliverables must be an array of at most ${MAX_CONTRACT_RECORDS} records`)
  }
  return normalizeRecords(value, 'deliverable', current, (item, match, id, text, required, metadata) => ({
    id, text, required, metadata: mergeMetadata(item, match?.metadata, metadata),
  }))
}

export function normalizeAcceptanceCriteria(
  value: unknown,
  current: ContractAcceptanceCriterion[] = [],
): ContractAcceptanceCriterion[] {
  if (!Array.isArray(value) || value.length > MAX_CONTRACT_RECORDS) {
    throw new ValidationError(`acceptance_criteria must be an array of at most ${MAX_CONTRACT_RECORDS} records`)
  }
  return normalizeRecords(value, 'criterion', current, (item, match, id, text, required, metadata) => {
    const object = isRecord(item) ? item : null
    const rawIds = object?.deliverable_ids ?? object?.deliverableIds
    const deliverableIds = rawIds === undefined ? match?.deliverable_ids ?? [] : normalizedIds(rawIds, 'deliverable_ids')
    return { id, text, required, deliverable_ids: deliverableIds,
      metadata: mergeMetadata(item, match?.metadata, metadata, ['deliverable_ids', 'deliverableIds']) }
  })
}

function mapContract(row: Record<string, unknown>): TaskContract {
  const objective = String(row.objective)
  const rawDeliverables = parseJson<unknown[]>(row.deliverables, [])
  const deliverables = normalizeDeliverables(rawDeliverables)
  const promised = deliverables.length ? deliverables : compatibilityDeliverables(objective)
  const rawCriteria = parseJson<unknown[]>(row.acceptance_criteria, [])
  const criteria = normalizeAcceptanceCriteria(rawCriteria)
  return {
    card_id: Number(row.card_id),
    objective,
    deliverables: promised,
    acceptance_criteria: criteria.length ? criteria : compatibilityCriteria(objective, promised),
    dependencies: parseJson<number[]>(row.dependencies, []),
    base_ref: row.base_ref == null ? null : String(row.base_ref),
    verify_commands: parseJson<string[]>(row.verify_commands, []),
    non_goals: parseJson<string[]>(row.non_goals, []),
    risks: parseJson<string[]>(row.risks, []),
    budget_tokens: row.budget_tokens == null ? null : Number(row.budget_tokens),
    budget_cents: row.budget_cents == null ? null : Number(row.budget_cents),
    priority: Number(row.priority),
    policy_id: row.policy_id == null ? null : String(row.policy_id),
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    version: Number(row.version ?? 1),
    updated_at: String(row.updated_at),
  }
}

function normalizeRecords<T extends { id: string; text: string; required: boolean; metadata: Record<string, unknown> }>(
  input: unknown[],
  prefix: 'deliverable' | 'criterion',
  current: T[],
  build: (input: unknown, match: T | undefined, id: string, text: string, required: boolean,
    metadata: Record<string, unknown>) => T,
): T[] {
  const unused = new Set(current.map((item) => item.id))
  const used = new Set<string>()
  return input.map((item) => {
    const object = isRecord(item) ? item : null
    const text = contractText(item, prefix)
    const explicitId = object?.id === undefined ? null : contractId(object.id, `${prefix}.id`)
    const match = explicitId
      ? current.find((candidate) => candidate.id === explicitId)
      : current.find((candidate) => unused.has(candidate.id)
        && normalizeContractText(candidate.text) === normalizeContractText(text))
    if (match) unused.delete(match.id)
    const id = explicitId ?? match?.id ?? generatedId(prefix, text, used)
    if (used.has(id)) throw new ValidationError(`${prefix} ids must be unique`)
    used.add(id)
    const required = object?.required === undefined ? match?.required ?? true : booleanValue(object.required, `${prefix}.required`)
    const metadata = object?.metadata === undefined ? match?.metadata ?? {} : metadataValue(object.metadata, `${prefix}.metadata`)
    return build(item, match, id, text, required, metadata)
  })
}

function compatibilityRecords(objective: string): {
  deliverables: ContractDeliverable[]
  criteria: ContractAcceptanceCriterion[]
} {
  const deliverables = compatibilityDeliverables(objective)
  return { deliverables, criteria: compatibilityCriteria(objective, deliverables) }
}

function compatibilityDeliverables(objective: string): ContractDeliverable[] {
  return normalizeDeliverables([{ text: objective, required: true, metadata: { compatibility: true } }])
}

function compatibilityCriteria(objective: string, deliverables: ContractDeliverable[]): ContractAcceptanceCriterion[] {
  return normalizeAcceptanceCriteria([{
    text: `Satisfy objective: ${objective}`,
    required: true,
    deliverable_ids: deliverables.map((item) => item.id),
    metadata: { compatibility: true },
  }])
}

function isCompatibilityRecord(item: { metadata: Record<string, unknown> }): boolean {
  return item.metadata.compatibility === true
}

function askedFields(contract: TaskContract) {
  return {
    objective: contract.objective,
    deliverables: contract.deliverables,
    acceptance_criteria: contract.acceptance_criteria,
    dependencies: contract.dependencies,
    base_ref: contract.base_ref,
    verify_commands: contract.verify_commands,
    non_goals: contract.non_goals,
    risks: contract.risks,
    budget_tokens: contract.budget_tokens,
    budget_cents: contract.budget_cents,
    priority: contract.priority,
    policy_id: contract.policy_id,
  }
}

function generatedId(prefix: string, text: string, used: Set<string>): string {
  const digest = createHash('sha256').update(normalizeContractText(text)).digest('hex').slice(0, 16)
  const base = `${prefix}-${digest}`
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function contractText(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value : isRecord(value)
    ? value.text ?? value.description ?? value.kind : undefined
  if (typeof raw !== 'string' || !raw.trim()) throw new ValidationError(`${field}.text is required`)
  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length > MAX_CONTRACT_TEXT) throw new ValidationError(`${field}.text must be at most ${MAX_CONTRACT_TEXT} characters`)
  return text
}

function contractId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.trim())) {
    throw new ValidationError(`${field} must be a stable identifier`)
  }
  return value.trim()
}

function normalizedIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array of stable identifiers`)
  return [...new Set(value.map((item) => contractId(item, field)))]
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean`)
  return value
}

function metadataValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError(`${field} must be an object`)
  try {
    const json = JSON.stringify(value)
    if (json.length > MAX_CONTRACT_METADATA) {
      throw new ValidationError(`${field} must be at most ${MAX_CONTRACT_METADATA} serialized characters`)
    }
    return JSON.parse(json) as Record<string, unknown>
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError(`${field} must be JSON-serializable`)
  }
}

function mergeMetadata(
  item: unknown,
  current: Record<string, unknown> | undefined,
  explicit: Record<string, unknown>,
  excluded: string[] = [],
): Record<string, unknown> {
  if (!isRecord(item)) return { ...(current ?? explicit) }
  const metadata = { ...explicit }
  for (const [key, value] of Object.entries(item)) {
    if (['id', 'text', 'description', 'required', 'metadata', ...excluded].includes(key)) continue
    metadata[key] = value
  }
  return metadataValue(metadata, 'contract metadata')
}

function assertCriterionDeliverables(
  criteria: ContractAcceptanceCriterion[],
  deliverables: ContractDeliverable[],
): void {
  const ids = new Set(deliverables.map((item) => item.id))
  for (const criterion of criteria) {
    if (criterion.deliverable_ids.some((id) => !ids.has(id))) {
      throw new ValidationError(`criterion ${criterion.id} references an unknown deliverable id`)
    }
  }
}

function boundedContractStrings(value: string[], field: string, maxLength: number): string[] {
  if (value.length > MAX_CONTRACT_STRINGS) {
    throw new ValidationError(`${field} accepts at most ${MAX_CONTRACT_STRINGS} values`)
  }
  if (value.some((item) => item.length > maxLength)) {
    throw new ValidationError(`${field} values must be at most ${maxLength} characters`)
  }
  return value
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string or null`)
  return value.trim() || null
}
