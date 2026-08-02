import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

type Json = Record<string, any>

type DaemonHandle = {
  child: ChildProcess
  output: () => string
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const sourceCli = path.join(repoRoot, 'src', 'cli.ts')
const fakeCodexFixture = fileURLToPath(
  new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
)
const daemonNode = process.execPath
const daemonNodeDirectory = path.dirname(daemonNode)
const activeDaemons = new Set<DaemonHandle>()
const tempRoots = new Set<string>()

afterEach(async () => {
  await Promise.allSettled([...activeDaemons].map((daemon) => stopDaemon(daemon, true)))
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
  activeDaemons.clear()
  tempRoots.clear()
})

describe.sequential('Agent Home real-daemon restart acceptance', () => {
  it('recovers two active agents after SIGKILL without duplicate jobs, authority, or history', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-home-daemon-restart-'))
    tempRoots.add(root)
    const orchestraHome = path.join(root, 'orchestra-home')
    const isolatedUserHome = path.join(root, 'user-home')
    const project = path.join(root, 'project')
    const secondProject = path.join(root, 'project-second-worktree')
    const fakeCodex = path.join(root, 'fake-codex')
    const fakeCodexState = path.join(root, 'fake-codex-state.json')
    mkdirSync(orchestraHome, { recursive: true })
    mkdirSync(isolatedUserHome, { recursive: true })
    mkdirSync(project, { recursive: true })
    copyFileSync(fakeCodexFixture, fakeCodex)
    chmodSync(fakeCodex, 0o755)
    initializeRepository(project)
    initializeWorktree(project, secondProject)

    const port = await freePort()
    const environment = daemonEnvironment({
      orchestraHome,
      isolatedUserHome,
      port,
      fakeCodex,
      fakeCodexState,
    })

    let daemon = await startDaemon(port, environment)
    const tokenPath = path.join(orchestraHome, 'token')
    const token = await waitForValue('operator token', () => {
      try {
        return readFileSync(tokenPath, 'utf8').trim() || undefined
      } catch {
        return undefined
      }
    })

    const board = await api(port, token, 'POST', '/api/v1/boards/resolve', {
      project_path: project,
    })
    const card = (await api(port, token, 'POST', '/api/v1/cards', {
      board_id: board.id,
      title: 'Prove durable Agent Home restart',
      description: 'Persist identity and transcript, restart, then continue.',
      paths: [],
    })).card
    const workspace = (await api(
      port,
      token,
      'POST',
      `/api/v1/os/boards/${board.id}/workspaces`,
      {
        name: 'Restart acceptance workspace',
        kind: 'shared',
        root_path: secondProject,
        idempotency_key: 'restart-acceptance:workspace',
      },
    )).workspace

    const launch = await api(
      port,
      token,
      'POST',
      `/api/v1/os/boards/${board.id}/jobs`,
      {
        card_id: card.id,
        workspace_id: workspace.id,
        provider: 'codex',
        model: 'gpt-restart-fake',
        idempotency_key: 'restart-acceptance:launch',
      },
      { 'idempotency-key': 'restart-acceptance:launch' },
    )

    expect(launch).toMatchObject({
      mode: 'canonical',
      job: { status: 'running', provider: 'codex' },
      workspace: { id: workspace.id },
      session: { status: 'running' },
      dispatch: { started: [launch.job.id] },
    })

    const ids = {
      job: launch.job.id as string,
      workspace: launch.workspace.id as string,
      session: launch.session.id as string,
      profile: '',
      conversation: '',
      agent: 0,
    }
    const sessionBefore = (await api(
      port,
      token,
      'GET',
      `/api/v1/os/sessions/${encodeURIComponent(ids.session)}`,
    )).session
    ids.profile = sessionBefore.profile_id
    ids.conversation = sessionBefore.conversation_id
    ids.agent = sessionBefore.agent_id
    expect(ids).toMatchObject({
      job: expect.any(String),
      workspace: expect.any(String),
      session: expect.any(String),
      profile: expect.any(String),
      conversation: expect.any(String),
      agent: expect.any(Number),
    })

    const secondCard = (await api(port, token, 'POST', '/api/v1/cards', {
      board_id: board.id,
      title: 'Prove second active Agent Home recovery',
      description: 'Keep a second authority and transcript isolated across SIGKILL.',
      paths: [],
    })).card
    const secondWorkspace = (await api(
      port,
      token,
      'POST',
      `/api/v1/os/boards/${board.id}/workspaces`,
      {
        name: 'Second restart acceptance workspace',
        kind: 'shared',
        root_path: project,
        idempotency_key: 'restart-acceptance:workspace:second',
      },
    )).workspace
    const secondLaunch = await api(
      port,
      token,
      'POST',
      `/api/v1/os/boards/${board.id}/jobs`,
      {
        card_id: secondCard.id,
        workspace_id: secondWorkspace.id,
        provider: 'codex',
        model: 'gpt-restart-fake',
        idempotency_key: 'restart-acceptance:launch:second',
      },
      { 'idempotency-key': 'restart-acceptance:launch:second' },
    )
    expect(secondLaunch).toMatchObject({
      mode: 'canonical',
      job: { provider: 'codex' },
    })
    expect(['queued', 'running']).toContain(secondLaunch.job.status)
    await waitFor('second job and session activation', async () => {
      const job = await boardJob(port, token, board.id, secondLaunch.job.id)
      const session = (await api(
        port,
        token,
        'GET',
        `/api/v1/os/sessions/${encodeURIComponent(secondLaunch.session.id)}`,
      )).session
      const active = job.status === 'running' && session.status === 'running'
        && typeof session.agent_id === 'number'
        && typeof session.profile_id === 'string'
        && typeof session.conversation_id === 'string'
      if (!active) throw new Error(JSON.stringify({ job, session }))
      return true
    }, 15_000)
    const secondSessionBefore = (await api(
      port,
      token,
      'GET',
      `/api/v1/os/sessions/${encodeURIComponent(secondLaunch.session.id)}`,
    )).session
    const secondIds = {
      job: secondLaunch.job.id as string,
      workspace: secondLaunch.workspace.id as string,
      session: secondLaunch.session.id as string,
      profile: secondSessionBefore.profile_id as string,
      conversation: secondSessionBefore.conversation_id as string,
      agent: secondSessionBefore.agent_id as number,
    }
    expect(secondIds.agent).not.toBe(ids.agent)
    expect(secondIds.session).not.toBe(ids.session)
    expect(secondIds.workspace).not.toBe(ids.workspace)

    await waitFor('pre-restart transcript event', async () => {
      const events = await conversationEvents(port, token, ids.conversation)
      return events.some((event) => event.projected_text === 'persisted before daemon restart')
    })
    await waitFor('second pre-restart transcript event', async () => {
      const events = await conversationEvents(port, token, secondIds.conversation)
      return events.some((event) => event.projected_text === 'persisted before daemon restart')
    })
    const beforeRestart = await conversationEvents(port, token, ids.conversation)
    assertExactlyOnceOrdering(beforeRestart)
    expect(nativeMethodCount(beforeRestart, 'item/agentMessage/delta')).toBe(1)
    expect(beforeRestart.filter(
      (event) => event.projected_text === 'persisted before daemon restart',
    )).toHaveLength(1)
    const secondBeforeRestart = await conversationEvents(port, token, secondIds.conversation)
    assertExactlyOnceOrdering(secondBeforeRestart)
    expect(secondBeforeRestart.filter(
      (event) => event.projected_text === 'persisted before daemon restart',
    )).toHaveLength(1)

    const scopedSnapshot = await rawApi(
      port,
      token,
      'GET',
      `/api/v1/os/jobs/${encodeURIComponent(ids.job)}`,
    )
    expect(scopedSnapshot).toMatchObject({
      status: 200,
      body: {
        mode: 'canonical',
        job: { id: ids.job },
        workspace: { id: ids.workspace },
        session: { id: ids.session },
        orchestration: {
          job_id: ids.job,
          workspace_id: ids.workspace,
          session_id: ids.session,
        },
      },
    })
    expect(scopedSnapshot.body.events).not.toHaveLength(0)
    expect(scopedSnapshot.body.events.every(
      (event: Json) => event.job_id === ids.job,
    )).toBe(true)

    await stopDaemon(daemon, true)
    activeDaemons.delete(daemon)
    await waitFor('daemon port release', () => portAvailable(port))

    daemon = await startDaemon(port, environment)
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token)
    await waitFor('provider thread resume', () => {
      const fakeState = readFakeCodexState(fakeCodexState)
      return fakeState.calls.filter((call: Json) => call.method === 'thread/resume').length === 2
        && fakeState.calls.filter((call: Json) => call.method === 'thread/read').length === 2
    })

    const jobAfterRestart = await boardJob(port, token, board.id, ids.job)
    const workspaceAfterRestart = (await api(
      port,
      token,
      'GET',
      `/api/v1/os/workspaces/${encodeURIComponent(ids.workspace)}`,
    )).workspace
    const sessionAfterRestart = (await api(
      port,
      token,
      'GET',
      `/api/v1/os/sessions/${encodeURIComponent(ids.session)}`,
    )).session
    const homeAfterRestart = (await api(
      port,
      token,
      'GET',
      `/api/v1/os/agent-profiles/${encodeURIComponent(ids.profile)}/home`,
    )).home

    expect(jobAfterRestart).toMatchObject({
      id: ids.job,
      workspace_id: ids.workspace,
      status: 'running',
    })
    expect(workspaceAfterRestart).toMatchObject({ id: ids.workspace })
    expect(sessionAfterRestart).toMatchObject({
      id: ids.session,
      workspace_id: ids.workspace,
      profile_id: ids.profile,
      conversation_id: ids.conversation,
      job_id: ids.job,
      agent_id: ids.agent,
      provider_thread_id: 'restart-thread-1',
      status: 'running',
    })
    expect(homeAfterRestart).toMatchObject({
      profile: { id: ids.profile },
      conversations: [
        expect.objectContaining({ id: ids.conversation }),
      ],
      active_session: {
        id: ids.session,
        workspace_id: ids.workspace,
        job_id: ids.job,
      },
      active_scope: {
        workspace: { id: ids.workspace },
        job: { id: ids.job },
      },
    })
    expect(await boardJob(port, token, board.id, secondIds.job)).toMatchObject({
      id: secondIds.job,
      workspace_id: secondIds.workspace,
      status: 'running',
    })
    expect((await api(
      port,
      token,
      'GET',
      `/api/v1/os/sessions/${encodeURIComponent(secondIds.session)}`,
    )).session).toMatchObject({
      id: secondIds.session,
      workspace_id: secondIds.workspace,
      profile_id: secondIds.profile,
      conversation_id: secondIds.conversation,
      job_id: secondIds.job,
      agent_id: secondIds.agent,
      provider_thread_id: 'restart-thread-2',
      status: 'running',
    })
    const recoveredDb = new Database(path.join(orchestraHome, 'orchestra.db'), { readonly: true })
    try {
      expect(recoveredDb.prepare('SELECT count(*) AS count FROM jobs WHERE board_id=?').get(board.id))
        .toEqual({ count: 2 })
      expect(recoveredDb.prepare(`SELECT count(*) AS count FROM agent_sessions
        WHERE status IN ('starting','running','idle')`).get()).toEqual({ count: 2 })
      expect(recoveredDb.prepare(`SELECT count(DISTINCT agent_id) AS count FROM agent_sessions
        WHERE status IN ('starting','running','idle')`).get()).toEqual({ count: 2 })
      expect(recoveredDb.prepare(`SELECT count(*) AS count FROM agent_sessions session
        LEFT JOIN jobs job ON job.id=session.job_id
        WHERE session.status IN ('starting','running','idle')
          AND (job.id IS NULL OR job.status NOT IN ('running','cancelling'))`).get())
        .toEqual({ count: 0 })
      expect(recoveredDb.prepare(`SELECT count(*) AS count FROM daemon_leases
        WHERE name='orchestra-daemon'`).get()).toEqual({ count: 1 })
    } finally {
      recoveredDb.close()
    }

    await waitForBrowserAcceptance({
      port,
      tokenPath,
      boardId: board.id,
      profileId: ids.profile,
      conversationId: ids.conversation,
      sessionId: ids.session,
      jobId: ids.job,
      workspaceId: ids.workspace,
    })

    const continuation = await api(
      port,
      token,
      'POST',
      `/api/v1/agents/${ids.agent}/task`,
      { text: 'Continue after the tested daemon restart.' },
    )
    expect(continuation).toMatchObject({
      ok: true,
      mode: 'canonical',
      orchestration: {
        job_id: ids.job,
        workspace_id: ids.workspace,
        session_id: ids.session,
      },
    })
    const secondContinuation = await api(
      port,
      token,
      'POST',
      `/api/v1/agents/${secondIds.agent}/task`,
      { text: 'Continue the second agent after the tested daemon SIGKILL.' },
    )
    expect(secondContinuation).toMatchObject({
      ok: true,
      mode: 'canonical',
      orchestration: {
        job_id: secondIds.job,
        workspace_id: secondIds.workspace,
        session_id: secondIds.session,
      },
    })

    await waitFor('post-restart continuation', async () => {
      const events = await conversationEvents(port, token, ids.conversation)
      return events.some((event) => event.projected_text === 'continued after daemon restart')
        && nativeMethodCount(events, 'turn/completed') === 1
    })
    await waitFor('canonical job completion', async () => {
      return (await boardJob(port, token, board.id, ids.job)).status === 'succeeded'
    })
    await waitFor('second post-restart continuation', async () => {
      const events = await conversationEvents(port, token, secondIds.conversation)
      return events.some((event) => event.projected_text === 'continued after daemon restart')
        && nativeMethodCount(events, 'turn/completed') === 1
    })
    await waitFor('second canonical job completion', async () => {
      return (await boardJob(port, token, board.id, secondIds.job)).status === 'succeeded'
    })

    const finalEvents = await conversationEvents(port, token, ids.conversation)
    assertExactlyOnceOrdering(finalEvents)
    expect(finalEvents.filter(
      (event) => event.projected_text === 'persisted before daemon restart',
    )).toHaveLength(1)
    expect(finalEvents.filter(
      (event) => event.projected_text === 'continued after daemon restart',
    )).toHaveLength(1)
    expect(nativeMethodCount(finalEvents, 'item/agentMessage/delta')).toBe(2)
    expect(nativeMethodCount(finalEvents, 'orchestra/captureGap')).toBe(1)
    expect(nativeMethodCount(finalEvents, 'turn/started')).toBe(1)
    expect(nativeMethodCount(finalEvents, 'turn/completed')).toBe(1)
    expect(finalEvents.every(
      (event) => event.provider_thread_id === 'restart-thread-1',
    )).toBe(true)
    const secondFinalEvents = await conversationEvents(port, token, secondIds.conversation)
    assertExactlyOnceOrdering(secondFinalEvents)
    expect(secondFinalEvents.filter(
      (event) => event.projected_text === 'persisted before daemon restart',
    )).toHaveLength(1)
    expect(secondFinalEvents.filter(
      (event) => event.projected_text === 'continued after daemon restart',
    )).toHaveLength(1)
    expect(nativeMethodCount(secondFinalEvents, 'item/agentMessage/delta')).toBe(2)
    expect(nativeMethodCount(secondFinalEvents, 'turn/completed')).toBe(1)
    expect(secondFinalEvents.every(
      (event) => event.provider_thread_id === 'restart-thread-2',
    )).toBe(true)

    const finalSession = (await api(
      port,
      token,
      'GET',
      `/api/v1/os/sessions/${encodeURIComponent(ids.session)}`,
    )).session
    expect(finalSession).toMatchObject({
      id: ids.session,
      workspace_id: ids.workspace,
      profile_id: ids.profile,
      conversation_id: ids.conversation,
      job_id: ids.job,
      agent_id: ids.agent,
      status: 'stopped',
    })
    expect((await api(
      port,
      token,
      'GET',
      `/api/v1/os/sessions/${encodeURIComponent(secondIds.session)}`,
    )).session).toMatchObject({
      id: secondIds.session,
      job_id: secondIds.job,
      agent_id: secondIds.agent,
      status: 'stopped',
    })

    const fakeState = readFakeCodexState(fakeCodexState)
    expect(fakeState.boots).toBe(2)
    expect(fakeState.calls.filter((call: Json) => call.method === 'thread/start')).toHaveLength(2)
    expect(fakeState.calls.filter((call: Json) => call.method === 'turn/start')).toHaveLength(2)
    expect(fakeState.calls.filter((call: Json) => call.method === 'thread/resume')).toHaveLength(2)
    expect(fakeState.calls.filter((call: Json) => call.method === 'thread/read')).toHaveLength(2)
    expect(fakeState.calls.filter((call: Json) => call.method === 'turn/steer')).toHaveLength(2)

    const completedDb = new Database(path.join(orchestraHome, 'orchestra.db'), { readonly: true })
    try {
      expect(completedDb.prepare('SELECT count(*) AS count FROM jobs WHERE board_id=?').get(board.id))
        .toEqual({ count: 2 })
      expect(completedDb.prepare('SELECT count(*) AS count FROM agent_sessions').get())
        .toEqual({ count: 2 })
      expect(completedDb.prepare(`SELECT count(*) AS count FROM agent_sessions
        WHERE status IN ('starting','running','idle','reserved')`).get()).toEqual({ count: 0 })
      expect(completedDb.prepare("SELECT count(*) AS count FROM processes WHERE status='lost'").get())
        .toEqual({ count: 0 })
      expect(completedDb.prepare(`SELECT count(*) AS count FROM workspace_assignments
        WHERE status IN ('active','reserved')`).get()).toEqual({ count: 0 })
      expect(completedDb.prepare(`SELECT count(*) AS count FROM daemon_leases
        WHERE name='orchestra-daemon'`).get()).toEqual({ count: 1 })
    } finally {
      completedDb.close()
    }

    await stopDaemon(daemon)
    activeDaemons.delete(daemon)
    expect(await portAvailable(port)).toBe(true)
  }, process.env.AGENT_HOME_BROWSER_ACCEPTANCE_MANIFEST ? 180_000 : 60_000)
})

function daemonEnvironment(input: {
  orchestraHome: string
  isolatedUserHome: string
  port: number
  fakeCodex: string
  fakeCodexState: string
}): NodeJS.ProcessEnv {
  return {
    PATH: `${daemonNodeDirectory}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: input.isolatedUserHome,
    USER: process.env.USER ?? 'agentboard-test',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'agentboard-test',
    SHELL: process.env.SHELL ?? '/bin/sh',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    NODE_ENV: 'test',
    ORCHESTRA_HOME: input.orchestraHome,
    ORCHESTRA_PORT: String(input.port),
    ORCHESTRA_MAX_LAUNCHED: '2',
    ORCHESTRA_MAX_PER_PROFILE: '2',
    ORCHESTRA_CANONICAL_LAUNCH: '1',
    ORCHESTRA_CODEX_COMMAND: input.fakeCodex,
    ORCHESTRA_CODEX_FORWARD_ENV: 'FAKE_CODEX_STATE',
    FAKE_CODEX_STATE: input.fakeCodexState,
  }
}

async function startDaemon(
  port: number,
  environment: NodeJS.ProcessEnv,
): Promise<DaemonHandle> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await startDaemonAttempt(port, environment)
    } catch (error) {
      lastError = error
      const detail = error instanceof Error ? error.message : String(error)
      // The complete parallel suite can delay the exact SDK-bundled binary's
      // --version subprocess beyond the daemon's fixed three-second probe.
      // Retry only that transient result. Every attempt still executes the
      // real package binary; a genuinely absent install fails after 3 tries.
      if (!detail.includes('SDK-bundled Claude CLI: unsupported (not found)') || attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 100))
    }
  }
  throw lastError
}

async function startDaemonAttempt(
  port: number,
  environment: NodeJS.ProcessEnv,
): Promise<DaemonHandle> {
  const child = spawn(daemonNode, [tsxCli, sourceCli, 'serve'], {
    cwd: repoRoot,
    env: environment,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const handle: DaemonHandle = {
    child,
    output: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  }
  activeDaemons.add(handle)

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      activeDaemons.delete(handle)
      throw new Error(`daemon exited before health check\n${handle.output()}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(250),
      })
      if (response.ok && (await response.json()).ok === true) return handle
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await stopDaemon(handle, true)
  throw new Error(`timed out waiting for daemon health\n${handle.output()}`)
}

async function stopDaemon(handle: DaemonHandle, force = false): Promise<void> {
  const pid = handle.child.pid
  if (!pid) {
    activeDaemons.delete(handle)
    return
  }
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {}
    const exited = await waitForExit(handle.child, force ? 1_000 : 5_000)
    if (!exited) {
      killProcessGroup(pid, 'SIGTERM')
      if (!(await waitForExit(handle.child, 1_000))) {
        killProcessGroup(pid, 'SIGKILL')
        await waitForExit(handle.child, 1_000)
      }
    }
  }
  if (processGroupExists(pid)) {
    killProcessGroup(pid, 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (processGroupExists(pid)) killProcessGroup(pid, 'SIGKILL')
  }
  activeDaemons.delete(handle)
}

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

function processGroupExists(pid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {}
}

async function api(
  port: number,
  token: string,
  method: string,
  endpoint: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Json> {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} returned ${response.status}: ${text}`)
  }
  return text ? JSON.parse(text) as Json : {}
}

async function rawApi(
  port: number,
  token: string,
  method: string,
  endpoint: string,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) as Json : {},
  }
}

async function conversationEvents(
  port: number,
  token: string,
  conversationId: string,
): Promise<Json[]> {
  const result = await api(
    port,
    token,
    'GET',
    `/api/v1/os/conversations/${encodeURIComponent(conversationId)}/events?after=0&limit=500`,
  )
  return result.events
}

async function boardJob(
  port: number,
  token: string,
  boardId: number,
  jobId: string,
): Promise<Json> {
  const result = await api(
    port,
    token,
    'GET',
    `/api/v1/os/boards/${boardId}/jobs`,
  )
  const job = result.jobs.find((candidate: Json) => candidate.id === jobId)
  if (!job) throw new Error(`job ${jobId} is missing from board ${boardId}`)
  return job
}

function assertExactlyOnceOrdering(events: Json[]): void {
  expect(events.length).toBeGreaterThan(0)
  expect(events.map((event) => event.sequence)).toEqual(
    Array.from({ length: events.length }, (_, index) => index + 1),
  )
  expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
  expect(new Set(events.map((event) => event.dedupe_key)).size).toBe(events.length)
  const providerEventIds = events
    .map((event) => event.provider_event_id)
    .filter((value): value is string => typeof value === 'string')
  expect(new Set(providerEventIds).size).toBe(providerEventIds.length)
}

function nativeMethodCount(events: Json[], method: string): number {
  return events.filter((event) => event.metadata?.native_method === method).length
}

async function waitForBrowserAcceptance(input: {
  port: number
  tokenPath: string
  boardId: number
  profileId: string
  conversationId: string
  sessionId: string
  jobId: string
  workspaceId: string
}): Promise<void> {
  const manifestPath = process.env.AGENT_HOME_BROWSER_ACCEPTANCE_MANIFEST?.trim()
  if (!manifestPath) return
  const continuePath = `${manifestPath}.continue`
  const query = new URLSearchParams({
    board: String(input.boardId),
    agent: input.profileId,
    conversation: input.conversationId,
    session: input.sessionId,
    job: input.jobId,
    workspace: input.workspaceId,
  })
  writeFileSync(manifestPath, `${JSON.stringify({
    schema_version: 1,
    state: 'daemon_restarted_provider_resumed_browser_pending',
    url: `http://127.0.0.1:${input.port}/?${query.toString()}`,
    token_path: input.tokenPath,
    continue_path: continuePath,
    expected: {
      projected_text: 'persisted before daemon restart',
      profile_id: input.profileId,
      conversation_id: input.conversationId,
      session_id: input.sessionId,
      job_id: input.jobId,
      workspace_id: input.workspaceId,
    },
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await waitFor('browser acceptance continuation', () => {
      try {
        return readFileSync(continuePath, 'utf8').trim() === 'accepted'
      } catch {
        return false
      }
    }, 120_000)
  } finally {
    rmSync(manifestPath, { force: true })
    rmSync(continuePath, { force: true })
  }
}

function readFakeCodexState(file: string): Json {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Json
  } catch {
    return { boots: 0, calls: [] }
  }
}

function initializeRepository(directory: string): void {
  for (const args of [
    ['init', '--initial-branch=main'],
    ['-c', 'user.name=Restart Acceptance', '-c', 'user.email=restart@example.invalid',
      'commit', '--allow-empty', '-m', 'initial'],
  ]) {
    const result = spawnSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`)
    }
  }
}

function initializeWorktree(repository: string, destination: string): void {
  const result = spawnSync('git', ['worktree', 'add', '--detach', destination, 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: repository,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`)
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('free port did not resolve')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function portAvailable(port: number): Promise<boolean> {
  const server = net.createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    return true
  } catch {
    return false
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${description}${detail}`)
}

async function waitForValue<T>(
  description: string,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  let value: T | undefined
  await waitFor(description, async () => {
    value = await read()
    return value !== undefined
  })
  return value as T
}
