import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeAgentDriverAdapter,
  type ClaudeConductorPort,
  type ClaudeNativeSessionFork,
  type ClaudeSessionForkOptions,
} from '../src/runtime/index.js'

const sourceExternalId = randomUUID()
const sourceCwd = '/workspace/agentboard'
const workspaceId = 'workspace-claude-fork'

const conductor = (
  input: {
    cwd?: string
    externalId?: string | null
    live?: boolean
  } = {},
): ClaudeConductorPort => ({
  isHired: () => input.live ?? true,
  hire: () => ({
    id: 41,
    name: 'fork-source',
    sdk_session: input.externalId === undefined ? sourceExternalId : input.externalId,
  }),
  task: () => true,
  transcript: () => ({
    lines: [],
    working: null,
    ...(input.cwd === undefined ? {} : { info: { cwd: input.cwd } }),
  }),
  interruptAgent: async () => true,
  fire: async () => true,
})

const launch = async (
  forkSession: ClaudeNativeSessionFork,
  input: {
    cwd?: string
    externalId?: string | null
  } = {},
) => {
  const cwd = input.cwd ?? sourceCwd
  const driver = new ClaudeAgentDriverAdapter({
    conductor: conductor({ cwd, externalId: input.externalId }),
    forkSession,
  })
  const session = await driver.launch({
    workspaceId,
    boardId: 7,
    cwd,
  })
  return { driver, session, cwd }
}

const forkOptions = (
  overrides: Partial<ClaudeSessionForkOptions> = {},
): ClaudeSessionForkOptions => ({
  sourceExternalId,
  workspaceId,
  cwd: sourceCwd,
  ...overrides,
})

describe('ClaudeAgentDriverAdapter native session fork', () => {
  it('forks through the pinned SDK contract and returns explicit provider provenance', async () => {
    const childExternalId = randomUUID()
    const upToMessageId = randomUUID()
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: childExternalId }))
    const { driver, session } = await launch(nativeFork)

    const result = await driver.forkSession(session.id, forkOptions({
      cwd: `${sourceCwd}/.`,
      upToMessageId,
      title: '  Independent investigation  ',
    }))

    expect(nativeFork).toHaveBeenCalledOnce()
    expect(nativeFork).toHaveBeenCalledWith(sourceExternalId, {
      dir: sourceCwd,
      upToMessageId,
      title: 'Independent investigation',
    })
    expect(result).toEqual({
      sourceExternalId,
      externalId: childExternalId,
      providerThreadId: childExternalId,
      sourceProviderThreadId: sourceExternalId,
      metadata: {
        forkMethod: 'sdk.forkSession',
        workspaceId,
        cwd: sourceCwd,
        fileHistoryCopied: false,
        undoHistoryCopied: false,
        upToMessageId,
        title: 'Independent investigation',
      },
    })
  })

  it.each([
    ['external id', { sourceExternalId: randomUUID() }, /external provenance/],
    ['workspace', { workspaceId: 'workspace-other' }, /another workspace/],
    ['cwd', { cwd: '/workspace/other' }, /another cwd/],
  ])('rejects mismatched %s provenance before invoking the SDK', async (_label, override, message) => {
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: randomUUID() }))
    const { driver, session } = await launch(nativeFork)

    await expect(driver.forkSession(session.id, forkOptions(override))).rejects.toThrow(message)
    expect(nativeFork).not.toHaveBeenCalled()
  })

  it('refreshes a numeric launch fallback only from matching durable provider provenance', async () => {
    const childExternalId = randomUUID()
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: childExternalId }))
    const resolveAgent = vi.fn(() => ({
      id: 41,
      sdk_session: sourceExternalId,
    }))
    const workspaceForAgent = vi.fn(() => workspaceId)
    const driver = new ClaudeAgentDriverAdapter({
      conductor: conductor({ cwd: sourceCwd, externalId: null }),
      forkSession: nativeFork,
      resolveAgent,
      workspaceForAgent,
    })
    const session = await driver.launch({
      workspaceId,
      boardId: 7,
      cwd: sourceCwd,
    })
    expect(session.externalId).toBe('41')

    const result = await driver.forkSession(session.id, forkOptions())

    expect(resolveAgent).toHaveBeenCalledWith(sourceExternalId)
    expect(workspaceForAgent).toHaveBeenCalledWith(41)
    expect(session.externalId).toBe(sourceExternalId)
    expect(nativeFork).toHaveBeenCalledWith(sourceExternalId, { dir: sourceCwd })
    expect(result).toMatchObject({
      sourceExternalId,
      externalId: childExternalId,
      sourceProviderThreadId: sourceExternalId,
      providerThreadId: childExternalId,
    })
  })

  it('rejects a real provider UUID resolved to another agent before invoking the SDK', async () => {
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: randomUUID() }))
    const workspaceForAgent = vi.fn(() => workspaceId)
    const driver = new ClaudeAgentDriverAdapter({
      conductor: conductor({ cwd: sourceCwd, externalId: null }),
      forkSession: nativeFork,
      resolveAgent: () => ({ id: 42, sdk_session: sourceExternalId }),
      workspaceForAgent,
    })
    const session = await driver.launch({
      workspaceId,
      boardId: 7,
      cwd: sourceCwd,
    })

    await expect(driver.forkSession(session.id, forkOptions())).rejects.toThrow(
      'does not belong to agent 41',
    )
    expect(session.externalId).toBe('41')
    expect(workspaceForAgent).not.toHaveBeenCalled()
    expect(nativeFork).not.toHaveBeenCalled()
  })

  it('rejects a refreshed provider UUID when durable workspace provenance changed', async () => {
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: randomUUID() }))
    const driver = new ClaudeAgentDriverAdapter({
      conductor: conductor({ cwd: sourceCwd, externalId: null }),
      forkSession: nativeFork,
      resolveAgent: () => ({ id: 41, sdk_session: sourceExternalId }),
      workspaceForAgent: () => 'workspace-other',
    })
    const session = await driver.launch({
      workspaceId,
      boardId: 7,
      cwd: sourceCwd,
    })

    await expect(driver.forkSession(session.id, forkOptions())).rejects.toThrow(
      'belongs to another workspace',
    )
    expect(session.externalId).toBe('41')
    expect(nativeFork).not.toHaveBeenCalled()
  })

  it('rejects a numeric fallback until real provider provenance is initialized', async () => {
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: randomUUID() }))
    const driver = new ClaudeAgentDriverAdapter({
      conductor: conductor({ cwd: sourceCwd, externalId: null }),
      forkSession: nativeFork,
    })
    const session = await driver.launch({
      workspaceId,
      boardId: 7,
      cwd: sourceCwd,
    })

    await expect(driver.forkSession(session.id, forkOptions({
      sourceExternalId: '41',
    }))).rejects.toThrow('provider provenance is not initialized')
    expect(nativeFork).not.toHaveBeenCalled()
  })

  it('refuses an attached session when cwd provenance cannot be established', async () => {
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: randomUUID() }))
    const driver = new ClaudeAgentDriverAdapter({
      conductor: conductor(),
      forkSession: nativeFork,
      resolveAgent: () => ({ id: 41, sdk_session: sourceExternalId }),
      workspaceForAgent: () => workspaceId,
    })
    const session = await driver.attach(sourceExternalId)
    expect(session).not.toBeNull()

    await expect(driver.forkSession(session!.id, forkOptions())).rejects.toThrow(
      'cwd provenance is unavailable',
    )
    expect(nativeFork).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty child id', ''],
    ['the source id as the child', sourceExternalId],
  ])('rejects %s returned by the SDK', async (_label, childExternalId) => {
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: childExternalId }))
    const { driver, session } = await launch(nativeFork)

    await expect(driver.forkSession(session.id, forkOptions())).rejects.toThrow(
      childExternalId ? 'returned the source session id' : 'did not return a session id',
    )
  })

  it('rejects an explicit empty fork boundary before invoking the SDK', async () => {
    const nativeFork = vi.fn<ClaudeNativeSessionFork>(async () => ({ sessionId: randomUUID() }))
    const { driver, session } = await launch(nativeFork)

    await expect(driver.forkSession(session.id, forkOptions({
      upToMessageId: '  ',
    }))).rejects.toThrow('upToMessageId must not be empty')
    expect(nativeFork).not.toHaveBeenCalled()
  })
})
