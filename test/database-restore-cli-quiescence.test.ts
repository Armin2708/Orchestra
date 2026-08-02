import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import {
  acquireDatabaseRestoreQuiescenceGuard,
  writeDaemonQuiescenceReceipt,
} from '../src/agent-os/database-quiescence.js'

type DaemonHandle = {
  child: ChildProcess
  output(): string
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const sourceCli = path.join(repoRoot, 'src', 'cli.ts')
const fakeCodexFixture = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url))
const activeDaemons = new Set<DaemonHandle>()
const tempRoots = new Set<string>()

afterEach(async () => {
  await Promise.allSettled([...activeDaemons].map(stopDaemonProcess))
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
  activeDaemons.clear()
  tempRoots.clear()
})

describe.sequential('OPS restore CLI durable quiescence proof', () => {
  it('will not convert operator confirmation or an active PID into provider-shutdown proof', () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'orchestra-quiescence-proof-'))
    tempRoots.add(stateRoot)
    const databasePath = path.join(stateRoot, 'orchestra.db')
    openDb(databasePath).close()

    expect(() => writeDaemonQuiescenceReceipt({
      stateRoot,
      databasePath,
      daemonPid: process.pid,
      daemonLeaseOwnerId: 'test-owner',
      providerHooksInactive: false,
    })).toThrow(/provider-hook inactivity/u)
    expect(existsSync(path.join(stateRoot, 'daemon-quiescence.json'))).toBe(false)

    writeDaemonQuiescenceReceipt({
      stateRoot,
      databasePath,
      daemonPid: process.pid,
      daemonLeaseOwnerId: 'test-owner',
      providerHooksInactive: true,
    })
    expect(() => acquireDatabaseRestoreQuiescenceGuard({ stateRoot, destinationPath: databasePath }))
      .toThrow(/PID is still active/u)
    expect(existsSync(path.join(stateRoot, 'state-transition.lock'))).toBe(false)
  })

  it('rejects wrong-port and transient health failures while live, then restores after exact clean shutdown', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orchestra-restore-quiescence-'))
    tempRoots.add(root)
    const orchestraHome = path.join(root, 'orchestra-home')
    const isolatedUserHome = path.join(root, 'user-home')
    const fakeCodex = path.join(root, 'fake-codex')
    const fakeCodexState = path.join(root, 'fake-codex-state.json')
    mkdirSync(orchestraHome, { recursive: true })
    mkdirSync(isolatedUserHome, { recursive: true })
    copyFileSync(fakeCodexFixture, fakeCodex)
    chmodSync(fakeCodex, 0o755)

    const daemonPort = await freePort()
    const wrongPort = await freePort()
    const environment = daemonEnvironment({
      orchestraHome,
      isolatedUserHome,
      port: daemonPort,
      fakeCodex,
      fakeCodexState,
    })
    const daemon = await startDaemon(daemonPort, environment)

    const backup = runCli(['ops', 'backup', 'known-good'], environment)
    expect(backup.status, `${backup.stdout}\n${backup.stderr}`).toBe(0)
    const manifestPath = (JSON.parse(backup.stdout) as { manifestPath: string }).manifestPath
    const databasePath = path.join(orchestraHome, 'orchestra.db')
    const liveIdentity = statSync(databasePath)

    const wrongPortAttempt = runCli(
      ['ops', 'restore', manifestPath, '--confirm-quiesced'],
      { ...environment, ORCHESTRA_PORT: String(wrongPort) },
    )
    expect(wrongPortAttempt.status).not.toBe(0)
    expect(`${wrongPortAttempt.stdout}${wrongPortAttempt.stderr}`).toMatch(/quiescence receipt|shutdown|transition/u)
    expect(statSync(databasePath)).toMatchObject({ dev: liveIdentity.dev, ino: liveIdentity.ino })
    expect(existsSync(path.join(orchestraHome, 'quarantine'))).toBe(false)
    expect(await daemonIsHealthy(daemonPort)).toBe(true)

    const resetServer = net.createServer((socket) => socket.destroy())
    const transientPort = await listenOnFreePort(resetServer)
    try {
      const transientAttempt = runCli(
        ['ops', 'restore', manifestPath, '--confirm-quiesced'],
        { ...environment, ORCHESTRA_PORT: String(transientPort) },
      )
      expect(transientAttempt.status).not.toBe(0)
      expect(statSync(databasePath)).toMatchObject({ dev: liveIdentity.dev, ino: liveIdentity.ino })
      expect(await daemonIsHealthy(daemonPort)).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => resetServer.close((error) => error ? reject(error) : resolve()))
    }

    const stop = runCli(['stop'], environment)
    expect(stop.status, `${stop.stdout}\n${stop.stderr}`).toBe(0)
    expect(stop.stdout).toContain('stopped')
    expect(await waitForExit(daemon.child, 10_000), daemon.output()).toBe(true)
    activeDaemons.delete(daemon)
    expect(existsSync(path.join(orchestraHome, 'daemon.pid'))).toBe(false)
    const receiptPath = path.join(orchestraHome, 'daemon-quiescence.json')
    expect(existsSync(receiptPath)).toBe(true)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { daemon_pid: number }

    const restore = runCli(
      ['ops', 'restore', manifestPath, '--confirm-quiesced'],
      { ...environment, ORCHESTRA_PORT: String(wrongPort) },
    )
    expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0)
    const restored = JSON.parse(restore.stdout) as { destinationPath: string; quarantinePath: string }
    expect(realpathSync(restored.destinationPath)).toBe(realpathSync(databasePath))
    expect(existsSync(restored.quarantinePath)).toBe(true)
    expect(existsSync(path.join(orchestraHome, 'daemon-quiescence.json'))).toBe(false)

    const verified = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      expect(verified.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      const restoredLease = verified.prepare('SELECT pid FROM daemon_leases WHERE name=?')
        .get('orchestra-daemon') as { pid: number }
      expect(restoredLease.pid).toBe(receipt.daemon_pid)
      expect(daemon.child.exitCode !== null || daemon.child.signalCode !== null).toBe(true)
    } finally {
      verified.close()
    }
  }, 40_000)
})

function daemonEnvironment(input: {
  orchestraHome: string
  isolatedUserHome: string
  port: number
  fakeCodex: string
  fakeCodexState: string
}): NodeJS.ProcessEnv {
  return {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: input.isolatedUserHome,
    USER: process.env.USER ?? 'agentboard-test',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'agentboard-test',
    SHELL: process.env.SHELL ?? '/bin/sh',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    NODE_ENV: 'test',
    ORCHESTRA_HOME: input.orchestraHome,
    ORCHESTRA_PORT: String(input.port),
    ORCHESTRA_CODEX_COMMAND: input.fakeCodex,
    ORCHESTRA_CODEX_FORWARD_ENV: 'FAKE_CODEX_STATE',
    FAKE_CODEX_STATE: input.fakeCodexState,
  }
}

function runCli(args: string[], environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [tsxCli, sourceCli, ...args], {
    cwd: repoRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000,
  })
}

async function startDaemon(port: number, environment: NodeJS.ProcessEnv): Promise<DaemonHandle> {
  const child = spawn(process.execPath, [tsxCli, sourceCli, 'serve'], {
    cwd: repoRoot,
    env: environment,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const handle: DaemonHandle = { child, output: () => `stdout:\n${stdout}\nstderr:\n${stderr}` }
  activeDaemons.add(handle)
  await waitFor('daemon health', async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(handle.output())
    return daemonIsHealthy(port)
  }, 12_000)
  return handle
}

async function stopDaemonProcess(handle: DaemonHandle): Promise<void> {
  const pid = handle.child.pid
  if (pid && handle.child.exitCode === null && handle.child.signalCode === null) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already stopped */ }
    if (!(await waitForExit(handle.child, 5_000))) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
      await waitForExit(handle.child, 1_000)
    }
  }
  activeDaemons.delete(handle)
}

async function daemonIsHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) })
    return response.ok && (await response.json() as { ok?: unknown }).ok === true
  } catch { return false }
}

async function waitFor(label: string, probe: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try { if (await probe()) return } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, timeoutMs)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    child.once('exit', onExit)
  })
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  const port = await listenOnFreePort(server)
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function listenOnFreePort(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('test server did not bind a TCP port'))
      else resolve(address.port)
    })
  })
}
