export const REMOTE_SCOPES = [
  'observe',
  'stream',
  'message',
  'approve',
  'agent-control',
  'terminal-write',
  'admin',
] as const

export type RemoteScope = typeof REMOTE_SCOPES[number]

export type StepUpGrant = {
  id: string
  active_until: string
  action: string
  resource_type: string
  resource_id: string
  request_digest: string
  nonce: string
}

export type RemoteDeviceSession = {
  device_session_id: string
  name: string
  scopes: RemoteScope[]
  expires_at: string
  credential_expires_at: string
  step_up: StepUpGrant | null
}

const remoteScopeSet = new Set<string>(REMOTE_SCOPES)

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

const asString = (value: unknown): string => typeof value === 'string' ? value : ''

const normalizedScopes = (value: unknown): RemoteScope[] => {
  let candidates: unknown[] = []
  if (Array.isArray(value)) candidates = value
  else if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      candidates = Array.isArray(parsed) ? parsed : value.split(',')
    } catch {
      candidates = value.split(',')
    }
  }
  return [...new Set(candidates
    .map((scope) => String(scope).trim())
    .filter((scope): scope is RemoteScope => remoteScopeSet.has(scope)))]
}

export function normalizeRemoteDeviceSession(value: unknown): RemoteDeviceSession | null {
  const envelope = asObject(value)
  const source = asObject(envelope.device ?? envelope.session ?? value)
  const id = asString(source.device_session_id ?? source.id)
  if (!id) return null
  const rawStepUp = source.step_up ?? envelope.step_up
  const stepUpSource = asObject(rawStepUp)
  const stepUp = rawStepUp && asString(stepUpSource.id) && asString(stepUpSource.active_until)
    && asString(stepUpSource.action) && asString(stepUpSource.request_digest) && asString(stepUpSource.nonce)
    ? {
        id: asString(stepUpSource.id),
        active_until: asString(stepUpSource.active_until),
        action: asString(stepUpSource.action),
        resource_type: asString(stepUpSource.resource_type),
        resource_id: asString(stepUpSource.resource_id),
        request_digest: asString(stepUpSource.request_digest),
        nonce: asString(stepUpSource.nonce),
      }
    : null

  return {
    device_session_id: id,
    name: asString(source.name) || 'Unnamed device',
    scopes: normalizedScopes(source.scopes),
    expires_at: asString(source.expires_at),
    credential_expires_at: asString(source.credential_expires_at),
    step_up: stepUp,
  }
}

const notExpired = (value: string, now: number): boolean => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > now
}

export function remoteSessionIsActive(
  session: RemoteDeviceSession | null,
  now = Date.now(),
): session is RemoteDeviceSession {
  return session !== null
    && notExpired(session.expires_at, now)
    && notExpired(session.credential_expires_at, now)
}

export function hasRemoteScope(
  session: RemoteDeviceSession | null,
  scope: RemoteScope,
  now = Date.now(),
): boolean {
  return Boolean(remoteSessionIsActive(session, now) && session?.scopes.includes(scope))
}

export function hasMatchingStepUp(
  session: RemoteDeviceSession,
  action: RemoteScope,
  resourceType: string,
  resourceId: string,
  now = Date.now(),
): boolean {
  const grant = session.step_up
  const expectedAction = action === 'admin' && resourceType === 'device' ? 'device.revoke' : action
  return Boolean(
    remoteSessionIsActive(session, now)
    && grant
    && grant.action === expectedAction
    && grant.resource_type === resourceType
    && grant.resource_id === resourceId
    && notExpired(grant.active_until, now),
  )
}

export function remoteCanUse(
  session: RemoteDeviceSession | null,
  online: boolean,
  scope: RemoteScope,
  resourceType?: string,
  resourceId?: string,
  now = Date.now(),
): boolean {
  if (!session || !online || !hasRemoteScope(session, scope, now)) return false
  if (scope === 'observe' || scope === 'stream' || scope === 'message' || scope === 'approve') return true
  if (!resourceType || !resourceId) return false
  return hasMatchingStepUp(session, scope, resourceType, resourceId, now)
}

export function matchesDeviceRevokeGrant(
  session: RemoteDeviceSession | null,
  targetDeviceId: string,
  requestDigest: string,
  expectedNonce: string,
  now = Date.now(),
): session is RemoteDeviceSession & { step_up: StepUpGrant } {
  if (!session || !hasRemoteScope(session, 'admin', now)
    || !hasMatchingStepUp(session, 'admin', 'device', targetDeviceId, now)) return false
  const grant = session.step_up
  return Boolean(
    grant
    && /^sha256:[0-9a-f]{64}$/u.test(requestDigest)
    && grant.request_digest === requestDigest
    && grant.id.length > 0
    && expectedNonce.length > 0
    && grant.nonce === expectedNonce,
  )
}

const allowedDeepLinkKeys = new Set([
  'board', 'card', 'agent', 'session', 'conversation', 'workspace',
  'attention', 'approval', 'question', 'review', 'conflict',
])
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function safeNotificationPath(value: unknown, origin: string): string {
  if (typeof value !== 'string' || !value.trim()) return '/'
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin || url.pathname !== '/') return '/'
    const safe = new URLSearchParams()
    for (const [key, item] of url.searchParams) {
      if (allowedDeepLinkKeys.has(key) && identifier.test(item)) safe.append(key, item)
    }
    const query = safe.toString()
    return query ? `/?${query}` : '/'
  } catch {
    return '/'
  }
}
