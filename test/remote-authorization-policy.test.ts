import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PHONE_SCOPES,
  RemoteAuthorizationError,
  RemoteAuthorizationPolicy,
  authorizeServiceBoundary,
  createDefaultRemoteAuthorizationPolicy,
  createRemoteMutationAuditEnvelope,
  createRemoteMutationDenialAuditEnvelope,
  digestRemoteMutation,
  runAuthorizedServiceOperation,
  type RemoteAuthorizationAllowed,
  type RemoteDevicePrincipal,
  type RemotePolicyRule,
  type RemoteStepUpGrant,
  type RemoteStepUpClaimTransaction,
  type VerifiedRemoteResource,
} from '../src/remote-authorization-policy.js'

const NOW = new Date('2026-08-02T12:00:00.000Z')

const processResource = (id = 'process-1'): VerifiedRemoteResource => ({
  resourceType: 'process',
  resourceId: id,
  verifiedAtServiceBoundary: true,
})

const device = (overrides: Partial<RemoteDevicePrincipal> = {}): RemoteDevicePrincipal => ({
  kind: 'device',
  deviceSessionId: 'device-session-1',
  authenticatedUserId: 'user-1',
  state: 'active',
  scopes: [...DEFAULT_PHONE_SCOPES],
  resourceGrants: [
    {
      resourceType: 'board', resourceId: 'board-1', permissions: ['read'],
      dataClasses: ['redacted_observe'],
    },
    {
      resourceType: 'conversation', resourceId: 'conversation-1', permissions: ['read', 'mutate'],
      dataClasses: ['redacted_observe'],
    },
    {
      resourceType: 'approval', resourceId: 'approval-1', permissions: ['read', 'mutate'],
      dataClasses: ['redacted_observe'],
    },
    {
      resourceType: 'process', resourceId: 'process-1', permissions: ['read', 'mutate'],
      dataClasses: ['redacted_observe'],
    },
    {
      resourceType: 'agent', resourceId: 'agent-1', permissions: ['read', 'mutate'],
      dataClasses: ['redacted_observe'],
    },
    {
      resourceType: 'system', resourceId: 'system-1', permissions: ['mutate'],
      dataClasses: [],
    },
  ],
  sessionExpiresAt: '2026-08-03T12:00:00.000Z',
  credentialExpiresAt: '2026-08-02T13:00:00.000Z',
  credentialVersion: 7,
  authenticatedAt: '2026-08-02T11:55:00.000Z',
  tunnelOrigin: 'https://device.example.test',
  ...overrides,
})

const stepUp = (
  operation: string,
  resource: VerifiedRemoteResource,
  requestDigest = digestRemoteMutation('{"action":"test"}'),
  overrides: Partial<RemoteStepUpGrant> = {},
): RemoteStepUpGrant => ({
  id: 'step-up-1',
  state: 'active',
  deviceSessionId: 'device-session-1',
  authenticatedUserId: 'user-1',
  credentialVersion: 7,
  action: operation,
  resourceType: resource.resourceType,
  resourceId: resource.resourceId,
  requestDigest,
  nonce: 'nonce-1',
  issuedAt: '2026-08-02T11:59:00.000Z',
  userVerifiedAt: '2026-08-02T11:59:00.000Z',
  expiresAt: '2026-08-02T12:02:00.000Z',
  singleUse: true,
  ...overrides,
})

const claimTransaction = (): RemoteStepUpClaimTransaction => {
  const consumed = new Set<string>()
  return {
    executeOnce: (claim, operation) => {
      if (consumed.has(claim.grantId)) return { claimed: false }
      consumed.add(claim.grantId)
      return { claimed: true, value: operation() }
    },
  }
}

describe('remote authorization policy', () => {
  const policy = createDefaultRemoteAuthorizationPolicy(() => NOW)

  it('freezes the comprehensible phone default at observe, message, and approve only', () => {
    expect(DEFAULT_PHONE_SCOPES).toEqual(['observe', 'stream', 'message', 'approve'])
    expect(DEFAULT_PHONE_SCOPES).not.toContain('agent-control')
    expect(DEFAULT_PHONE_SCOPES).not.toContain('terminal-write')
    expect(DEFAULT_PHONE_SCOPES).not.toContain('admin')
    expect(Object.isFrozen(DEFAULT_PHONE_SCOPES)).toBe(true)
  })

  it('default-denies unknown operations for devices and the local operator', () => {
    expect(policy.authorize({ operation: 'new.route.without.policy', principal: device(), now: NOW }))
      .toMatchObject({ allowed: false, code: 'unclassified_operation' })
    expect(policy.authorize({
      operation: 'new.route.without.policy',
      principal: { kind: 'local-operator', operatorId: 'owner', authenticated: true, transport: 'loopback' },
      now: NOW,
    })).toMatchObject({ allowed: false, code: 'unclassified_operation' })
  })

  it('allows only explicitly minimal public bootstrap reads without a principal', () => {
    expect(policy.authorize({
      operation: 'read.health', principal: { kind: 'anonymous' }, requestedFields: ['status'], now: NOW,
    })).toMatchObject({ allowed: true, principalKind: 'anonymous', allowedFields: ['status'] })
    expect(policy.authorize({
      operation: 'read.board-summary', principal: { kind: 'anonymous' }, now: NOW,
    })).toMatchObject({ allowed: false, code: 'scope_missing' })
  })

  it('requires exact service-verified resources, data classes, and fields for reads', () => {
    const board = { resourceType: 'board', resourceId: 'board-1', verifiedAtServiceBoundary: true } as const
    expect(policy.authorize({
      operation: 'read.board-summary', principal: device(), resource: board,
      requestedFields: ['id', 'status'], now: NOW,
    })).toMatchObject({ allowed: true, allowedFields: ['id', 'name', 'status', 'attention_count'] })

    expect(policy.authorize({
      operation: 'read.board-summary', principal: device(),
      requestedFields: ['id'], now: NOW,
    })).toMatchObject({ allowed: false, code: 'resource_unverified' })
    expect(policy.authorize({
      operation: 'read.board-summary', principal: device(),
      resource: { ...board, resourceId: 'board-2' }, requestedFields: ['id'], now: NOW,
    })).toMatchObject({ allowed: false, code: 'resource_grant_missing' })
    expect(policy.authorize({
      operation: 'read.board-summary', principal: device(), resource: board,
      requestedFields: ['secret'], now: NOW,
    })).toMatchObject({ allowed: false, code: 'field_denied' })
  })

  it('keeps raw terminal output unavailable to the default observe grant', () => {
    expect(policy.authorize({
      operation: 'read.terminal-view', principal: device(), resource: processResource(), now: NOW,
    })).toMatchObject({ allowed: false, code: 'data_class_denied' })

    const explicitlyGranted = device({
      resourceGrants: [{
        resourceType: 'process', resourceId: 'process-1', permissions: ['read'],
        dataClasses: ['sensitive_content'],
      }],
    })
    expect(policy.authorize({
      operation: 'read.terminal-view', principal: explicitlyGranted,
      resource: processResource(), requestedFields: ['redacted_output'], now: NOW,
    })).toMatchObject({ allowed: true, cachePolicy: 'no-store', attributedScope: 'observe' })
    expect(policy.authorize({
      operation: 'read.terminal-view',
      principal: { ...explicitlyGranted, authenticatedAt: '2026-08-02T11:00:00.000Z' },
      resource: processResource(), now: NOW,
    })).toMatchObject({ allowed: false, code: 'recent_authentication_required' })
  })

  it('keeps terminal write denied until scope and exact step-up both exist', () => {
    const digest = digestRemoteMutation('{"bytes":4}')
    expect(policy.authorize({
      operation: 'terminal.input', principal: device(), resource: processResource(), now: NOW,
    })).toMatchObject({ allowed: false, code: 'scope_missing' })

    const writer = device({ scopes: [...DEFAULT_PHONE_SCOPES, 'terminal-write'] })
    expect(policy.authorize({
      operation: 'terminal.input', principal: writer, resource: processResource(),
      requestDigest: digest, now: NOW,
    })).toMatchObject({ allowed: false, code: 'step_up_required' })

    const grant = stepUp('terminal.input', processResource(), digest)
    expect(policy.authorize({
      operation: 'terminal.input', principal: writer, resource: processResource(),
      requestDigest: digest, nonce: 'nonce-1', stepUpGrant: grant, now: NOW,
    })).toMatchObject({ allowed: false, code: 'step_up_claim_required' })
    const transaction = claimTransaction()
    const request = {
      operation: 'terminal.input', principal: writer, resource: processResource(),
      requestDigest: digest, nonce: 'nonce-1', stepUpGrant: grant, now: NOW,
    } as const
    const mutation = vi.fn(({ authorization }) => authorization)
    expect(runAuthorizedServiceOperation(policy, request, mutation, transaction)).toMatchObject({
      allowed: true, attributedScope: 'terminal-write', stepUpGrantId: 'step-up-1', requiresAudit: true,
    })
    expect(() => runAuthorizedServiceOperation(policy, request, mutation, transaction))
      .toThrowError(expect.objectContaining({ decision: expect.objectContaining({ code: 'step_up_replayed' }) }))
    expect(mutation).toHaveBeenCalledTimes(1)

    for (const mismatchedGrant of [
      stepUp('terminal.input', processResource(), digest, { deviceSessionId: 'stolen-device' }),
      stepUp('terminal.signal', processResource(), digest),
      stepUp('terminal.input', processResource('process-2'), digest),
      stepUp('terminal.input', processResource(), digest, { requestDigest: digestRemoteMutation('altered') }),
      stepUp('terminal.input', processResource(), digest, { nonce: 'other-nonce' }),
      stepUp('terminal.input', processResource(), digest, { expiresAt: '2026-08-02T11:59:59.000Z' }),
      stepUp('terminal.input', processResource(), digest, { singleUse: false }),
      stepUp('terminal.input', processResource(), digest, { expiresAt: '2026-08-02T13:00:00.000Z' }),
    ]) {
      expect(policy.authorize({
        operation: 'terminal.input', principal: writer, resource: processResource(),
        requestDigest: digest, nonce: 'nonce-1', stepUpGrant: mismatchedGrant, now: NOW,
      }).allowed).toBe(false)
    }
    expect(policy.authorize({
      operation: 'terminal.input', principal: writer, resource: processResource(),
      requestDigest: digest, nonce: 'nonce-1',
      stepUpGrant: stepUp('terminal.input', processResource(), digest, { state: 'consumed' }), now: NOW,
    })).toMatchObject({ allowed: false, code: 'step_up_replayed' })
    expect(policy.authorize({
      ...request,
      stepUpGrant: stepUp('terminal.input', processResource(), digest, {
        issuedAt: '2026-08-02T11:59:00.000Z', userVerifiedAt: '1970-01-01T00:00:00.000Z',
      }),
    })).toMatchObject({ allowed: false, code: 'step_up_expired' })
    const invalidClockPolicy = createDefaultRemoteAuthorizationPolicy(() => new Date(Number.NaN))
    expect(invalidClockPolicy.authorize({
      ...request,
      principal: {
        ...writer,
        sessionExpiresAt: '2000-01-01T00:00:00.000Z',
        credentialExpiresAt: '2000-01-01T00:00:00.000Z',
      },
      stepUpGrant: stepUp('terminal.input', processResource(), digest, {
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    })).toMatchObject({ allowed: false, code: 'invalid_clock' })
  })

  it('allows deny/cancel with approve but requires digest-bound step-up for allow-session', () => {
    const approval = { resourceType: 'approval', resourceId: 'approval-1', verifiedAtServiceBoundary: true } as const
    expect(policy.authorize({ operation: 'approval.deny', principal: device(), resource: approval, now: NOW }))
      .toMatchObject({ allowed: false, code: 'request_digest_required' })
    const approvalDigest = digestRemoteMutation('{"approval_id":"approval-1"}')
    expect(policy.authorize({
      operation: 'approval.deny', principal: device(), resource: approval,
      requestDigest: approvalDigest, now: NOW,
    })).toMatchObject({ allowed: true, attributedScope: 'approve', stepUpGrantId: null })
    expect(policy.authorize({
      operation: 'approval.cancel', principal: device(), resource: approval,
      requestDigest: approvalDigest, now: NOW,
    }))
      .toMatchObject({ allowed: true })
    expect(policy.authorize({
      operation: 'approval.allow-session', principal: device(), resource: approval,
      requestDigest: approvalDigest, now: NOW,
    }))
      .toMatchObject({ allowed: false, code: 'step_up_required' })
  })

  it('prevents message scope from laundering instructions into tool-capable agents', () => {
    const conversation = {
      resourceType: 'conversation', resourceId: 'conversation-1', verifiedAtServiceBoundary: true,
    } as const
    expect(policy.authorize({
      operation: 'message.no-tool', principal: device(), resource: conversation,
      requestDigest: digestRemoteMutation('{"message":"bounded"}'), now: NOW,
    }))
      .toMatchObject({ allowed: true, attributedScope: 'message' })
    expect(policy.authorize({
      operation: 'message.promote-to-agent', principal: device(),
      resource: { resourceType: 'agent', resourceId: 'agent-1', verifiedAtServiceBoundary: true }, now: NOW,
    })).toMatchObject({ allowed: false, code: 'scope_missing' })
  })

  it('rejects revoked, expired, and stale-credential devices independently', () => {
    expect(policy.authorize({ operation: 'read.health', principal: device({ state: 'revoked' }), now: NOW }))
      .toMatchObject({ allowed: false, code: 'device_inactive' })
    expect(policy.authorize({
      operation: 'read.health', principal: device({ sessionExpiresAt: '2026-08-02T11:00:00.000Z' }), now: NOW,
    })).toMatchObject({ allowed: false, code: 'device_expired' })
    expect(policy.authorize({
      operation: 'read.health', principal: device({ credentialExpiresAt: '2026-08-02T11:00:00.000Z' }), now: NOW,
    })).toMatchObject({ allowed: false, code: 'credential_expired' })
  })

  it('rejects policy definitions that could bypass mandatory boundaries', () => {
    const invalidRules: RemotePolicyRule[] = [
      {
        id: 'bad.secret', operation: 'read.secret', kind: 'read', localOperatorAllowed: true,
        dataClass: 'secret_or_withheld', requiredScope: 'observe', resourceType: 'system',
        allowedFields: ['token'], cachePolicy: 'no-store', rateLimitFamily: 'request',
      },
    ]
    expect(() => new RemoteAuthorizationPolicy(invalidRules)).toThrow(/secret_or_withheld/)
    expect(() => new RemoteAuthorizationPolicy([{
      id: 'bad.terminal', operation: 'terminal.bad', kind: 'mutation', localOperatorAllowed: true,
      requiredScope: 'terminal-write', resourceType: 'process', stepUp: 'none', destructive: false,
      audit: 'required', rateLimitFamily: 'pty-write',
    }])).toThrow(/action-bound step-up/)
    expect(() => new RemoteAuthorizationPolicy([{
      id: 'bad.message', operation: 'message.bad', kind: 'mutation', localOperatorAllowed: true,
      requiredScope: 'message', resourceType: 'conversation', stepUp: 'none', destructive: false,
      messageTarget: 'tool-capable', audit: 'required', rateLimitFamily: 'command',
    }])).toThrow(/tool-capable messages require agent-control/)
  })
})

describe('service-boundary guard and mutation audit', () => {
  const policy = createDefaultRemoteAuthorizationPolicy(() => NOW)

  it('blocks a direct service callback when route middleware is bypassed', () => {
    const serviceMutation = vi.fn()
    expect(() => runAuthorizedServiceOperation(policy, {
      operation: 'terminal.input', principal: device(), resource: processResource(), now: NOW,
    }, serviceMutation)).toThrow(RemoteAuthorizationError)
    expect(serviceMutation).not.toHaveBeenCalled()
  })

  it('requires local operator operations to be explicit and loopback resource resolution to be verified', () => {
    const local = { kind: 'local-operator', operatorId: 'owner', authenticated: true, transport: 'loopback' } as const
    expect(() => authorizeServiceBoundary(policy, {
      operation: 'read.board-summary', principal: local, now: NOW,
    })).toThrowError(expect.objectContaining({
      decision: expect.objectContaining({ code: 'resource_unverified' }),
    }))
    expect(() => authorizeServiceBoundary(policy, {
      operation: 'unclassified.local.command', principal: local, now: NOW,
    })).toThrowError(expect.objectContaining({
      decision: expect.objectContaining({ code: 'unclassified_operation' }),
    }))
  })

  it('creates a closed, attributed audit envelope without raw terminal or approval values', () => {
    const writer = device({ scopes: [...DEFAULT_PHONE_SCOPES, 'terminal-write'] })
    const digest = digestRemoteMutation('{"input":"RAW_TERMINAL_SENTINEL"}')
    const request = {
      operation: 'terminal.input', principal: writer, resource: processResource(),
      requestDigest: digest, nonce: 'nonce-1',
      stepUpGrant: stepUp('terminal.input', processResource(), digest), now: NOW,
    } as const
    const decision = runAuthorizedServiceOperation(
      policy, request, ({ authorization }) => authorization, claimTransaction(),
    ) as RemoteAuthorizationAllowed
    const audit = createRemoteMutationAuditEnvelope({
      authorization: decision,
      outcome: 'succeeded',
      occurredAt: NOW.toISOString(),
      requestId: 'request-1',
      correlationId: 'correlation-1',
      requestDigest: digest,
    })

    expect(audit).toMatchObject({
      device_session_id: 'device-session-1',
      authenticated_user_id: 'user-1',
      attributed_scope: 'terminal-write',
      step_up_grant_id: 'step-up-1',
      sensitive_values_retained: false,
    })
    const attemptedAttributionOverride = createRemoteMutationAuditEnvelope({
      authorization: decision,
      principal: device({
        deviceSessionId: 'device-session-forged',
        authenticatedUserId: 'user-forged',
      }),
      outcome: 'succeeded',
      occurredAt: NOW.toISOString(),
      requestId: 'request-forge-attempt',
      correlationId: 'correlation-forge-attempt',
      requestDigest: digest,
    } as Parameters<typeof createRemoteMutationAuditEnvelope>[0])
    expect(attemptedAttributionOverride).toMatchObject({
      device_session_id: 'device-session-1', authenticated_user_id: 'user-1',
    })
    expect(JSON.stringify(audit)).not.toContain('RAW_TERMINAL_SENTINEL')
    expect(Object.keys(audit)).not.toContain('payload')
    expect(() => createRemoteMutationAuditEnvelope({
      authorization: decision,
      outcome: 'failed',
      occurredAt: NOW.toISOString(),
      requestId: 'request-2',
      correlationId: 'correlation-2',
      requestDigest: digestRemoteMutation('different-request'),
    })).toThrow(/match the authorization decision/)
    expect(() => createRemoteMutationAuditEnvelope({
      authorization: decision, outcome: 'failed', occurredAt: 'not-a-time',
      requestId: 'request-3', correlationId: 'correlation-3', requestDigest: digest,
    })).toThrow()
    expect(() => createRemoteMutationAuditEnvelope({
      authorization: decision, outcome: 'failed', occurredAt: NOW.toISOString(),
      requestId: 'RAW_SECRET\nheader', correlationId: 'correlation-3', requestDigest: digest,
    })).toThrow(/bounded opaque id/)
  })

  it('attributes denied remote mutations without accepting arbitrary sensitive metadata', () => {
    const principal = device({ scopes: [...DEFAULT_PHONE_SCOPES, 'terminal-write'] })
    const denial = policy.authorize({
      operation: 'terminal.input', principal, resource: processResource(),
      requestDigest: digestRemoteMutation('{"input":"DENIED_RAW_SENTINEL"}'), now: NOW,
    })
    expect(denial.allowed).toBe(false)
    if (denial.allowed) throw new Error('expected denial')
    const envelope = createRemoteMutationDenialAuditEnvelope({
      denial,
      resource: processResource('forged-resource'),
      occurredAt: NOW.toISOString(),
      requestId: 'request-denied',
      correlationId: 'correlation-denied',
      requestDigest: digestRemoteMutation('{"input":"DENIED_RAW_SENTINEL"}'),
    } as Parameters<typeof createRemoteMutationDenialAuditEnvelope>[0])
    expect(envelope).toMatchObject({
      outcome: 'denied', denial_code: 'step_up_required', device_session_id: 'device-session-1',
      sensitive_values_retained: false,
      resource_id: 'process-1',
    })
    expect(JSON.stringify(envelope)).not.toContain('DENIED_RAW_SENTINEL')
  })
})
