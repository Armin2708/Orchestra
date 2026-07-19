import type Database from 'better-sqlite3'
import { evaluatePolicy } from '../agent-os/policy-engine.js'
import type { PolicyOperation } from '../agent-os/policy-engine.js'
import type { CodexDriverApprovalHandler, CodexDriverApprovalRequest } from '../runtime/drivers/codex.js'
import { CODEX_REQUEST_UNHANDLED } from './client.js'

const commandText = (params: unknown): string | null => {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const command = (params as Record<string, unknown>).command
  if (typeof command === 'string' && command.trim()) return command.trim()
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    const joined = command.join(' ').trim()
    return joined || null
  }
  return null
}

const filePath = (params: unknown): string | null => {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const row = params as Record<string, unknown>
  for (const key of ['path', 'filePath', 'file_path']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

const operationFor = (request: CodexDriverApprovalRequest): PolicyOperation | null => {
  if (request.kind === 'command') {
    const value = commandText(request.params)
    return value ? { kind: 'command', value, actor: 'agent' } : null
  }
  if (request.kind === 'file-change') {
    const value = filePath(request.params)
    return value ? { kind: 'filesystem', value, actor: 'agent' } : null
  }
  return null
}

/** Auto-answer only when a durable Agent OS policy is attached and the request is unambiguous. */
export function codexApprovalPolicyHandler(db: Database.Database): CodexDriverApprovalHandler {
  return async (request) => {
    const row = db.prepare(`SELECT tc.policy_id FROM agent_sessions s
      JOIN jobs j ON j.id=json_extract(s.context_json, '$.job_id')
      LEFT JOIN task_contracts tc ON tc.card_id=j.card_id
      WHERE s.provider='codex' AND s.external_id=?
      ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 1`).get(request.threadId) as
      { policy_id: string | null } | undefined
    if (!row?.policy_id) return CODEX_REQUEST_UNHANDLED
    const operation = operationFor(request)
    // A configured policy with malformed or insufficient native data fails closed.
    if (!operation) return { decision: 'decline' }
    try {
      const evaluation = evaluatePolicy(db, row.policy_id, operation)
      if (evaluation.decision === 'allow') return { decision: 'accept' }
      if (evaluation.decision === 'deny') return { decision: 'decline' }
      return CODEX_REQUEST_UNHANDLED
    } catch {
      return { decision: 'decline' }
    }
  }
}
