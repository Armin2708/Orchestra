import type Database from 'better-sqlite3'
import { NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { integerArray, optionalInteger, parseJson, stringArray, timestamp } from './json.js'

export interface TaskContract {
  card_id: number
  objective: string
  acceptance_criteria: unknown[]
  dependencies: number[]
  base_ref: string | null
  verify_commands: string[]
  budget_tokens: number | null
  budget_cents: number | null
  priority: number
  policy_id: string | null
  workspace_id: string | null
  updated_at: string
}

export interface PutTaskContract {
  objective?: unknown
  acceptance_criteria?: unknown
  dependencies?: unknown
  base_ref?: unknown
  verify_commands?: unknown
  budget_tokens?: unknown
  budget_cents?: unknown
  priority?: unknown
  policy_id?: unknown
  workspace_id?: unknown
}

export class TaskContractService {
  constructor(private readonly db: Database.Database, private readonly events?: EventStore) {}

  getOrCreate(cardId: number): TaskContract {
    const row = this.db.prepare('SELECT * FROM task_contracts WHERE card_id=?').get(cardId) as Record<string, unknown> | undefined
    if (row) return mapContract(row)
    const card = this.card(cardId)
    const dependencies = card.milestone_id == null || card.step_order == null ? [] :
      (this.db.prepare(`SELECT id FROM cards WHERE milestone_id=? AND step_order<? ORDER BY step_order, id`)
        .all(card.milestone_id, card.step_order) as Array<{ id: number }>).map((item) => item.id)
    const workspace = this.db.prepare(`SELECT id FROM workspaces WHERE card_id=? AND status!='archived'
      ORDER BY created_at DESC LIMIT 1`).get(cardId) as { id: string } | undefined
    const objective = card.description.trim() || card.title
    const at = timestamp()
    this.db.prepare(`INSERT INTO task_contracts
      (card_id, objective, acceptance_criteria, dependencies, base_ref, verify_commands,
       budget_tokens, budget_cents, priority, policy_id, workspace_id, updated_at)
      VALUES (?, ?, '[]', ?, 'HEAD', '[]', NULL, NULL, 0, NULL, ?, ?)`)
      .run(cardId, objective, JSON.stringify(dependencies), workspace?.id ?? null, at)
    return this.getOrCreate(cardId)
  }

  put(cardId: number, input: PutTaskContract): TaskContract {
    const card = this.card(cardId)
    const current = this.getOrCreate(cardId)
    const objective = input.objective === undefined ? current.objective : String(input.objective).trim()
    if (!objective) throw new ValidationError('objective is required')
    const acceptance = input.acceptance_criteria === undefined ? current.acceptance_criteria : input.acceptance_criteria
    if (!Array.isArray(acceptance)) throw new ValidationError('acceptance_criteria must be an array')
    const dependencies = input.dependencies === undefined ? current.dependencies : integerArray(input.dependencies, 'dependencies')
    if (dependencies.includes(cardId)) throw new ValidationError('a task cannot depend on itself')
    this.assertDependencies(card.board_id, dependencies)
    if (this.createsDependencyCycle(cardId, dependencies)) throw new ValidationError('dependencies would create a cycle')
    const verifyCommands = input.verify_commands === undefined ? current.verify_commands : stringArray(input.verify_commands, 'verify_commands')
    const policyId = input.policy_id === undefined ? current.policy_id : nullableString(input.policy_id, 'policy_id')
    const workspaceId = input.workspace_id === undefined ? current.workspace_id : nullableString(input.workspace_id, 'workspace_id')
    this.assertPolicy(card.board_id, policyId)
    this.assertWorkspace(card.board_id, cardId, workspaceId)
    const priorityValue = input.priority === undefined ? current.priority : Number(input.priority)
    if (!Number.isSafeInteger(priorityValue)) throw new ValidationError('priority must be an integer')
    const at = timestamp()
    this.db.prepare(`UPDATE task_contracts SET objective=@objective, acceptance_criteria=@acceptance,
      dependencies=@dependencies, base_ref=@base_ref, verify_commands=@verify_commands,
      budget_tokens=@budget_tokens, budget_cents=@budget_cents, priority=@priority,
      policy_id=@policy_id, workspace_id=@workspace_id, updated_at=@updated_at WHERE card_id=@card_id`).run({
      card_id: cardId, objective, acceptance: JSON.stringify(acceptance), dependencies: JSON.stringify(dependencies),
      base_ref: input.base_ref === undefined ? current.base_ref : nullableString(input.base_ref, 'base_ref'),
      verify_commands: JSON.stringify(verifyCommands),
      budget_tokens: input.budget_tokens === undefined ? current.budget_tokens : optionalInteger(input.budget_tokens, 'budget_tokens'),
      budget_cents: input.budget_cents === undefined ? current.budget_cents : optionalInteger(input.budget_cents, 'budget_cents'),
      priority: priorityValue, policy_id: policyId, workspace_id: workspaceId, updated_at: at,
    })
    const contract = this.getOrCreate(cardId)
    this.events?.append({ boardId: card.board_id, cardId, workspaceId, kind: 'task_contract.updated', source: 'api',
      payload: { objective: contract.objective, dependencies: contract.dependencies, priority: contract.priority } })
    return contract
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

function mapContract(row: Record<string, unknown>): TaskContract {
  return {
    card_id: Number(row.card_id), objective: String(row.objective),
    acceptance_criteria: parseJson<unknown[]>(row.acceptance_criteria, []),
    dependencies: parseJson<number[]>(row.dependencies, []), base_ref: row.base_ref == null ? null : String(row.base_ref),
    verify_commands: parseJson<string[]>(row.verify_commands, []),
    budget_tokens: row.budget_tokens == null ? null : Number(row.budget_tokens),
    budget_cents: row.budget_cents == null ? null : Number(row.budget_cents), priority: Number(row.priority),
    policy_id: row.policy_id == null ? null : String(row.policy_id),
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id), updated_at: String(row.updated_at),
  }
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string or null`)
  return value.trim() || null
}
