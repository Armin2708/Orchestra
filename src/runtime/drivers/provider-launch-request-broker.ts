import type {
  ProviderAuthorizedLaunchContextV1,
} from '../../provider-contract.js'
import type { DriverLaunchRequest } from '../types.js'

type PendingLaunchRequestV1 = {
  request: DriverLaunchRequest
  consumed: boolean
}

export type StagedProviderLaunchResultV1<T> = {
  value: T
  request_consumed: boolean
}

const snapshotRequest = (
  request: DriverLaunchRequest,
): DriverLaunchRequest => ({
  ...request,
  ...(request.args ? { args: [...request.args] } : {}),
  ...(request.env ? { env: { ...request.env } } : {}),
  ...(request.metadata ? { metadata: { ...request.metadata } } : {}),
})

/**
 * Carries trusted orchestration metadata to an AgentDriver-backed provider adapter
 * without adding private fields to the sealed TOOL-013 action contract.
 */
export class ProviderLaunchRequestBrokerV1 {
  readonly #pending = new Map<string, PendingLaunchRequestV1>()

  async stage<T>(
    actionId: string,
    requestInput: DriverLaunchRequest,
    execute: () => Promise<T>,
  ): Promise<StagedProviderLaunchResultV1<T>> {
    if (!actionId.trim() || this.#pending.has(actionId)) {
      throw new Error('provider launch request action is already staged')
    }
    const pending = {
      request: snapshotRequest(requestInput),
      consumed: false,
    }
    this.#pending.set(actionId, pending)
    try {
      const value = await execute()
      return {
        value,
        request_consumed: pending.consumed,
      }
    } finally {
      this.#pending.delete(actionId)
    }
  }

  readonly resolve = (
    context: ProviderAuthorizedLaunchContextV1,
  ): DriverLaunchRequest => {
    if (context.action.kind !== 'launch') {
      throw new Error('provider launch request broker requires a launch action')
    }
    const pending = this.#pending.get(context.action.action_id)
    if (!pending || pending.consumed) {
      throw new Error('provider launch request was not staged')
    }
    const requestedAccess = pending.request.accessProfile ?? 'workspace_write'
    if (pending.request.workspaceId !== context.action.scope_id
      || pending.request.cwd !== context.action.cwd
      || (pending.request.prompt ?? '') !== context.action.prompt
      || (pending.request.model ?? null) !== context.action.model
      || (pending.request.effort ?? null) !== context.action.effort
      || requestedAccess !== context.action.access_profile
      || pending.request.externalId !== undefined) {
      throw new Error('provider launch request does not match its authorized action')
    }
    pending.consumed = true
    return snapshotRequest(pending.request)
  }
}
