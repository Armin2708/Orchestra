#!/usr/bin/env node

import { once } from 'node:events'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const contract = JSON.parse(
  readFileSync(new URL('./codex-protocol-contract.json', import.meta.url), 'utf8'),
)
const command = process.env.ORCHESTRA_CODEX_COMMAND?.trim() || 'codex'
const REQUEST_TIMEOUT_MS = 10_000
const STDERR_LIMIT = 16 * 1024
const FRAME_LIMIT = 8 * 1024 * 1024

const fail = (message) => {
  throw new Error(message)
}

const record = (value) => value && typeof value === 'object' && !Array.isArray(value)

const isolatedEnvironment = (root, profile) => {
  const environment = {
    CODEX_HOME: profile,
    HOME: profile,
    USERPROFILE: profile,
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    TMPDIR: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
  }
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ]) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name]
  }
  return environment
}

const exactVersion = (environment) => {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    windowsHide: true,
  })
  if (result.status !== 0) {
    fail(`Codex CLI version probe failed: ${result.error?.message ?? 'non-zero exit'}`)
  }
  const match = /^codex-cli\s+([A-Za-z0-9._+-]+)$/u.exec(result.stdout.trim())
  if (match?.[1] !== contract.cli_version) {
    fail(`Codex app-server contract requires ${contract.cli_version}; observed ${match?.[1] ?? 'unparseable'}`)
  }
}

const contractProbe = async (environment, workspace) => {
  const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let buffer = ''
  let stderr = ''
  let nextId = 1
  let closed = false
  const pending = new Map()

  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  child.on('error', (error) => rejectPending(error))
  child.on('exit', (code, signal) => {
    closed = true
    if (pending.size > 0) {
      rejectPending(new Error(
        `Codex app-server exited during contract probe (${signal ?? code ?? 'unknown'})`,
      ))
    }
  })
  child.stderr.on('data', (chunk) => {
    if (stderr.length >= STDERR_LIMIT) return
    stderr = `${stderr}${String(chunk)}`.slice(0, STDERR_LIMIT)
  })
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    if (Buffer.byteLength(buffer) > FRAME_LIMIT) {
      rejectPending(new Error('Codex app-server emitted an oversized JSONL frame'))
      child.kill('SIGKILL')
      return
    }
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        rejectPending(new Error('Codex app-server emitted invalid JSONL'))
        child.kill('SIGKILL')
        return
      }
      if (!record(message) || (typeof message.id !== 'number' && typeof message.id !== 'string')) {
        continue
      }
      const entry = pending.get(String(message.id))
      if (!entry) continue
      clearTimeout(entry.timer)
      pending.delete(String(message.id))
      if (record(message.error)) {
        entry.reject(new Error(
          `Codex app-server ${entry.method} failed (${String(message.error.code ?? 'unknown')}): ${String(message.error.message ?? 'unknown')}`,
        ))
      } else {
        entry.resolve(message.result)
      }
    }
  })

  const write = (message) => {
    if (closed || child.stdin.destroyed) fail('Codex app-server closed before probe completed')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(String(id))
      reject(new Error(`Codex app-server ${method} timed out`))
    }, REQUEST_TIMEOUT_MS)
    timer.unref?.()
    pending.set(String(id), { method, resolve, reject, timer })
    write(params === undefined ? { method, id } : { method, id, params })
  })

  try {
    const initialized = await request('initialize', {
      clientInfo: {
        name: 'orchestra_contract_probe',
        title: 'Orchestra Contract Probe',
        version: '1.0.0',
      },
      capabilities: null,
    })
    if (!record(initialized) || typeof initialized.userAgent !== 'string') {
      fail('Codex initialize response does not match the required shape')
    }
    write({ method: 'initialized' })

    const account = await request('account/read', { refreshToken: false })
    if (!record(account)
      || account.account !== null
      || typeof account.requiresOpenaiAuth !== 'boolean') {
      fail('Isolated Codex account/read response does not prove a signed-out profile')
    }

    const models = await request('model/list', { includeHidden: false })
    if (!record(models) || !Array.isArray(models.data)) {
      fail('Codex model/list response does not match the required shape')
    }

    const started = await request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      ephemeral: true,
    })
    const threadId = record(started) && record(started.thread)
      && typeof started.thread.id === 'string'
      ? started.thread.id
      : null
    if (!threadId || started.thread.cwd !== workspace) {
      fail('Codex thread/start response does not match the required shape')
    }

    const read = await request('thread/read', { threadId, includeTurns: false })
    if (!record(read) || !record(read.thread) || read.thread.id !== threadId) {
      fail('Codex thread/read response does not match the required shape')
    }

    const unsubscribed = await request('thread/unsubscribe', { threadId })
    if (!record(unsubscribed) || typeof unsubscribed.status !== 'string') {
      fail('Codex thread/unsubscribe response does not match the required shape')
    }

    return {
      initialize: true,
      signed_out_account_read: true,
      model_list: true,
      read_only_thread_start: true,
      thread_read: true,
      thread_unsubscribe: true,
    }
  } catch (error) {
    const detail = stderr.trim()
      ? `; bounded app-server stderr: ${stderr.trim().slice(0, 1_000)}`
      : ''
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`)
  } finally {
    rejectPending(new Error('Codex contract probe ended'))
    if (!closed) {
      child.stdin.end()
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ])
    }
    if (!closed) child.kill('SIGKILL')
  }
}

const root = mkdtempSync(join(tmpdir(), 'orchestra-codex-contract-'))
chmodSync(root, 0o700)
try {
  const profile = join(root, 'profile')
  const workspace = join(root, 'workspace')
  for (const directory of [
    profile,
    workspace,
    join(root, 'tmp'),
    join(root, 'xdg-cache'),
    join(root, 'xdg-config'),
    join(root, 'xdg-data'),
    join(root, 'xdg-state'),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const environment = isolatedEnvironment(root, profile)
  exactVersion(environment)
  const checks = await contractProbe(environment, workspace)
  process.stdout.write(`${JSON.stringify({
    cli_version: contract.cli_version,
    profile: 'isolated_signed_out',
    checks,
  })}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
