import type {
  ProviderCapabilityId,
  ProviderExecutionModeV1,
  ProviderExecutionScope,
} from '../provider-contract.js'

export type ProviderRuntimeOperation = 'cancel' | 'retry' | 'timeout' | 'capacity'
export type ProviderRuntimeControlMethod = 'cancel' | 'stop'

export type ProviderRuntimePolicyDecision =
  | {
      state: 'allowed'
      operation: ProviderRuntimeOperation
      method: ProviderRuntimeControlMethod | 'launch' | 'resume' | 'reserve'
      reason_code: 'capability_supported'
    }
  | {
      state: 'no_action'
      operation: 'timeout'
      reason_code: 'deadline_not_reached'
    }
  | {
      state: 'exhausted'
      operation: 'retry'
      reason_code: 'retry_budget_exhausted'
    }
  | {
      state: 'at_capacity'
      operation: 'capacity'
      reason_code: 'provider_session_capacity_exceeded'
    }
  | {
      state: 'unsupported'
      operation: ProviderRuntimeOperation
      reason_code: string
      supported_alternative?: ProviderRuntimeControlMethod
    }
  | {
      state: 'policy_blocked'
      operation: ProviderRuntimeOperation
      reason_code: string
    }

export type ProviderRuntimePolicyRequest =
  | {
      operation: 'cancel'
      mode: ProviderExecutionModeV1
    }
  | {
      operation: 'retry'
      mode: ProviderExecutionModeV1
      executionScope: ProviderExecutionScope
      strategy: 'new_session' | 'resume_session'
      attempts: number
      maxAttempts: number
    }
  | {
      operation: 'timeout'
      mode: ProviderExecutionModeV1
      elapsedMs: number
      timeoutMs: number
      method: ProviderRuntimeControlMethod
    }
  | {
      operation: 'capacity'
      mode: ProviderExecutionModeV1
      activeSessions: number
      quarantinedSessions: number
      capacity: number
    }

/**
 * Evaluates canonical runtime operations against the selected provider mode.
 *
 * The caller must pass an explicit timeout control method. A provider's `stop`
 * capability is reported as an alternative to unsupported `cancel`, but is
 * never selected silently because stop and cancel have different native
 * semantics.
 */
export function evaluateProviderRuntimeOperation(
  request: ProviderRuntimePolicyRequest,
): ProviderRuntimePolicyDecision {
  const modeBlocked = modePolicyBlock(request.mode, request.operation)
  if (modeBlocked) return modeBlocked

  switch (request.operation) {
    case 'cancel':
      return capabilityDecision(request.mode, 'cancel', 'cancel', {
        alternative: capabilitySupported(request.mode, 'stop') ? 'stop' : undefined,
      })
    case 'retry': {
      assertCount(request.attempts, 'attempts')
      assertPositiveCount(request.maxAttempts, 'maxAttempts')
      if (request.attempts >= request.maxAttempts) {
        return {
          state: 'exhausted',
          operation: 'retry',
          reason_code: 'retry_budget_exhausted',
        }
      }
      if (!automationAllowed(request.mode, request.executionScope)) {
        return {
          state: 'policy_blocked',
          operation: 'retry',
          reason_code: `automation_${request.mode.automation_policy}`,
        }
      }
      const capability: ProviderCapabilityId = request.strategy === 'resume_session'
        ? 'resume'
        : 'launch'
      return capabilityDecision(
        request.mode,
        capability,
        request.strategy === 'resume_session' ? 'resume' : 'launch',
        { operation: 'retry' },
      )
    }
    case 'timeout': {
      assertDuration(request.elapsedMs, 'elapsedMs')
      assertDuration(request.timeoutMs, 'timeoutMs')
      if (request.elapsedMs < request.timeoutMs) {
        return {
          state: 'no_action',
          operation: 'timeout',
          reason_code: 'deadline_not_reached',
        }
      }
      return capabilityDecision(request.mode, request.method, request.method, {
        operation: 'timeout',
      })
    }
    case 'capacity': {
      assertCount(request.activeSessions, 'activeSessions')
      assertCount(request.quarantinedSessions, 'quarantinedSessions')
      assertPositiveCount(request.capacity, 'capacity')
      if (request.activeSessions + request.quarantinedSessions >= request.capacity) {
        return {
          state: 'at_capacity',
          operation: 'capacity',
          reason_code: 'provider_session_capacity_exceeded',
        }
      }
      return {
        state: 'allowed',
        operation: 'capacity',
        method: 'reserve',
        reason_code: 'capability_supported',
      }
    }
  }
}

export type BoundedProviderControlResult =
  | { state: 'confirmed'; capacityDisposition: 'release' }
  | {
      state: 'unconfirmed'
      reason_code: 'provider_control_timeout' | 'provider_control_failed'
      detail: string
      capacityDisposition: 'quarantine'
    }

/**
 * Bounds a provider control call without pretending a timed-out callback was
 * cancelled. Unconfirmed controls remain charged to session capacity until a
 * later native event or operator reconciliation proves cleanup.
 */
export async function executeBoundedProviderControl(
  control: () => Promise<void>,
  timeoutMs: number,
): Promise<BoundedProviderControlResult> {
  assertPositiveDuration(timeoutMs, 'timeoutMs')
  let timer: NodeJS.Timeout | undefined
  const settled = Promise.resolve()
    .then(control)
    .then(
      () => ({ state: 'confirmed', capacityDisposition: 'release' }) as const,
      (error) => ({
        state: 'unconfirmed',
        reason_code: 'provider_control_failed',
        detail: safeError(error),
        capacityDisposition: 'quarantine',
      }) as const,
    )
  const timeout = new Promise<BoundedProviderControlResult>((resolve) => {
    timer = setTimeout(() => resolve({
      state: 'unconfirmed',
      reason_code: 'provider_control_timeout',
      detail: `provider control was not confirmed within ${timeoutMs}ms`,
      capacityDisposition: 'quarantine',
    }), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([settled, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function modePolicyBlock(
  mode: ProviderExecutionModeV1,
  operation: ProviderRuntimeOperation,
): ProviderRuntimePolicyDecision | null {
  if (mode.support.state === 'supported') return null
  return {
    state: mode.support.state === 'policy_blocked' ? 'policy_blocked' : 'unsupported',
    operation,
    reason_code: mode.support.reason_code,
  }
}

function capabilityDecision(
  mode: ProviderExecutionModeV1,
  capability: ProviderCapabilityId,
  method: ProviderRuntimeControlMethod | 'launch' | 'resume' | 'reserve',
  options: {
    operation?: ProviderRuntimeOperation
    alternative?: ProviderRuntimeControlMethod
  } = {},
): ProviderRuntimePolicyDecision {
  const support = mode.capabilities[capability]
  const operation = options.operation ?? (capability === 'cancel' ? 'cancel' : capability as ProviderRuntimeOperation)
  if (support.state === 'supported') {
    return {
      state: 'allowed',
      operation,
      method,
      reason_code: 'capability_supported',
    }
  }
  return {
    state: support.state === 'policy_blocked' ? 'policy_blocked' : 'unsupported',
    operation,
    reason_code: support.reason_code,
    ...(options.alternative ? { supported_alternative: options.alternative } : {}),
  }
}

function capabilitySupported(mode: ProviderExecutionModeV1, capability: ProviderCapabilityId): boolean {
  return mode.capabilities[capability].state === 'supported'
}

function automationAllowed(mode: ProviderExecutionModeV1, scope: ProviderExecutionScope): boolean {
  if (scope === 'interactive') return mode.automation_policy !== 'blocked'
  return mode.automation_policy === 'allowed'
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

function assertPositiveCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function assertDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function safeError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return detail.slice(0, 500)
}
