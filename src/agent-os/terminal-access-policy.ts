export type TerminalAction =
  | 'view'
  | 'history_read'
  | 'select'
  | 'spawn'
  | 'input'
  | 'resize'
  | 'signal'
  | 'restart'
  | 'history_write'

export type TerminalClientSurface = 'desktop' | 'tablet' | 'mobile' | 'unknown'
export type TerminalPrincipalKind = 'local_operator' | 'remote_device' | 'agent' | 'unknown'

export type TerminalMutationGrant = {
  grantId: string
  deviceId: string
  workspaceId: string
  processId: string | null
  actions: readonly Exclude<TerminalAction, 'view' | 'history_read'>[]
  issuedAt: string
  expiresAt: string
  stepUpVerifiedAt: string
}

export type TerminalAccessContext = {
  authenticated: boolean
  principal: TerminalPrincipalKind
  surface: TerminalClientSurface
  scopes: readonly string[]
  deviceId?: string | null
  grant?: TerminalMutationGrant | null
  now?: string
}

export type TerminalResource = {
  workspaceId: string
  processId?: string | null
}

export type TerminalAccessDecision =
  | { allowed: true; reason_code: 'authenticated_view' | 'local_operator' | 'explicit_terminal_write_grant' }
  | {
      allowed: false
      reason_code:
        | 'authentication_required'
        | 'terminal_mutation_denied'
        | 'mobile_view_only_default'
        | 'remote_view_only_default'
        | 'terminal_write_scope_required'
        | 'terminal_write_grant_required'
        | 'terminal_write_grant_invalid'
        | 'terminal_write_grant_expired'
        | 'terminal_write_step_up_stale'
    }

const VIEW_ACTIONS = new Set<TerminalAction>(['view', 'history_read'])
const MAX_STEP_UP_AGE_MS = 5 * 60_000

/**
 * Local desktop/tablet operators retain the existing terminal behavior.
 * Remote devices and every mobile surface are view-only unless an exact,
 * short-lived, step-up verified terminal-write grant is supplied.
 */
export function evaluateTerminalAccess(
  action: TerminalAction,
  resource: TerminalResource,
  context: TerminalAccessContext,
): TerminalAccessDecision {
  if (!context.authenticated) {
    return { allowed: false, reason_code: 'authentication_required' }
  }
  if (VIEW_ACTIONS.has(action)) return { allowed: true, reason_code: 'authenticated_view' }

  if (context.principal === 'local_operator'
    && (context.surface === 'desktop' || context.surface === 'tablet')) {
    return { allowed: true, reason_code: 'local_operator' }
  }
  if (context.principal !== 'remote_device' && context.surface !== 'mobile') {
    return { allowed: false, reason_code: 'terminal_mutation_denied' }
  }
  if (!context.scopes.includes('terminal-write')) {
    return {
      allowed: false,
      reason_code: context.surface === 'mobile'
        ? 'mobile_view_only_default'
        : 'remote_view_only_default',
    }
  }
  if (!context.grant) return { allowed: false, reason_code: 'terminal_write_grant_required' }
  const now = Date.parse(context.now ?? new Date().toISOString())
  const issuedAt = Date.parse(context.grant.issuedAt)
  const expiresAt = Date.parse(context.grant.expiresAt)
  const stepUpAt = Date.parse(context.grant.stepUpVerifiedAt)
  if ([now, issuedAt, expiresAt, stepUpAt].some(Number.isNaN)) {
    return { allowed: false, reason_code: 'terminal_write_grant_invalid' }
  }
  if (expiresAt <= now || issuedAt > now) {
    return { allowed: false, reason_code: 'terminal_write_grant_expired' }
  }
  if (stepUpAt > now || now - stepUpAt > MAX_STEP_UP_AGE_MS) {
    return { allowed: false, reason_code: 'terminal_write_step_up_stale' }
  }
  const processMatches = context.grant.processId === null
    ? resource.processId == null
    : context.grant.processId === (resource.processId ?? null)
  if (!context.grant.grantId.trim()
    || !context.grant.deviceId.trim()
    || context.grant.deviceId !== context.deviceId
    || context.grant.workspaceId !== resource.workspaceId
    || !processMatches
    || !context.grant.actions.includes(action as Exclude<TerminalAction, 'view' | 'history_read'>)) {
    return { allowed: false, reason_code: 'terminal_write_grant_invalid' }
  }
  return { allowed: true, reason_code: 'explicit_terminal_write_grant' }
}
