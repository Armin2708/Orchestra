import type {
  CodexAppServerPort,
  CodexRequestOptions,
  CodexServerRequestHandler,
} from './client.js'
import {
  codexTextInput,
  type CodexAccountResponse,
  type CodexAccountUsageResponse,
  type CodexModel,
  type CodexModelListResponse,
  type CodexRateLimitsResponse,
  type CodexServerNotification,
  type CodexThreadForkParams,
  type CodexThreadForkResponse,
  type CodexThreadReadResponse,
  type CodexThreadResumeParams,
  type CodexThreadResumeResponse,
  type CodexThreadStartParams,
  type CodexThreadStartResponse,
  type CodexThreadUnsubscribeResponse,
  type CodexTurnStartParams,
  type CodexTurnStartResponse,
  type CodexTurnSteerResponse,
  type CodexUserInput,
} from './protocol.js'
import type { CodexUnsubscribe } from './transport.js'
import type { CodexSupervisorLifecycleEvent } from './supervisor.js'

export type CodexModelCatalogOptions = {
  includeHidden?: boolean
  pageSize?: number
  maxPages?: number
}

export interface CodexRuntimeService {
  startThread(params: CodexThreadStartParams, options?: CodexRequestOptions): Promise<CodexThreadStartResponse>
  resumeThread(
    threadId: string,
    overrides?: Omit<CodexThreadResumeParams, 'threadId'>,
    options?: CodexRequestOptions,
  ): Promise<CodexThreadResumeResponse>
  forkThread(
    threadId: string,
    overrides?: Omit<CodexThreadForkParams, 'threadId'>,
    options?: CodexRequestOptions,
  ): Promise<CodexThreadForkResponse>
  readThread(threadId: string, includeTurns?: boolean, options?: CodexRequestOptions): Promise<CodexThreadReadResponse>
  unsubscribeThread(threadId: string, options?: CodexRequestOptions): Promise<CodexThreadUnsubscribeResponse>
  startTurn(
    threadId: string,
    input: string | CodexUserInput[],
    overrides?: Omit<CodexTurnStartParams, 'threadId' | 'input'>,
    options?: CodexRequestOptions,
  ): Promise<CodexTurnStartResponse>
  steerTurn(
    threadId: string,
    expectedTurnId: string,
    input: string | CodexUserInput[],
    options?: CodexRequestOptions,
  ): Promise<CodexTurnSteerResponse>
  interruptTurn(threadId: string, turnId: string, options?: CodexRequestOptions): Promise<void>
  listModelsPage(
    cursor?: string | null,
    options?: CodexModelCatalogOptions & CodexRequestOptions,
  ): Promise<CodexModelListResponse>
  listModels(options?: CodexModelCatalogOptions & CodexRequestOptions): Promise<CodexModel[]>
  readAccount(refreshToken?: boolean, options?: CodexRequestOptions): Promise<CodexAccountResponse>
  readRateLimits(options?: CodexRequestOptions): Promise<CodexRateLimitsResponse>
  readUsage(options?: CodexRequestOptions): Promise<CodexAccountUsageResponse>
  onNotification(listener: (notification: CodexServerNotification) => void): CodexUnsubscribe
  onServerRequest(handler: CodexServerRequestHandler): CodexUnsubscribe
  onLifecycle?(listener: (event: CodexSupervisorLifecycleEvent) => void): CodexUnsubscribe
}

export class CodexAppServerService implements CodexRuntimeService {
  constructor(readonly rpc: CodexAppServerPort) {}

  startThread(params: CodexThreadStartParams, options?: CodexRequestOptions): Promise<CodexThreadStartResponse> {
    return this.rpc.request('thread/start', params, options)
  }

  resumeThread(
    threadId: string,
    overrides: Omit<CodexThreadResumeParams, 'threadId'> = {},
    options?: CodexRequestOptions,
  ): Promise<CodexThreadResumeResponse> {
    return this.rpc.request('thread/resume', { ...overrides, threadId }, options)
  }

  forkThread(
    threadId: string,
    overrides: Omit<CodexThreadForkParams, 'threadId'> = {},
    options?: CodexRequestOptions,
  ): Promise<CodexThreadForkResponse> {
    return this.rpc.request('thread/fork', { ...overrides, threadId }, options)
  }

  readThread(
    threadId: string,
    includeTurns = true,
    options?: CodexRequestOptions,
  ): Promise<CodexThreadReadResponse> {
    return this.rpc.request('thread/read', { threadId, includeTurns }, options)
  }

  unsubscribeThread(threadId: string, options?: CodexRequestOptions): Promise<CodexThreadUnsubscribeResponse> {
    return this.rpc.request('thread/unsubscribe', { threadId }, options)
  }

  startTurn(
    threadId: string,
    input: string | CodexUserInput[],
    overrides: Omit<CodexTurnStartParams, 'threadId' | 'input'> = {},
    options?: CodexRequestOptions,
  ): Promise<CodexTurnStartResponse> {
    return this.rpc.request('turn/start', {
      ...overrides,
      threadId,
      input: this.input(input),
    }, options)
  }

  steerTurn(
    threadId: string,
    expectedTurnId: string,
    input: string | CodexUserInput[],
    options?: CodexRequestOptions,
  ): Promise<CodexTurnSteerResponse> {
    return this.rpc.request('turn/steer', {
      threadId,
      expectedTurnId,
      input: this.input(input),
    }, options)
  }

  async interruptTurn(threadId: string, turnId: string, options?: CodexRequestOptions): Promise<void> {
    await this.rpc.request('turn/interrupt', { threadId, turnId }, options)
  }

  listModelsPage(
    cursor: string | null = null,
    options: CodexModelCatalogOptions & CodexRequestOptions = {},
  ): Promise<CodexModelListResponse> {
    return this.rpc.request('model/list', {
      cursor,
      limit: options.pageSize ?? null,
      includeHidden: options.includeHidden ?? false,
    }, options)
  }

  async listModels(options: CodexModelCatalogOptions & CodexRequestOptions = {}): Promise<CodexModel[]> {
    const maxPages = Math.max(1, options.maxPages ?? 100)
    const models: CodexModel[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.listModelsPage(cursor, options)
      models.push(...response.data)
      if (response.nextCursor === null) return models
      if (seenCursors.has(response.nextCursor)) {
        throw new Error(`Codex model catalog returned a repeated cursor: ${response.nextCursor}`)
      }
      seenCursors.add(response.nextCursor)
      cursor = response.nextCursor
    }
    throw new Error(`Codex model catalog exceeded ${maxPages} pages`)
  }

  readAccount(refreshToken = false, options?: CodexRequestOptions): Promise<CodexAccountResponse> {
    return this.rpc.request('account/read', { refreshToken }, options)
  }

  readRateLimits(options?: CodexRequestOptions): Promise<CodexRateLimitsResponse> {
    return this.rpc.request('account/rateLimits/read', undefined, options)
  }

  readUsage(options?: CodexRequestOptions): Promise<CodexAccountUsageResponse> {
    return this.rpc.request('account/usage/read', undefined, options)
  }

  onNotification(listener: (notification: CodexServerNotification) => void): CodexUnsubscribe {
    return this.rpc.onNotification(listener)
  }

  onServerRequest(handler: CodexServerRequestHandler): CodexUnsubscribe {
    return this.rpc.onServerRequest(handler)
  }

  onLifecycle(listener: (event: CodexSupervisorLifecycleEvent) => void): CodexUnsubscribe {
    const rpc = this.rpc as CodexAppServerPort & {
      onLifecycle?: (callback: (event: CodexSupervisorLifecycleEvent) => void) => CodexUnsubscribe
    }
    return rpc.onLifecycle ? rpc.onLifecycle(listener) : () => {}
  }

  private input(input: string | CodexUserInput[]): CodexUserInput[] {
    return typeof input === 'string' ? [codexTextInput(input)] : input
  }
}
