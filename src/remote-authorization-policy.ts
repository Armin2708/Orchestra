import { createHash } from 'node:crypto'

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

export const DEFAULT_PHONE_SCOPES: readonly RemoteScope[] = Object.freeze([
  'observe',
  'stream',
  'message',
  'approve',
])

export const REMOTE_RESOURCE_TYPES = [
  'board',
  'workspace',
  'agent',
  'session',
  'conversation',
  'process',
  'approval',
  'delivery',
  'export',
  'system',
  'settings',
  'device',
  'tunnel',
  'provider',
  'plugin',
  'mcp',
  'retention',
  'policy',
] as const

export type RemoteResourceType = typeof REMOTE_RESOURCE_TYPES[number]
export type RemoteDataClass =
  | 'public_bootstrap'
  | 'redacted_observe'
  | 'sensitive_content'
  | 'secret_or_withheld'

export type RemoteRateLimitFamily =
  | 'request'
  | 'command'
  | 'provider'
  | 'pairing'
  | 'auth-failure'
  | 'stream'
  | 'approval'
  | 'pty-write'
  | 'admin'

export interface RemoteResourceGrant {
  resourceType: RemoteResourceType
  resourceId: string
  permissions: readonly ('read' | 'mutate')[]
  dataClasses: readonly Exclude<RemoteDataClass, 'public_bootstrap' | 'secret_or_withheld'>[]
}

export interface RemoteDevicePrincipal {
  kind: 'device'
  deviceSessionId: string
  authenticatedUserId: string
  state: 'active' | 'revoked' | 'expired'
  scopes: readonly RemoteScope[]
  resourceGrants: readonly RemoteResourceGrant[]
  sessionExpiresAt: string
  credentialExpiresAt: string
  credentialVersion: number
  authenticatedAt: string
  tunnelOrigin: string
}

export interface LocalOperatorPrincipal {
  kind: 'local-operator'
  operatorId: string
  authenticated: true
  transport: 'loopback'
}

export type ServiceBoundaryPrincipal = RemoteDevicePrincipal | LocalOperatorPrincipal
export interface RemoteAnonymousPrincipal { kind: 'anonymous' }
export type RemoteAuthorizationPrincipal = ServiceBoundaryPrincipal | RemoteAnonymousPrincipal

/**
 * A caller may construct this only after resolving the object and its parentage inside the
 * focused service boundary. Knowing an object id is deliberately insufficient authorization.
 */
export interface VerifiedRemoteResource {
  resourceType: RemoteResourceType
  resourceId: string
  verifiedAtServiceBoundary: true
}

export interface RemoteStepUpGrant {
  id: string
  state: 'active' | 'revoked' | 'consumed'
  deviceSessionId: string
  authenticatedUserId: string
  credentialVersion: number
  action: string
  resourceType: RemoteResourceType
  resourceId: string
  requestDigest: string
  nonce: string
  issuedAt: string
  userVerifiedAt: string
  expiresAt: string
  singleUse: boolean
}

interface BaseRule {
  id: string
  operation: string
  localOperatorAllowed: boolean
  rateLimitFamily: RemoteRateLimitFamily
}

export interface RemoteReadPolicyRule extends BaseRule {
  kind: 'read'
  dataClass: RemoteDataClass
  requiredScope: 'observe' | null
  resourceType: RemoteResourceType | null
  allowedFields: readonly string[]
  cachePolicy: 'no-store' | 'device-private-short-lived'
  allowRemoteSensitive?: boolean
  purpose?: string
  maxAuthenticationAgeMs?: number
}

export interface RemoteMutationPolicyRule extends BaseRule {
  kind: 'mutation'
  requiredScope: RemoteScope
  resourceType: RemoteResourceType
  stepUp: 'none' | 'action-bound'
  destructive: boolean
  messageTarget?: 'no-tool' | 'tool-capable'
  audit: 'required'
}

export type RemotePolicyRule = RemoteReadPolicyRule | RemoteMutationPolicyRule

export type RemoteAuthorizationDenialCode =
  | 'unclassified_operation'
  | 'invalid_clock'
  | 'principal_invalid'
  | 'local_operator_not_allowed'
  | 'device_inactive'
  | 'device_expired'
  | 'credential_expired'
  | 'scope_missing'
  | 'resource_unverified'
  | 'resource_mismatch'
  | 'resource_grant_missing'
  | 'data_class_denied'
  | 'field_denied'
  | 'recent_authentication_required'
  | 'request_digest_required'
  | 'step_up_required'
  | 'step_up_inactive'
  | 'step_up_mismatch'
  | 'step_up_expired'
  | 'step_up_replayed'
  | 'step_up_claim_required'
  | 'rate_limit_exceeded'
  | 'invalid_request'

export interface RemoteAuthorizationRequest {
  operation: string
  principal: RemoteAuthorizationPrincipal
  resource?: VerifiedRemoteResource
  requestedFields?: readonly string[]
  stepUpGrant?: RemoteStepUpGrant
  requestDigest?: string
  nonce?: string
}

export interface RemoteAuthorizationAllowed {
  allowed: true
  operation: string
  ruleId: string
  kind: 'read' | 'mutation'
  principalKind: RemoteAuthorizationPrincipal['kind']
  attributedScope: RemoteScope | null
  resource: VerifiedRemoteResource | null
  allowedFields: readonly string[]
  cachePolicy: RemoteReadPolicyRule['cachePolicy'] | null
  stepUpGrantId: string | null
  authorizedRequestDigest: string | null
  requiresAudit: boolean
  rateLimitFamily: RemoteRateLimitFamily
  deviceAttribution: RemoteDeviceAttribution | null
}

export interface RemoteAuthorizationDenied {
  allowed: false
  operation: string
  code: RemoteAuthorizationDenialCode
  ruleId: string | null
  resource: VerifiedRemoteResource | null
  deviceAttribution: RemoteDeviceAttribution | null
}

export interface RemoteDeviceAttribution {
  deviceSessionId: string
  authenticatedUserId: string
  credentialVersion: number
  tunnelOrigin: string
}

export type RemoteAuthorizationDecision =
  | RemoteAuthorizationAllowed
  | RemoteAuthorizationDenied

const nonEmpty = (value: string): boolean => value.trim().length > 0
const REQUEST_DIGEST = /^sha256:[0-9a-f]{64}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const MAX_STEP_UP_GRANT_LIFETIME_MS = 5 * 60_000
const MAX_PENDING_VERIFICATION_MS = 5 * 60_000

const instant = (value: string): number => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

const expiredOrInvalid = (value: string, nowMs: number): boolean => {
  const parsed = instant(value)
  return !Number.isFinite(parsed) || parsed <= nowMs
}

const validTunnelOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname)
    return parsed.origin === value && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
  } catch {
    return false
  }
}

const attributionFor = (principal: RemoteAuthorizationPrincipal): RemoteDeviceAttribution | null => {
  if (principal.kind !== 'device' || !OPAQUE_ID.test(principal.deviceSessionId)
    || !OPAQUE_ID.test(principal.authenticatedUserId)
    || !Number.isSafeInteger(principal.credentialVersion) || principal.credentialVersion <= 0
    || !validTunnelOrigin(principal.tunnelOrigin)) return null
  return Object.freeze({
    deviceSessionId: principal.deviceSessionId,
    authenticatedUserId: principal.authenticatedUserId,
    credentialVersion: principal.credentialVersion,
    tunnelOrigin: principal.tunnelOrigin,
  })
}

const deny = (
  request: Pick<RemoteAuthorizationRequest, 'operation' | 'principal' | 'resource'>,
  code: RemoteAuthorizationDenialCode,
  ruleId: string | null,
): RemoteAuthorizationDenied => Object.freeze({
  allowed: false,
  operation: request.operation,
  code,
  ruleId,
  resource: request.resource ?? null,
  deviceAttribution: attributionFor(request.principal),
})

const sameResource = (
  resource: VerifiedRemoteResource | undefined,
  type: RemoteResourceType,
  id: string,
): boolean => resource?.resourceType === type && resource.resourceId === id

const validateRule = (rule: RemotePolicyRule): void => {
  if (!nonEmpty(rule.id) || !nonEmpty(rule.operation)) {
    throw new Error('remote policy rules require non-empty id and operation')
  }
  if (rule.kind === 'read') {
    if (!rule.allowedFields.length || rule.allowedFields.some((field) => !nonEmpty(field))) {
      throw new Error(`${rule.operation} must define a non-empty field allowlist`)
    }
    if (rule.dataClass === 'secret_or_withheld') {
      throw new Error(`${rule.operation} cannot expose secret_or_withheld data remotely`)
    }
    if (rule.dataClass === 'public_bootstrap') {
      if (rule.requiredScope !== null || rule.resourceType !== null) {
        throw new Error(`${rule.operation} public bootstrap must not expose a scoped resource`)
      }
    } else if (rule.requiredScope !== 'observe' || rule.resourceType === null) {
      throw new Error(`${rule.operation} device reads require observe and an exact resource type`)
    }
    if (rule.dataClass === 'sensitive_content') {
      if (!rule.allowRemoteSensitive || !rule.purpose?.trim() || rule.cachePolicy !== 'no-store') {
        throw new Error(`${rule.operation} sensitive content needs explicit purpose and no-store`)
      }
    }
    return
  }
  if (rule.audit !== 'required') throw new Error(`${rule.operation} mutations must require audit`)
  if ((rule.requiredScope === 'terminal-write' || rule.requiredScope === 'admin' || rule.destructive)
    && rule.stepUp !== 'action-bound') {
    throw new Error(`${rule.operation} must require action-bound step-up`)
  }
  if (rule.messageTarget === 'tool-capable'
    && (rule.requiredScope !== 'agent-control' || rule.stepUp !== 'action-bound')) {
    throw new Error(`${rule.operation} tool-capable messages require agent-control and step-up`)
  }
  if (rule.requiredScope === 'message' && rule.messageTarget !== 'no-tool') {
    throw new Error(`${rule.operation} message scope may target only no-tool Q&A`)
  }
}

const validateStepUp = (
  request: RemoteAuthorizationRequest,
  principal: RemoteDevicePrincipal,
  rule: RemoteMutationPolicyRule,
  nowMs: number,
): RemoteAuthorizationDenialCode | null => {
  if (rule.stepUp === 'none') return null
  const grant = request.stepUpGrant
  if (!grant) return 'step_up_required'
  if (grant.state === 'consumed') return 'step_up_replayed'
  if (grant.state !== 'active') return 'step_up_inactive'
  const issuedAt = instant(grant.issuedAt)
  const verifiedAt = instant(grant.userVerifiedAt)
  const expiresAt = instant(grant.expiresAt)
  if (!grant.singleUse || !nonEmpty(grant.id) || expiredOrInvalid(grant.expiresAt, nowMs)
    || !Number.isFinite(issuedAt) || issuedAt > nowMs
    || !Number.isFinite(verifiedAt) || verifiedAt > nowMs
    || verifiedAt < issuedAt || verifiedAt - issuedAt > MAX_PENDING_VERIFICATION_MS
    || expiresAt - issuedAt > MAX_STEP_UP_GRANT_LIFETIME_MS) {
    return 'step_up_expired'
  }
  if (!REQUEST_DIGEST.test(request.requestDigest ?? '') || !nonEmpty(request.nonce ?? '')) {
    return 'step_up_mismatch'
  }
  if (!sameResource(request.resource, grant.resourceType, grant.resourceId)
    || grant.deviceSessionId !== principal.deviceSessionId
    || grant.authenticatedUserId !== principal.authenticatedUserId
    || grant.credentialVersion !== principal.credentialVersion
    || grant.action !== request.operation
    || grant.requestDigest !== request.requestDigest
    || grant.nonce !== request.nonce
    || !Number.isFinite(instant(grant.userVerifiedAt))) {
    return 'step_up_mismatch'
  }
  return null
}

export interface RemoteStepUpClaim {
  grantId: string
  deviceSessionId: string
  authenticatedUserId: string
  credentialVersion: number
  operation: string
  resourceType: RemoteResourceType
  resourceId: string
  requestDigest: string
  nonce: string
  expectedState: 'active'
  expectedSessionState: 'active'
  expectedExpiresAt: string
  nowMs: number
}

export type RemoteStepUpClaimResult<T> =
  | { claimed: true; value: T }
  | { claimed: false }

/**
 * Implement with one durable transaction: conditional active->consumed claim, service mutation,
 * and commit. A false claim must not invoke the callback.
 */
export interface RemoteStepUpClaimTransaction {
  executeOnce<T>(claim: RemoteStepUpClaim, operation: () => T): RemoteStepUpClaimResult<T>
}

export class RemoteAuthorizationPolicy {
  readonly #rules: ReadonlyMap<string, RemotePolicyRule>
  readonly #clock: () => Date

  constructor(rules: readonly RemotePolicyRule[], clock: () => Date = () => new Date()) {
    const indexed = new Map<string, RemotePolicyRule>()
    for (const rule of rules) {
      validateRule(rule)
      if (indexed.has(rule.operation)) throw new Error(`duplicate remote operation ${rule.operation}`)
      const frozenRule = rule.kind === 'read'
        ? Object.freeze({ ...rule, allowedFields: Object.freeze([...rule.allowedFields]) })
        : Object.freeze({ ...rule })
      indexed.set(rule.operation, frozenRule)
    }
    this.#rules = indexed
    this.#clock = clock
  }

  rule(operation: string): RemotePolicyRule | undefined {
    return this.#rules.get(operation)
  }

  authorize(request: RemoteAuthorizationRequest): RemoteAuthorizationDecision {
    return this.#evaluate(request, false)
  }

  #evaluate(request: RemoteAuthorizationRequest, stepUpClaimed: boolean): RemoteAuthorizationDecision {
    const rule = this.#rules.get(request.operation)
    if (!rule) return deny(request, 'unclassified_operation', null)
    const nowMs = this.#clock().getTime()
    if (!Number.isFinite(nowMs)) return deny(request, 'invalid_clock', rule.id)

    if (request.principal.kind === 'anonymous') {
      if (rule.kind !== 'read' || rule.dataClass !== 'public_bootstrap') {
        return deny(request, 'scope_missing', rule.id)
      }
      const requestedFields = request.requestedFields ?? rule.allowedFields
      if (requestedFields.some((field) => !rule.allowedFields.includes(field))) {
        return deny(request, 'field_denied', rule.id)
      }
      return {
        allowed: true,
        operation: request.operation,
        ruleId: rule.id,
        kind: 'read',
        principalKind: 'anonymous',
        attributedScope: null,
        resource: null,
        allowedFields: rule.allowedFields,
        cachePolicy: rule.cachePolicy,
        stepUpGrantId: null,
        authorizedRequestDigest: null,
        requiresAudit: false,
        rateLimitFamily: rule.rateLimitFamily,
        deviceAttribution: null,
      }
    }

    if (request.principal.kind === 'local-operator') {
      if (!request.principal.authenticated || request.principal.transport !== 'loopback'
        || !rule.localOperatorAllowed) {
        return deny(request, 'local_operator_not_allowed', rule.id)
      }
      if (rule.resourceType !== null
        && (!request.resource?.verifiedAtServiceBoundary
          || request.resource.resourceType !== rule.resourceType)) {
        return deny(request, 'resource_unverified', rule.id)
      }
      return {
        allowed: true,
        operation: request.operation,
        ruleId: rule.id,
        kind: rule.kind,
        principalKind: 'local-operator',
        attributedScope: null,
        resource: request.resource ?? null,
        allowedFields: rule.kind === 'read' ? rule.allowedFields : [],
        cachePolicy: rule.kind === 'read' ? rule.cachePolicy : null,
        stepUpGrantId: null,
        authorizedRequestDigest: null,
        requiresAudit: rule.kind === 'mutation',
        rateLimitFamily: rule.rateLimitFamily,
        deviceAttribution: null,
      }
    }

    const principal = request.principal
    const deviceAttribution = attributionFor(principal)
    if (!deviceAttribution) return deny(request, 'principal_invalid', rule.id)
    if (principal.state !== 'active') return deny(request, 'device_inactive', rule.id)
    if (expiredOrInvalid(principal.sessionExpiresAt, nowMs)) {
      return deny(request, 'device_expired', rule.id)
    }
    if (expiredOrInvalid(principal.credentialExpiresAt, nowMs)) {
      return deny(request, 'credential_expired', rule.id)
    }
    if (rule.requiredScope && !principal.scopes.includes(rule.requiredScope)) {
      return deny(request, 'scope_missing', rule.id)
    }
    if (request.resource && !OPAQUE_ID.test(request.resource.resourceId)) {
      return deny(request, 'resource_unverified', rule.id)
    }

    if (rule.resourceType !== null) {
      if (!request.resource?.verifiedAtServiceBoundary) {
        return deny(request, 'resource_unverified', rule.id)
      }
      if (request.resource.resourceType !== rule.resourceType) {
        return deny(request, 'resource_mismatch', rule.id)
      }
      const permission = rule.kind === 'read' ? 'read' : 'mutate'
      const grant = principal.resourceGrants.find((candidate) => (
        candidate.resourceType === request.resource?.resourceType
        && candidate.resourceId === request.resource.resourceId
        && candidate.permissions.includes(permission)
      ))
      if (!grant) return deny(request, 'resource_grant_missing', rule.id)
      if (rule.kind === 'read' && !grant.dataClasses.includes(rule.dataClass as never)) {
        return deny(request, 'data_class_denied', rule.id)
      }
    }

    if (rule.kind === 'read') {
      const requestedFields = request.requestedFields ?? rule.allowedFields
      if (requestedFields.some((field) => !rule.allowedFields.includes(field))) {
        return deny(request, 'field_denied', rule.id)
      }
      if (rule.maxAuthenticationAgeMs !== undefined
        && (!Number.isFinite(instant(principal.authenticatedAt))
          || nowMs - instant(principal.authenticatedAt) > rule.maxAuthenticationAgeMs
          || instant(principal.authenticatedAt) > nowMs)) {
        return deny(request, 'recent_authentication_required', rule.id)
      }
      return {
        allowed: true,
        operation: request.operation,
        ruleId: rule.id,
        kind: 'read',
        principalKind: 'device',
        attributedScope: rule.requiredScope,
        resource: request.resource ?? null,
        allowedFields: rule.allowedFields,
        cachePolicy: rule.cachePolicy,
        stepUpGrantId: null,
        authorizedRequestDigest: null,
        requiresAudit: false,
        rateLimitFamily: rule.rateLimitFamily,
        deviceAttribution,
      }
    }

    if (!REQUEST_DIGEST.test(request.requestDigest ?? '')) {
      return deny(request, 'request_digest_required', rule.id)
    }
    const stepUpDenial = validateStepUp(request, principal, rule, nowMs)
    if (stepUpDenial) return deny(request, stepUpDenial, rule.id)
    if (rule.stepUp === 'action-bound' && !stepUpClaimed) {
      return deny(request, 'step_up_claim_required', rule.id)
    }
    return {
      allowed: true,
      operation: request.operation,
      ruleId: rule.id,
      kind: 'mutation',
      principalKind: 'device',
      attributedScope: rule.requiredScope,
      resource: request.resource ?? null,
      allowedFields: [],
      cachePolicy: null,
      stepUpGrantId: request.stepUpGrant?.id ?? null,
      authorizedRequestDigest: request.requestDigest ?? null,
      requiresAudit: true,
      rateLimitFamily: rule.rateLimitFamily,
      deviceAttribution,
    }
  }

  runAuthorizedServiceOperation<T>(
    request: ServiceBoundaryAuthorizationRequest,
    operation: (context: AuthorizedServiceBoundaryContext) => T,
    stepUpTransaction?: RemoteStepUpClaimTransaction,
  ): T {
    const decision = this.#evaluate(request, true)
    if (!decision.allowed) throw new RemoteAuthorizationError(decision)
    const context = { authorization: decision, principal: request.principal }
    if (!decision.stepUpGrantId) return operation(context)
    if (!stepUpTransaction || request.principal.kind !== 'device' || !request.stepUpGrant
      || !request.requestDigest || !request.nonce || !decision.resource || !decision.deviceAttribution) {
      throw new RemoteAuthorizationError(deny(request, 'step_up_claim_required', decision.ruleId))
    }
    const claimNowMs = this.#clock().getTime()
    if (!Number.isFinite(claimNowMs)) {
      throw new RemoteAuthorizationError(deny(request, 'invalid_clock', decision.ruleId))
    }
    if (expiredOrInvalid(request.stepUpGrant.expiresAt, claimNowMs)) {
      throw new RemoteAuthorizationError(deny(request, 'step_up_expired', decision.ruleId))
    }
    const claim: RemoteStepUpClaim = Object.freeze({
      grantId: decision.stepUpGrantId,
      deviceSessionId: decision.deviceAttribution.deviceSessionId,
      authenticatedUserId: decision.deviceAttribution.authenticatedUserId,
      credentialVersion: decision.deviceAttribution.credentialVersion,
      operation: decision.operation,
      resourceType: decision.resource.resourceType,
      resourceId: decision.resource.resourceId,
      requestDigest: request.requestDigest,
      nonce: request.nonce,
      expectedState: 'active',
      expectedSessionState: 'active',
      expectedExpiresAt: request.stepUpGrant.expiresAt,
      nowMs: claimNowMs,
    })
    const claimed = stepUpTransaction.executeOnce(claim, () => operation(context))
    if (!claimed.claimed) {
      throw new RemoteAuthorizationError(deny(request, 'step_up_replayed', decision.ruleId))
    }
    return claimed.value
  }
}

export class RemoteAuthorizationError extends Error {
  readonly decision: RemoteAuthorizationDenied

  constructor(decision: RemoteAuthorizationDenied) {
    super(`remote authorization denied: ${decision.code}`)
    this.name = 'RemoteAuthorizationError'
    this.decision = decision
  }
}

export interface AuthorizedServiceBoundaryContext {
  authorization: RemoteAuthorizationAllowed
  principal: ServiceBoundaryPrincipal
}

export type ServiceBoundaryAuthorizationRequest = Omit<RemoteAuthorizationRequest, 'principal'> & {
  principal: ServiceBoundaryPrincipal
}

/** Fastify-independent service-boundary guard. Unknown operations deny for every principal. */
export function authorizeServiceBoundary(
  policy: RemoteAuthorizationPolicy,
  request: ServiceBoundaryAuthorizationRequest,
): AuthorizedServiceBoundaryContext {
  const decision = policy.authorize(request)
  if (!decision.allowed) throw new RemoteAuthorizationError(decision)
  return { authorization: decision, principal: request.principal }
}

/** The service callback is never invoked when authorization is missing or incomplete. */
export function runAuthorizedServiceOperation<T>(
  policy: RemoteAuthorizationPolicy,
  request: ServiceBoundaryAuthorizationRequest,
  operation: (context: AuthorizedServiceBoundaryContext) => T,
  stepUpTransaction?: RemoteStepUpClaimTransaction,
): T {
  return policy.runAuthorizedServiceOperation(request, operation, stepUpTransaction)
}

export interface RemoteMutationAuditEnvelope {
  schema_version: 1
  occurred_at: string
  operation: string
  rule_id: string
  outcome: 'authorized' | 'succeeded' | 'failed'
  resource_type: RemoteResourceType
  resource_id: string
  device_session_id: string
  authenticated_user_id: string
  credential_version: number
  attributed_scope: Exclude<RemoteScope, 'observe'>
  step_up_grant_id: string | null
  request_id: string
  correlation_id: string
  request_digest: string
  tunnel_origin: string
  sensitive_values_retained: false
}

export interface RemoteMutationDenialAuditEnvelope {
  schema_version: 1
  occurred_at: string
  operation: string
  rule_id: string | null
  outcome: 'denied'
  denial_code: RemoteAuthorizationDenialCode
  resource_type: RemoteResourceType | null
  resource_id: string | null
  device_session_id: string
  authenticated_user_id: string
  credential_version: number
  request_id: string
  correlation_id: string
  request_digest: string | null
  tunnel_origin: string
  sensitive_values_retained: false
}

export interface RemoteMutationAuditInput {
  authorization: RemoteAuthorizationAllowed
  outcome: RemoteMutationAuditEnvelope['outcome']
  occurredAt: string
  requestId: string
  correlationId: string
  requestDigest: string
}

/**
 * Produces a closed audit shape: callers cannot append PTY input, approval parameters, credentials,
 * message bodies, secrets, or withheld reasoning.
 */
export function createRemoteMutationAuditEnvelope(
  input: RemoteMutationAuditInput,
): RemoteMutationAuditEnvelope {
  const { authorization } = input
  if (authorization.kind !== 'mutation' || authorization.principalKind !== 'device'
    || !authorization.requiresAudit || !authorization.resource || !authorization.attributedScope
    || authorization.attributedScope === 'observe' || !authorization.deviceAttribution) {
    throw new Error('a device-authorized mutation decision is required for remote audit')
  }
  if (authorization.authorizedRequestDigest !== input.requestDigest) {
    throw new Error('remote audit request digest must match the authorization decision')
  }
  for (const [label, value] of [['requestId', input.requestId], ['correlationId', input.correlationId]] as const) {
    if (!OPAQUE_ID.test(value)) throw new Error(`${label} must be a bounded opaque id`)
  }
  if (!REQUEST_DIGEST.test(input.requestDigest)) {
    throw new Error('requestDigest must be a sha256 digest')
  }
  if (new Date(input.occurredAt).toISOString() !== input.occurredAt) {
    throw new Error('occurredAt must be a canonical ISO timestamp')
  }
  const attribution = authorization.deviceAttribution
  return Object.freeze({
    schema_version: 1,
    occurred_at: input.occurredAt,
    operation: authorization.operation,
    rule_id: authorization.ruleId,
    outcome: input.outcome,
    resource_type: authorization.resource.resourceType,
    resource_id: authorization.resource.resourceId,
    device_session_id: attribution.deviceSessionId,
    authenticated_user_id: attribution.authenticatedUserId,
    credential_version: attribution.credentialVersion,
    attributed_scope: authorization.attributedScope as Exclude<RemoteScope, 'observe'>,
    step_up_grant_id: authorization.stepUpGrantId,
    request_id: input.requestId,
    correlation_id: input.correlationId,
    request_digest: input.requestDigest,
    tunnel_origin: attribution.tunnelOrigin,
    sensitive_values_retained: false,
  })
}

export interface RemoteMutationDenialAuditInput {
  denial: RemoteAuthorizationDenied
  occurredAt: string
  requestId: string
  correlationId: string
  requestDigest?: string
}

/** Records an authenticated denied mutation attempt without accepting arbitrary request values. */
export function createRemoteMutationDenialAuditEnvelope(
  input: RemoteMutationDenialAuditInput,
): RemoteMutationDenialAuditEnvelope {
  if (!input.denial.deviceAttribution) {
    throw new Error('an authenticated device-attributed denial is required')
  }
  if (!OPAQUE_ID.test(input.requestId) || !OPAQUE_ID.test(input.correlationId)) {
    throw new Error('requestId and correlationId must be bounded opaque ids')
  }
  if (input.requestDigest !== undefined && !REQUEST_DIGEST.test(input.requestDigest)) {
    throw new Error('requestDigest must be a sha256 digest')
  }
  if (new Date(input.occurredAt).toISOString() !== input.occurredAt) {
    throw new Error('occurredAt must be a canonical ISO timestamp')
  }
  const attribution = input.denial.deviceAttribution
  return Object.freeze({
    schema_version: 1,
    occurred_at: input.occurredAt,
    operation: input.denial.operation,
    rule_id: input.denial.ruleId,
    outcome: 'denied',
    denial_code: input.denial.code,
    resource_type: input.denial.resource?.resourceType ?? null,
    resource_id: input.denial.resource?.resourceId ?? null,
    device_session_id: attribution.deviceSessionId,
    authenticated_user_id: attribution.authenticatedUserId,
    credential_version: attribution.credentialVersion,
    request_id: input.requestId,
    correlation_id: input.correlationId,
    request_digest: input.requestDigest ?? null,
    tunnel_origin: attribution.tunnelOrigin,
    sensitive_values_retained: false,
  })
}

/** Digest canonical request bytes; never use URLs, logs, analytics, or push payloads as transport. */
export function digestRemoteMutation(canonicalRequest: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(canonicalRequest).digest('hex')}`
}

const readRule = (
  id: string,
  operation: string,
  resourceType: RemoteResourceType,
  allowedFields: readonly string[],
): RemoteReadPolicyRule => ({
  id,
  operation,
  kind: 'read',
  localOperatorAllowed: true,
  dataClass: 'redacted_observe',
  requiredScope: 'observe',
  resourceType,
  allowedFields,
  cachePolicy: 'no-store',
  rateLimitFamily: 'request',
})

const mutationRule = (
  id: string,
  operation: string,
  requiredScope: RemoteMutationPolicyRule['requiredScope'],
  resourceType: RemoteResourceType,
  options: Pick<RemoteMutationPolicyRule, 'stepUp' | 'destructive' | 'rateLimitFamily'>
    & Pick<RemoteMutationPolicyRule, 'messageTarget'>,
): RemoteMutationPolicyRule => ({
  id,
  operation,
  kind: 'mutation',
  localOperatorAllowed: true,
  requiredScope,
  resourceType,
  stepUp: options.stepUp,
  destructive: options.destructive,
  messageTarget: options.messageTarget,
  audit: 'required',
  rateLimitFamily: options.rateLimitFamily,
})

export const DEFAULT_REMOTE_POLICY_RULES: readonly RemotePolicyRule[] = Object.freeze([
  {
    id: 'public.health', operation: 'read.health', kind: 'read', localOperatorAllowed: true,
    dataClass: 'public_bootstrap', requiredScope: null, resourceType: null,
    allowedFields: ['status'], cachePolicy: 'no-store', rateLimitFamily: 'request',
  },
  {
    id: 'public.app-shell', operation: 'read.app-shell', kind: 'read', localOperatorAllowed: true,
    dataClass: 'public_bootstrap', requiredScope: null, resourceType: null,
    allowedFields: ['html'], cachePolicy: 'no-store', rateLimitFamily: 'request',
  },
  readRule('observe.board-summary', 'read.board-summary', 'board', ['id', 'name', 'status', 'attention_count']),
  readRule('observe.agent-status', 'read.agent-status', 'agent', ['id', 'name', 'status', 'provider', 'process_id']),
  readRule('observe.delivery-status', 'read.delivery-status', 'delivery', ['id', 'status', 'updated_at']),
  readRule('observe.conversation-redacted', 'read.conversation-redacted', 'conversation', ['id', 'summary', 'updated_at']),
  readRule('observe.process-status', 'read.process-status', 'process', ['id', 'status', 'working', 'updated_at']),
  {
    id: 'observe.terminal-view', operation: 'read.terminal-view', kind: 'read', localOperatorAllowed: true,
    dataClass: 'sensitive_content', requiredScope: 'observe', resourceType: 'process',
    allowedFields: ['process_id', 'redacted_output', 'cursor', 'updated_at'], cachePolicy: 'no-store',
    allowRemoteSensitive: true, purpose: 'explicit terminal monitoring', maxAuthenticationAgeMs: 15 * 60_000,
    rateLimitFamily: 'request',
  },
  mutationRule('message.no-tool', 'message.no-tool', 'message', 'conversation', {
    stepUp: 'none', destructive: false, messageTarget: 'no-tool', rateLimitFamily: 'command',
  }),
  mutationRule('message.promote-to-agent', 'message.promote-to-agent', 'agent-control', 'agent', {
    stepUp: 'action-bound', destructive: false, messageTarget: 'tool-capable', rateLimitFamily: 'command',
  }),
  mutationRule('approval.deny', 'approval.deny', 'approve', 'approval', {
    stepUp: 'none', destructive: false, rateLimitFamily: 'approval',
  }),
  mutationRule('approval.cancel', 'approval.cancel', 'approve', 'approval', {
    stepUp: 'none', destructive: false, rateLimitFamily: 'approval',
  }),
  mutationRule('approval.allow', 'approval.allow', 'approve', 'approval', {
    stepUp: 'action-bound', destructive: false, rateLimitFamily: 'approval',
  }),
  mutationRule('approval.allow-session', 'approval.allow-session', 'approve', 'approval', {
    stepUp: 'action-bound', destructive: false, rateLimitFamily: 'approval',
  }),
  mutationRule('agent.pause', 'agent.pause', 'agent-control', 'agent', {
    stepUp: 'none', destructive: false, rateLimitFamily: 'command',
  }),
  mutationRule('agent.stop', 'agent.stop', 'agent-control', 'agent', {
    stepUp: 'action-bound', destructive: true, rateLimitFamily: 'command',
  }),
  ...['start', 'resume', 'retry', 'access-change'].map((action): RemoteMutationPolicyRule => mutationRule(
    `agent.${action}`, `agent.${action}`, 'agent-control', 'agent', {
      stepUp: 'action-bound', destructive: false, rateLimitFamily: 'command',
    },
  )),
  ...['input', 'resize', 'spawn', 'restart', 'signal'].map((action): RemoteMutationPolicyRule => mutationRule(
    `terminal.${action}`, `terminal.${action}`, 'terminal-write', 'process', {
      stepUp: 'action-bound', destructive: action === 'restart' || action === 'signal',
      rateLimitFamily: 'pty-write',
    },
  )),
  mutationRule('admin.mutate', 'admin.mutate', 'admin', 'system', {
    stepUp: 'action-bound', destructive: false, rateLimitFamily: 'admin',
  }),
])

export function createDefaultRemoteAuthorizationPolicy(clock?: () => Date): RemoteAuthorizationPolicy {
  return new RemoteAuthorizationPolicy(DEFAULT_REMOTE_POLICY_RULES, clock)
}
