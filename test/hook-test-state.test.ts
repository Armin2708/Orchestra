import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { preserveProcessEnv, runHookToCompletion } from './helpers/scoped-hook-state.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('keeps timed hook work in its originating stdout scope', async () => {
  const previousHome = process.env.ORCHESTRA_HOME
  const previousPort = process.env.ORCHESTRA_PORT
  const restoreEnv = preserveProcessEnv(['ORCHESTRA_HOME', 'ORCHESTRA_PORT'])
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hook-scope-'))
  process.env.ORCHESTRA_HOME = home
  process.env.ORCHESTRA_PORT = '65535'

  try {
    const hooks = await import('../src/hooks.js')
    const sessionId = 'slow-codex-stop'
    const sessionPath = hooks._internals.sessionFile('codex', sessionId)
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
    fs.writeFileSync(sessionPath, JSON.stringify({
      agent_id: 7,
      agent_name: 'slow-runner',
      board_id: 11,
      provider: 'codex',
      session_id: sessionId,
      session_token: 'test-session-token',
    }))

    vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({
      session_id: sessionId,
      cwd: process.cwd(),
    }))

    let releaseHeartbeat!: (response: Response) => void
    const heartbeat = new Promise<Response>((resolve) => { releaseHeartbeat = resolve })
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => heartbeat)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        cards: [{
          id: 23,
          title: 'Slow hook work',
          owner: 'slow-runner',
          column: 'in_progress',
          updated_at: '2020-01-01 00:00:00',
        }],
      }), { headers: { 'content-type': 'application/json' } }))

    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { output.push(String(line)) })

    let settled = false
    const invocation = runHookToCompletion(hooks, 'stop', 'codex').then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 2_100))

    // The test runner must keep ownership of this invocation until its work and
    // stdout finish, even though the production wrapper intentionally times out.
    expect(settled).toBe(false)

    releaseHeartbeat(new Response(null, { status: 204 }))
    await invocation

    expect(output).toHaveLength(1)
    expect(JSON.parse(output[0])).toMatchObject({
      continue: false,
      hookSpecificOutput: { hookEventName: 'Stop' },
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    restoreEnv()
  }

  expect(process.env.ORCHESTRA_HOME).toBe(previousHome)
  expect(process.env.ORCHESTRA_PORT).toBe(previousPort)
})
