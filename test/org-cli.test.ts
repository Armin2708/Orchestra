import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerOrgCommands } from '../src/org-cli.js'
import type { OrgCredential } from '../src/org-sync/credentials.js'
import { clearOrgSyncState } from '../src/org-sync/state.js'
import { Outbox } from '../src/org-sync/outbox.js'
import { SyncLoop } from '../src/org-sync/sync-loop.js'

const valid: OrgCredential = {
  hubBaseUrl: 'https://hub.example.test',
  orgId: 'org_example',
  deviceToken: 'orchestra_device_v1.secret-value',
  deviceName: 'workstation',
}

const setup = (overrides: Parameters<typeof registerOrgCommands>[1] = {}) => {
  const output: string[] = []
  const saved: OrgCredential[] = []
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerOrgCommands(program, {
    loadCredential: async () => null,
    saveCredential: async (credential) => { saved.push(credential) },
    clearCredential: async () => undefined,
    verifyCredential: async () => undefined,
    readToken: async () => valid.deviceToken,
    deviceName: () => 'workstation',
    output: (line) => output.push(line),
    ...overrides,
  })
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { output, run, saved }
}

describe('org CLI', () => {
  it('rejects a token with the wrong prefix without saving or printing it', async () => {
    const token = 'definitely-not-a-device-token'
    const verifyCredential = vi.fn()
    const { output, run, saved } = setup({ verifyCredential })

    await expect(run('org', 'join', '--hub', valid.hubBaseUrl, '--org', valid.orgId, '--token', token))
      .rejects.toThrow('valid Orchestra device token')

    expect(saved).toHaveLength(0)
    expect(verifyCredential).not.toHaveBeenCalled()
    expect(output.join('\n')).not.toContain(token)
  })

  it('verifies and saves a token read from stdin', async () => {
    const verifyCredential = vi.fn(async () => undefined)
    const { output, run, saved } = setup({ verifyCredential })

    await run('org', 'join', '--hub', `${valid.hubBaseUrl}/`, '--org', valid.orgId, '--token-stdin')

    expect(saved).toEqual([valid])
    expect(verifyCredential).toHaveBeenCalledWith(valid)
    expect(output.join('\n')).toContain(`joined ${valid.orgId}`)
    expect(output.join('\n')).not.toContain(valid.deviceToken)
  })

  it('status prints non-secret fields and current verification state', async () => {
    const verifyCredential = vi.fn(async () => undefined)
    const { output, run } = setup({
      loadCredential: async () => valid,
      verifyCredential,
    })

    await run('org', 'status')

    expect(output.join('\n')).toContain(valid.orgId)
    expect(output.join('\n')).toContain(valid.hubBaseUrl)
    expect(output.join('\n')).toContain(valid.deviceName)
    expect(output.join('\n')).toContain('verified')
    expect(output.join('\n')).not.toContain(valid.deviceToken)
  })

  it('status reports the daemon sync state, with the hub refusal when there is one', async () => {
    const { output, run } = setup({
      loadCredential: async () => valid,
      verifyCredential: async () => undefined,
      daemonOrgState: async () => ({
        joined: true, state: 'auth-failed', detail: 'this org has no subscription',
      } as { joined: boolean; state: string }),
    })

    await run('org', 'status')

    expect(output.join('\n')).toContain('sync: auth-failed — this org has no subscription')
  })

  it('status says nothing is syncing when no daemon is running', async () => {
    const { output, run } = setup({
      loadCredential: async () => valid,
      verifyCredential: async () => undefined,
      daemonOrgState: async () => { throw new Error('daemon unreachable') },
    })

    await run('org', 'status')

    expect(output.join('\n')).toContain('sync: daemon not running — nothing is syncing')
  })

  it('leave clears the credential and explains server-side revocation', async () => {
    const clearCredential = vi.fn(async () => undefined)
    const clearSyncState = vi.fn(async () => undefined)
    const { output, run } = setup({ clearCredential, clearSyncState })

    await run('org', 'leave')

    expect(clearCredential).toHaveBeenCalledOnce()
    expect(clearSyncState).toHaveBeenCalledOnce()
    expect(output.join('\n')).toContain('does not revoke')
    expect(output.join('\n')).toContain('organization settings')
  })

  it('starts org B from zero without posting org A state after leave', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-org-switch-'))
    try {
      fs.writeFileSync(path.join(home, 'org-cursor.json'), JSON.stringify({ version: 1, seq: 500 }))
      const orgAOutbox = new Outbox(home)
      orgAOutbox.enqueue('card.create', { board_id: 'board_a', title: 'Only for org A' })
      fs.writeFileSync(path.join(home, 'org-state.json'), JSON.stringify({ version: 1, lastSeq: 500 }))
      const { run } = setup({
        clearSyncState: () => clearOrgSyncState(home),
          })

      await run('org', 'leave')
      await run('org', 'join', '--hub', valid.hubBaseUrl, '--org', 'org_b', '--token-stdin')

      const starts: number[] = []
      const client = {
        postOp: vi.fn(),
        streamSince: vi.fn(async (since: number, _onEvent: unknown, signal: AbortSignal) => {
          starts.push(since)
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve()
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }),
      }
      const outbox = new Outbox(home)
      const loop = new SyncLoop({ client, outbox, home, applyEvent: vi.fn() })
      loop.start()
      await vi.waitFor(() => expect(starts).toEqual([0]))
      await loop.stop()

      expect(outbox.size()).toBe(0)
      expect(client.postOp).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(home, 'org-state.json'))).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // The guarantee the restart used to break: connecting to an organization must not
  // interrupt anyone's agents. The daemon watches the credential instead
  // (src/org-sync/supervisor.ts), so the CLI has no reason to touch the process.
  it('never stops or starts the daemon', async () => {
    const source = fs.readFileSync(new URL('../src/org-cli.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\/[^\n]*/gu, '')
    for (const control of ['stopDaemon', 'ensureDaemon', 'waitForDaemonExit', 'restart']) {
      expect(code).not.toContain(control)
    }
  })
})
