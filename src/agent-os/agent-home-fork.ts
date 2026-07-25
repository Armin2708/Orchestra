import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { AgentSessionRecord } from './conversations.js'
import { ConflictError } from './errors.js'
import {
  canonicalHash,
  stableJson,
  type ActorIdentity,
} from './agent-home-support.js'
import { parseJson, timestamp } from './json.js'
import { normalizeProjectedText } from './projected-text-redaction.js'

export interface AgentHomeNativeForkProvenance {
  fork_method: 'thread/fork' | 'sdk.forkSession'
  history_boundary: 'full' | 'partial'
  read_verified?: boolean
  subscription_released?: boolean
  file_history_copied?: false
  undo_history_copied?: false
}

export interface AgentHomeForkTarget {
  workspaceId: string
}

export interface AgentHomeNativeForkResult {
  sourceExternalId: string
  externalId: string
  sourceProviderThreadId: string
  providerThreadId: string
  provenance: AgentHomeNativeForkProvenance
}

export interface AgentHomeKnownForkChild {
  externalId: string
  providerThreadId: string
  forkedFromId: string | null
  childProviderSessionId: string | null
  subscriptionReleased: boolean
}

export class AgentHomeForkOutcomeUnknownError extends Error {
  readonly outcomeUnknown = true

  constructor(
    message: string,
    readonly sourceExternalId: string,
    readonly sourceProviderThreadId: string,
    readonly knownChild: AgentHomeKnownForkChild | null = null,
  ) {
    super(message)
    this.name = 'AgentHomeForkOutcomeUnknownError'
  }
}

type SnapshotEventRow = {
  id: string
  sequence: number
  provider: string | null
  kind: string
  actor_type: string
  actor_id: string | null
  projected_text: string | null
  redaction_state: 'none' | 'redacted' | 'withheld'
  retention_class: 'transcript' | 'audit' | 'ephemeral' | 'pinned'
  schema_version: number
  created_at: string
  archived_at: string | null
}

export function persistDetachedAgentHomeFork(
  db: Database.Database,
  input: {
    parent: AgentSessionRecord
    actionId: string
    reservedSessionId: string
    actor: ActorIdentity
    fork: AgentHomeNativeForkResult
    target: AgentHomeForkTarget
    allowOutcomeUnknown?: boolean
  },
): AgentSessionRecord {
  const { parent, actionId, reservedSessionId, actor, fork, target } = input
  if (!parent.profile_id || !parent.conversation_id) {
    throw new ConflictError('fork requires a linked Agent Home session')
  }
  if (!parent.external_id || fork.sourceExternalId !== parent.external_id) {
    throw new ConflictError('fork source external provenance changed')
  }
  const sourceProviderThreadId = parent.provider_thread_id ?? parent.external_id
  if (fork.sourceProviderThreadId !== sourceProviderThreadId) {
    throw new ConflictError('fork source provider thread provenance changed')
  }
  if (!fork.externalId || fork.externalId === parent.external_id
    || !fork.providerThreadId || fork.providerThreadId !== fork.externalId) {
    throw new ConflictError('fork returned an invalid child provider identity')
  }
  const provenance = closedForkProvenance(fork.provenance)

  const persist = db.transaction(() => {
    const action = db.prepare(`SELECT status, effect_state, reserved_session_id, effect_json
      FROM agent_session_actions WHERE id=?`).get(actionId) as {
        status: string
        effect_state: string
        reserved_session_id: string | null
        effect_json: string
      } | undefined
    const normalInvocation = action?.status === 'pending' && action.effect_state === 'invoking'
    const reconciledInvocation = input.allowOutcomeUnknown === true
      && action?.status === 'failed'
      && action.effect_state === 'outcome_unknown'
    if (!action || (!normalInvocation && !reconciledInvocation)
      || action.reserved_session_id !== reservedSessionId) {
      throw new ConflictError('fork action reservation changed before persistence')
    }
    const priorEffect = parseJson<Record<string, unknown>>(action.effect_json, {})
    const priorTarget = forkTargetFromEffect(priorEffect)
    if (!priorTarget || priorTarget.workspaceId !== target.workspaceId) {
      throw new ConflictError('fork target workspace changed before persistence')
    }
    if (db.prepare(`SELECT 1 FROM agent_sessions
      WHERE id=? OR (provider=? AND (external_id=? OR provider_thread_id=?))
      LIMIT 1`).get(
      reservedSessionId,
      parent.provider,
      fork.externalId,
      fork.providerThreadId,
    )) {
      throw new ConflictError('fork child identity already exists')
    }
    const parentWorkspace = db.prepare(`SELECT board_id, root_path,
      COALESCE(worktree_path, root_path) AS execution_path
      FROM workspaces WHERE id=? AND status='active'`).get(parent.workspace_id) as {
        board_id: number
        root_path: string
        execution_path: string
      } | undefined
    const targetWorkspace = db.prepare(`SELECT board_id, kind, root_path, worktree_path, status
      FROM workspaces WHERE id=?`).get(target.workspaceId) as {
        board_id: number
        kind: string
        root_path: string
        worktree_path: string | null
        status: string
      } | undefined
    if (!parentWorkspace || !targetWorkspace
      || target.workspaceId === parent.workspace_id
      || Number(targetWorkspace.board_id) !== Number(parentWorkspace.board_id)
      || targetWorkspace.kind !== 'worktree'
      || targetWorkspace.status !== 'active'
      || !targetWorkspace.worktree_path
      || canonicalFilesystemPath(targetWorkspace.root_path)
        !== canonicalFilesystemPath(parentWorkspace.root_path)
      || canonicalFilesystemPath(targetWorkspace.worktree_path)
        === canonicalFilesystemPath(parentWorkspace.execution_path)) {
      throw new ConflictError('fork target must be a distinct active managed worktree')
    }

    const parentConversation = db.prepare(`SELECT title FROM agent_conversations
      WHERE id=? AND profile_id=? AND status='active'`).get(
      parent.conversation_id,
      parent.profile_id,
    ) as { title: string } | undefined
    if (!parentConversation) {
      throw new ConflictError('fork source conversation is unavailable')
    }
    const sourceEvents = db.prepare(`SELECT id, sequence, provider, kind, actor_type,
      actor_id, projected_text, redaction_state, retention_class, schema_version,
      created_at, archived_at
      FROM conversation_events
      WHERE conversation_id=? AND session_id=?
      ORDER BY sequence`).all(
      parent.conversation_id,
      parent.id,
    ) as SnapshotEventRow[]
    const at = timestamp()
    const conversationId = `agent-home-fork-conversation:${actionId}`
    const displayName = (
      normalizeProjectedText(
        `${parent.display_name ?? parentConversation.title} fork`,
        'none',
      ).value ?? 'Forked session'
    ).slice(0, 200)
    db.prepare(`INSERT INTO agent_conversations (
      id, board_id, profile_id, title, status, is_default, next_sequence,
      created_by_actor_type, created_by_actor_id, created_at, updated_at, archived_at
    ) SELECT ?, board_id, ?, ?, 'active', 0, ?, ?, ?, ?, ?, NULL
      FROM agent_conversations WHERE id=?`).run(
      conversationId,
      parent.profile_id,
      displayName,
      sourceEvents.length + 1,
      actor.type,
      actor.id,
      at,
      at,
      parent.conversation_id,
    )
    const recovery = {
      state: 'detached_native_fork',
      source_session_id: parent.id,
      source_provider_thread_id: fork.sourceProviderThreadId,
      provider_thread_id: fork.providerThreadId,
      fork_method: provenance.fork_method,
      history_boundary: provenance.history_boundary,
      ...(provenance.read_verified === undefined
        ? {}
        : { read_verified: provenance.read_verified }),
      ...(provenance.subscription_released === undefined
        ? {}
        : { subscription_released: provenance.subscription_released }),
      ...(provenance.file_history_copied === undefined
        ? {}
        : { file_history_copied: provenance.file_history_copied }),
      ...(provenance.undo_history_copied === undefined
        ? {}
        : { undo_history_copied: provenance.undo_history_copied }),
    }
    const context = {
      parent_session_id: parent.id,
      lineage_type: 'fork',
      fork_action_id: actionId,
      adoption_state: 'pending',
    }
    const historyState = forkHistoryState(parent, provenance)
    db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, agent_id, provider, external_id, model, status, context_json,
      profile_id, conversation_id, job_id, mode, driver_id, effort, access_profile,
      provider_thread_id, provider_cursor, recovery_state, recovery_json, history_state,
      display_name, parent_session_id, lineage_type, control_state, started_at, ended_at,
      archived_at, created_at, updated_at
    ) VALUES (
      ?, ?, NULL, ?, ?, ?, 'idle', ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL,
      'attachable', ?, ?, ?, ?, 'fork', 'paused', ?, NULL, NULL, ?, ?
    )`).run(
      reservedSessionId,
      target.workspaceId,
      parent.provider,
      fork.externalId,
      parent.model,
      stableJson(context),
      parent.profile_id,
      conversationId,
      parent.mode,
      parent.driver_id,
      parent.effort,
      parent.access_profile,
      fork.providerThreadId,
      stableJson(recovery),
      historyState,
      displayName,
      parent.id,
      at,
      at,
      at,
    )

    const insertSnapshot = db.prepare(`INSERT INTO conversation_events (
      id, board_id, profile_id, conversation_id, session_id, sequence,
      provider, provider_event_id, provider_thread_id, provider_turn_id,
      provider_item_id, provider_cursor, kind, actor_type, actor_id,
      correlation_id, causation_id, projected_text, metadata_json, raw_artifact_id,
      dedupe_key, content_hash, redaction_state, retention_class, schema_version,
      created_at, archived_at
    ) SELECT ?, board_id, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?,
      NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?
      FROM agent_conversations WHERE id=?`)
    sourceEvents.forEach((source, index) => {
      const projected = normalizeProjectedText(
        source.projected_text,
        source.redaction_state,
      )
      const sequence = index + 1
      const metadata = {
        fork_snapshot: true,
        source_conversation_event_id: source.id,
        source_sequence: source.sequence,
      }
      const dedupeKey = `fork:${actionId}:${source.id}`
      const contentHash = canonicalHash({
        conversation_id: conversationId,
        session_id: reservedSessionId,
        sequence,
        provider: source.provider,
        kind: source.kind,
        actor_type: source.actor_type,
        actor_id: source.actor_id,
        projected_text: projected.value,
        metadata,
        dedupe_key: dedupeKey,
        redaction_state: projected.redactionState,
        retention_class: source.retention_class,
        schema_version: source.schema_version,
      })
      insertSnapshot.run(
        randomUUID(),
        parent.profile_id,
        conversationId,
        reservedSessionId,
        sequence,
        source.provider,
        source.kind,
        source.actor_type,
        source.actor_id,
        projected.value,
        stableJson(metadata),
        dedupeKey,
        contentHash,
        projected.redactionState,
        source.retention_class,
        source.schema_version,
        source.created_at,
        source.archived_at,
        parent.conversation_id,
      )
    })

    const effect = {
      child_session_id: reservedSessionId,
      child_conversation_id: conversationId,
      source_session_id: parent.id,
      provider: parent.provider,
      source_provider_thread_id: fork.sourceProviderThreadId,
      provider_thread_id: fork.providerThreadId,
      fork_target: { workspace_id: target.workspaceId },
      adoption: { state: 'pending' },
      provenance: {
        fork_method: provenance.fork_method,
        history_boundary: provenance.history_boundary,
        ...(provenance.read_verified === undefined
          ? {}
          : { read_verified: provenance.read_verified }),
        ...(provenance.subscription_released === undefined
          ? {}
          : { subscription_released: provenance.subscription_released }),
        ...(provenance.file_history_copied === undefined
          ? {}
          : { file_history_copied: provenance.file_history_copied }),
        ...(provenance.undo_history_copied === undefined
          ? {}
          : { undo_history_copied: provenance.undo_history_copied }),
      },
    }
    const updated = db.prepare(`UPDATE agent_session_actions
      SET result_session_id=?, status='pending', effect_state='applied',
        effect_json=?, error_code=NULL, error_message=NULL, updated_at=?
      WHERE id=? AND effect_state IN ('invoking','outcome_unknown')
        AND reserved_session_id=? AND result_session_id IS NULL`).run(
      reservedSessionId,
      stableJson(effect),
      at,
      actionId,
      reservedSessionId,
    )
    if (updated.changes !== 1) {
      throw new ConflictError('fork action changed while persisting its child')
    }
    const row = db.prepare('SELECT * FROM agent_sessions WHERE id=?')
      .get(reservedSessionId) as Record<string, unknown> | undefined
    if (!row) throw new ConflictError('fork child was not persisted')
    return row
  })
  return mapForkSession(persist.immediate())
}

export function forkTargetFromEffect(
  effect: Record<string, unknown>,
): AgentHomeForkTarget | null {
  const raw = effect.fork_target
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const workspaceId = typeof (raw as Record<string, unknown>).workspace_id === 'string'
    ? String((raw as Record<string, unknown>).workspace_id).trim()
    : ''
  return workspaceId ? { workspaceId } : null
}

function closedForkProvenance(
  value: AgentHomeNativeForkProvenance,
): AgentHomeNativeForkProvenance {
  if (value.fork_method === 'thread/fork') {
    if (value.history_boundary !== 'full' && value.history_boundary !== 'partial') {
      throw new ConflictError('Codex fork history boundary is invalid')
    }
    if (typeof value.read_verified !== 'boolean'
      || typeof value.subscription_released !== 'boolean') {
      throw new ConflictError('Codex fork provenance proof is incomplete')
    }
    return {
      fork_method: 'thread/fork',
      history_boundary: value.history_boundary,
      read_verified: value.read_verified,
      subscription_released: value.subscription_released,
    }
  }
  if (value.fork_method === 'sdk.forkSession'
    && (value.history_boundary === 'full' || value.history_boundary === 'partial')
    && value.file_history_copied === false
    && value.undo_history_copied === false) {
    return {
      fork_method: 'sdk.forkSession',
      history_boundary: value.history_boundary,
      file_history_copied: false,
      undo_history_copied: false,
    }
  }
  throw new ConflictError('fork provenance is outside the supported closed contract')
}

function forkHistoryState(
  parent: AgentSessionRecord,
  provenance: AgentHomeNativeForkProvenance,
): AgentSessionRecord['history_state'] {
  if (parent.history_state === 'unavailable') return 'unavailable'
  if (parent.history_state === 'partial' || provenance.history_boundary !== 'full') {
    return 'partial'
  }
  return 'complete'
}

function mapForkSession(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    agent_id: row.agent_id == null ? null : Number(row.agent_id),
    provider: String(row.provider),
    external_id: row.external_id == null ? null : String(row.external_id),
    model: row.model == null ? null : String(row.model),
    status: String(row.status),
    context: JSON.parse(String(row.context_json)) as Record<string, unknown>,
    profile_id: row.profile_id == null ? null : String(row.profile_id),
    conversation_id: row.conversation_id == null ? null : String(row.conversation_id),
    job_id: row.job_id == null ? null : String(row.job_id),
    mode: String(row.mode) as AgentSessionRecord['mode'],
    driver_id: row.driver_id == null ? null : String(row.driver_id),
    effort: row.effort == null ? null : String(row.effort),
    access_profile: row.access_profile == null
      ? null
      : String(row.access_profile) as AgentSessionRecord['access_profile'],
    provider_thread_id: row.provider_thread_id == null
      ? null
      : String(row.provider_thread_id),
    provider_cursor: row.provider_cursor == null ? null : String(row.provider_cursor),
    recovery_state: String(row.recovery_state) as AgentSessionRecord['recovery_state'],
    recovery: JSON.parse(String(row.recovery_json)) as Record<string, unknown>,
    history_state: String(row.history_state) as AgentSessionRecord['history_state'],
    display_name: row.display_name == null ? null : String(row.display_name),
    parent_session_id: row.parent_session_id == null ? null : String(row.parent_session_id),
    lineage_type: row.lineage_type == null
      ? null
      : String(row.lineage_type) as AgentSessionRecord['lineage_type'],
    control_state: String(row.control_state) as AgentSessionRecord['control_state'],
    started_at: row.started_at == null ? null : String(row.started_at),
    ended_at: row.ended_at == null ? null : String(row.ended_at),
    archived_at: row.archived_at == null ? null : String(row.archived_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function canonicalFilesystemPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}
