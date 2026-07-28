import type Database from 'better-sqlite3'
import { canonicalHash } from './agent-home-support.js'
import { ConflictError, ValidationError } from './errors.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { timestamp } from './json.js'

export type CommandReceiptName =
  | 'workspace.create'
  | 'checkpoint.create'
  | 'policy.create'
  | 'delivery.submit'
  | 'delivery.accept'
  | 'job.cancel'

export type CommandRequestIdentity = {
  boardId: number
  idempotencyKey: string
  command: CommandReceiptName
  scopeId: string
  requestFingerprint: string
}

export type CommandReceipt = {
  board_id: number
  idempotency_key: string
  command: CommandReceiptName
  scope_id: string
  request_fingerprint: string
  status: 'pending' | 'succeeded' | 'failed'
  result_id: string | null
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export function commandRequestIdentity(input: {
  boardId: number
  idempotencyKey?: string | null
  command: CommandReceiptName
  scopeId: string
  request: unknown
}): CommandRequestIdentity | null {
  if (input.idempotencyKey == null) return null
  const idempotencyKey = resolveIdempotencyKey({
    camel: input.idempotencyKey,
  })
  if (!idempotencyKey) return null
  const scopeId = input.scopeId.trim()
  if (!scopeId || scopeId.length > 512) {
    throw new ValidationError('command idempotency scope must be between 1 and 512 characters')
  }
  return {
    boardId: input.boardId,
    idempotencyKey,
    command: input.command,
    scopeId,
    requestFingerprint: canonicalHash({
      command: input.command,
      scope_id: scopeId,
      request: input.request,
    }),
  }
}

export class CommandIdempotencyStore {
  constructor(private readonly db: Database.Database) {}

  replay(identity: CommandRequestIdentity): CommandReceipt | null {
    const receipt = this.db.prepare(`
      SELECT * FROM os_command_receipts
      WHERE board_id=? AND idempotency_key=?
    `).get(identity.boardId, identity.idempotencyKey) as CommandReceipt | undefined
    if (!receipt) return null
    if (receipt.command !== identity.command
      || receipt.scope_id !== identity.scopeId
      || receipt.request_fingerprint !== identity.requestFingerprint) {
      throw new ConflictError(
        'idempotency key was already used for a different command request',
      )
    }
    return receipt
  }

  succeededResult(receipt: CommandReceipt): string {
    if (receipt.status === 'pending') {
      throw new ConflictError('idempotent command is still in progress')
    }
    if (receipt.status === 'failed') {
      throw new ConflictError(
        `idempotent command previously failed: ${receipt.error_message ?? 'unknown failure'}`,
      )
    }
    if (!receipt.result_id) {
      throw new ConflictError('idempotent command receipt is missing its result')
    }
    return receipt.result_id
  }

  recordSucceeded(
    identity: CommandRequestIdentity,
    resultId: string,
  ): CommandReceipt {
    const existing = this.replay(identity)
    if (existing) {
      if (this.succeededResult(existing) !== resultId) {
        throw new ConflictError('idempotent command completed with a different result')
      }
      return existing
    }
    const at = timestamp()
    this.db.prepare(`
      INSERT INTO os_command_receipts (
        board_id, idempotency_key, command, scope_id, request_fingerprint,
        status, result_id, error_message, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'succeeded', ?, NULL, ?, ?)
    `).run(
      identity.boardId,
      identity.idempotencyKey,
      identity.command,
      identity.scopeId,
      identity.requestFingerprint,
      resultId,
      at,
      at,
    )
    return this.replay(identity)!
  }

  claim(identity: CommandRequestIdentity): {
    receipt: CommandReceipt
    replay: boolean
  } {
    const claim = this.db.transaction(() => {
      const existing = this.replay(identity)
      if (existing) return { receipt: existing, replay: true }
      this.db.prepare(`
        INSERT INTO os_command_receipts (
          board_id, idempotency_key, command, scope_id, request_fingerprint,
          status, result_id, error_message, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)
      `).run(
        identity.boardId,
        identity.idempotencyKey,
        identity.command,
        identity.scopeId,
        identity.requestFingerprint,
        timestamp(),
      )
      return { receipt: this.replay(identity)!, replay: false }
    })
    return claim.immediate()
  }

  succeed(identity: CommandRequestIdentity, resultId: string): CommandReceipt {
    const at = timestamp()
    const updated = this.db.prepare(`
      UPDATE os_command_receipts
      SET status='succeeded', result_id=?, error_message=NULL, completed_at=?
      WHERE board_id=? AND idempotency_key=? AND command=? AND scope_id=?
        AND request_fingerprint=? AND status='pending'
    `).run(
      resultId,
      at,
      identity.boardId,
      identity.idempotencyKey,
      identity.command,
      identity.scopeId,
      identity.requestFingerprint,
    )
    const receipt = this.replay(identity)
    if (!receipt) {
      throw new ConflictError('idempotent command receipt disappeared before completion')
    }
    if (updated.changes === 0
      && (receipt.status !== 'succeeded' || receipt.result_id !== resultId)) {
      throw new ConflictError('idempotent command completed with a different result')
    }
    return receipt
  }

  fail(identity: CommandRequestIdentity, error: unknown): CommandReceipt {
    const message = commandFailureMessage(error)
    const updated = this.db.prepare(`
      UPDATE os_command_receipts
      SET status='failed', error_message=?, completed_at=?
      WHERE board_id=? AND idempotency_key=? AND command=? AND scope_id=?
        AND request_fingerprint=? AND status='pending'
    `).run(
      message,
      timestamp(),
      identity.boardId,
      identity.idempotencyKey,
      identity.command,
      identity.scopeId,
      identity.requestFingerprint,
    )
    const receipt = this.replay(identity)
    if (!receipt) {
      throw new ConflictError('idempotent command receipt disappeared before failure')
    }
    if (updated.changes === 0 && receipt.status !== 'failed') {
      throw new ConflictError('idempotent command completed before failure was recorded')
    }
    return receipt
  }
}

function commandFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return (normalized || 'command failed').slice(0, 4000)
}
