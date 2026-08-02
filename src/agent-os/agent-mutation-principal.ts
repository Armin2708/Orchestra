import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyRequest } from 'fastify'
import { ForbiddenError } from './errors.js'
import { tokenEquals } from '../token.js'

export interface AgentMutationPrincipal {
  agentId: number
  boardId: number
  profileId: string
  provider: string
  providerSessionId: string
  sessionId: string
  jobId: string | null
  jobAssignmentId: string | null
  assignmentMarketVersion: number | null
}

interface AgentCredentialRow {
  id: number
  board_id: number
  kind: string
  provider: string | null
  external_session_id: string | null
  hook_token_hash: string | null
  status: string
}

interface CanonicalSessionRow {
  id: string
  profile_id: string
  job_id: string | null
  job_assignment_id: string | null
  assigned_profile_id: string | null
  assignment_market_version: number | null
}

/**
 * Resolves the existing per-provider hook credential into canonical Agent OS identity.
 * The shared agent bearer is only a transport gate; it never supplies mutation identity.
 */
export function resolveAgentMutationPrincipal(
  db: Database.Database,
  request: FastifyRequest,
): AgentMutationPrincipal | null {
  if (request.orchestraPrincipal !== 'agent') return null
  const agentId = positiveHeaderInteger(request, 'x-orchestra-agent-id')
  const provider = header(request, 'x-orchestra-provider')
  const providerSessionId = header(request, 'x-orchestra-session-id')
  const sessionToken = header(request, 'x-orchestra-session-token')
  if (!agentId || !provider || !providerSessionId || !sessionToken) return null

  const agent = db.prepare(`SELECT id, board_id, kind, provider, external_session_id,
      hook_token_hash, status FROM agents WHERE id=?`).get(agentId) as
    | AgentCredentialRow
    | undefined
  if (!agent || !['session', 'hired'].includes(agent.kind) || agent.status === 'gone'
    || agent.provider !== provider || agent.external_session_id !== providerSessionId
    || !agent.hook_token_hash) return null
  const presentedHash = createHash('sha256').update(sessionToken).digest('hex')
  if (!tokenEquals(presentedHash, agent.hook_token_hash)) return null

  const session = db.prepare(`SELECT s.id, s.profile_id, s.job_id, s.job_assignment_id,
      s.assigned_profile_id, s.assignment_market_version
      FROM agent_sessions s JOIN workspaces w ON w.id=s.workspace_id
      JOIN agent_profiles p ON p.id=s.profile_id AND p.board_id=w.board_id
        AND p.status='active'
      WHERE w.board_id=? AND s.agent_id=? AND s.profile_id IS NOT NULL
        AND s.provider=? AND s.external_id=?
        AND s.status NOT IN ('completed', 'stopped', 'failed', 'archived')
        AND (s.assigned_profile_id IS NULL OR s.assigned_profile_id=s.profile_id)
      ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 1`)
    .get(agent.board_id, agent.id, provider, providerSessionId) as
      | CanonicalSessionRow
      | undefined
  if (!session) return null
  return {
    agentId: agent.id,
    boardId: agent.board_id,
    profileId: session.profile_id,
    provider,
    providerSessionId,
    sessionId: session.id,
    jobId: session.job_id,
    jobAssignmentId: session.job_assignment_id,
    assignmentMarketVersion: session.assignment_market_version,
  }
}

export function requireAgentOwnsDelivery(
  db: Database.Database,
  principal: AgentMutationPrincipal,
  deliveryId: string,
): void {
  const delivery = db.prepare(`SELECT dr.board_id, dr.job_id, j.assigned_profile_id,
      j.job_assignment_id, j.assignment_market_version
      FROM delivery_reports dr LEFT JOIN jobs j ON j.id=dr.job_id
      WHERE dr.id=?`).get(deliveryId) as {
        board_id: number
        job_id: string | null
        assigned_profile_id: string | null
        job_assignment_id: string | null
        assignment_market_version: number | null
      } | undefined
  if (!delivery || delivery.board_id !== principal.boardId || !delivery.job_id
    || delivery.job_id !== principal.jobId
    || delivery.assigned_profile_id !== principal.profileId
    || delivery.job_assignment_id !== principal.jobAssignmentId
    || delivery.assignment_market_version !== principal.assignmentMarketVersion) {
    throw new ForbiddenError('agent credential does not own this Delivery assignment')
  }
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512) {
    return null
  }
  return value
}

function positiveHeaderInteger(request: FastifyRequest, name: string): number | null {
  const value = header(request, name)
  if (!value || !/^\d+$/u.test(value)) return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result > 0 ? result : null
}
