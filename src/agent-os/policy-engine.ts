import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import picomatch from 'picomatch'
import { NotFoundError, ValidationError } from './errors.js'
import { parseJson, stringArray, timestamp } from './json.js'

export type PolicyKind = 'filesystem' | 'command' | 'network' | 'secret'
export type PolicyDecision = 'allow' | 'ask' | 'deny'

export interface Policy {
  id: string
  board_id: number
  name: string
  file_globs: string[]
  command_globs: string[]
  network_hosts: string[]
  secret_names: string[]
  approval_scope: string
  created_at: string
  updated_at: string
}

export interface PolicyOperation {
  kind: PolicyKind
  value: string
  actor?: 'agent' | 'human'
}

export interface PolicyEvaluation {
  decision: PolicyDecision
  reason: string
  policy_id: string
  kind: PolicyKind
  value: string
  matched_pattern: string | null
}

export interface CreatePolicy {
  boardId: number
  name: string
  fileGlobs?: unknown
  commandGlobs?: unknown
  networkHosts?: unknown
  secretNames?: unknown
  approvalScope?: string
}

export class PolicyEngine {
  constructor(private readonly db: Database.Database) {}

  create(input: CreatePolicy): Policy {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(input.boardId)) throw new NotFoundError('board not found')
    if (!input.name.trim()) throw new ValidationError('policy name is required')
    const at = timestamp()
    const row = {
      id: randomUUID(), board_id: input.boardId, name: input.name.trim(),
      file_globs: JSON.stringify(stringArray(input.fileGlobs, 'file_globs')),
      command_globs: JSON.stringify(stringArray(input.commandGlobs, 'command_globs')),
      network_hosts: JSON.stringify(stringArray(input.networkHosts, 'network_hosts')),
      secret_names: JSON.stringify(stringArray(input.secretNames, 'secret_names')),
      approval_scope: input.approvalScope?.trim() || 'advisory', created_at: at, updated_at: at,
    }
    this.db.prepare(`INSERT INTO policies
      (id, board_id, name, file_globs, command_globs, network_hosts, secret_names, approval_scope, created_at, updated_at)
      VALUES (@id, @board_id, @name, @file_globs, @command_globs, @network_hosts, @secret_names, @approval_scope, @created_at, @updated_at)`)
      .run(row)
    return mapPolicy(row)
  }

  listBoard(boardId: number): Policy[] {
    return (this.db.prepare('SELECT * FROM policies WHERE board_id=? ORDER BY created_at, rowid').all(boardId) as Record<string, unknown>[])
      .map(mapPolicy)
  }

  get(id: string): Policy | null {
    const row = this.db.prepare('SELECT * FROM policies WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? mapPolicy(row) : null
  }

  evaluate(policyId: string, operation: PolicyOperation): PolicyEvaluation {
    const policy = this.get(policyId)
    if (!policy) throw new NotFoundError('policy not found')
    return evaluate(policy, operation)
  }
}

/** Small adapter used by drivers and Conductor without constructing route services. */
export function evaluatePolicy(db: Database.Database, policyId: string, operation: PolicyOperation): PolicyEvaluation {
  return new PolicyEngine(db).evaluate(policyId, operation)
}

export function normalizePolicyOperation(operation: PolicyOperation): PolicyOperation {
  if (!['filesystem', 'command', 'network', 'secret'].includes(operation.kind)) throw new ValidationError('invalid policy operation kind')
  if (typeof operation.value !== 'string' || operation.value.trim() === '') throw new ValidationError('policy operation value is required')
  let value = operation.value.trim()
  if (operation.kind === 'filesystem') {
    value = value.replaceAll('\\', '/')
    if (path.isAbsolute(value)) value = path.normalize(value).replaceAll('\\', '/')
    else value = value.replace(/^\.\//, '')
  } else if (operation.kind === 'command') {
    value = value.replace(/\s+/g, ' ')
  } else if (operation.kind === 'network') {
    try { value = new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase() }
    catch { value = value.toLowerCase().replace(/:\d+$/, '') }
  } else {
    value = value.toUpperCase()
  }
  return { ...operation, value }
}

function evaluate(policy: Policy, raw: PolicyOperation): PolicyEvaluation {
  const operation = normalizePolicyOperation(raw)
  if (operation.actor === 'human' && operation.kind === 'command') {
    return result(policy.id, operation, 'allow', 'manual human terminal input is always allowed and audited', null)
  }
  const patterns = patternsFor(policy, operation.kind)
  const denied = patterns.find((pattern) => pattern.startsWith('!') && matches(operation.kind, operation.value, pattern.slice(1)))
  if (denied) return result(policy.id, operation, 'deny', `blocked by policy pattern ${denied}`, denied)
  const allowed = patterns.find((pattern) => !pattern.startsWith('!') && matches(operation.kind, operation.value, pattern))
  if (allowed) return result(policy.id, operation, 'allow', `allowed by policy pattern ${allowed}`, allowed)
  if (policy.approval_scope === 'deny') return result(policy.id, operation, 'deny', 'operation is outside the policy allow-list', null)
  if (policy.approval_scope === 'allow') return result(policy.id, operation, 'allow', 'policy allows unmatched operations', null)
  return result(policy.id, operation, 'ask', 'operation is outside the policy allow-list and needs approval', null)
}

function patternsFor(policy: Policy, kind: PolicyKind): string[] {
  if (kind === 'filesystem') return policy.file_globs
  if (kind === 'command') return policy.command_globs
  if (kind === 'network') return policy.network_hosts
  return policy.secret_names
}

function matches(kind: PolicyKind, value: string, pattern: string): boolean {
  if (!pattern) return false
  return picomatch.isMatch(value, pattern, { dot: true, nocase: kind === 'network' || kind === 'secret' })
}

function result(policyId: string, operation: PolicyOperation, decision: PolicyDecision, reason: string, pattern: string | null): PolicyEvaluation {
  return { decision, reason, policy_id: policyId, kind: operation.kind, value: operation.value, matched_pattern: pattern }
}

function mapPolicy(row: Record<string, unknown>): Policy {
  return {
    id: String(row.id), board_id: Number(row.board_id), name: String(row.name),
    file_globs: parseJson<string[]>(row.file_globs, []), command_globs: parseJson<string[]>(row.command_globs, []),
    network_hosts: parseJson<string[]>(row.network_hosts, []), secret_names: parseJson<string[]>(row.secret_names, []),
    approval_scope: String(row.approval_scope), created_at: String(row.created_at), updated_at: String(row.updated_at),
  }
}
