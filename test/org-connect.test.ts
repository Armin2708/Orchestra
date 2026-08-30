import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { registerOrgCommands, type HubOrgSummary } from '../src/org-cli.js'
import type { CliCredential } from '../src/cli-auth.js'
import type { OrgCredential } from '../src/org-sync/credentials.js'

const signedIn: CliCredential = {
  hubBaseUrl: 'http://localhost:4760',
  token: 'orchestra_cli_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  email: 'armin@example.com',
}

const orgs: HubOrgSummary[] = [
  { org_id: 'org_a', name: "Armin's Organization", role: 'owner' },
  { org_id: 'org_b', name: 'Second Org', role: 'member' },
]

function setup(overrides: Parameters<typeof registerOrgCommands>[1] = {}) {
  const output: string[] = []
  const saved: OrgCredential[] = []
  const program = new Command()
  program.exitOverride()
  registerOrgCommands(program, {
    output: (line) => output.push(line),
    saveCredential: async (credential) => { saved.push(credential) },
    loadCliCredential: async () => signedIn,
    listOrgs: async () => orgs,
    mintDevice: async () => 'orchestra_device_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    daemonOrgState: async () => ({ joined: true, state: 'live' }),
    // no animation in tests, just run the work
    spinner: async (_label, work) => { await work() },
    deviceName: () => 'mac',
    connectTimeoutMs: 1_000,
    ...overrides,
  })
  return {
    output, saved,
    run: (args: string[]) => program.parseAsync(['node', 'orchestra', ...args]),
  }
}

describe('orchestra org connect', () => {
  it('connects the single organization without asking', async () => {
    const chooseOrg = vi.fn()
    const { run, output, saved } = setup({ listOrgs: async () => [orgs[0]], chooseOrg })

    await run(['org', 'connect'])

    expect(chooseOrg).not.toHaveBeenCalled()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ orgId: 'org_a', deviceName: 'mac' })
    expect(output.join('\n')).toContain("connected to Armin's Organization")
  })

  it('asks which organization when there is more than one', async () => {
    const chooseOrg = vi.fn(async () => orgs[1])
    const { run, saved } = setup({ chooseOrg })

    await run(['org', 'connect'])

    expect(chooseOrg).toHaveBeenCalledOnce()
    expect(saved[0].orgId).toBe('org_b')
  })

  it('honours --org and refuses one you do not belong to', async () => {
    const { run, saved } = setup()
    await run(['org', 'connect', '--org', 'org_b'])
    expect(saved[0].orgId).toBe('org_b')

    const other = setup()
    await expect(other.run(['org', 'connect', '--org', 'org_zzz'])).rejects.toThrow(/not a member/)
  })

  it('refuses to connect when nobody has logged in', async () => {
    const { run } = setup({ loadCliCredential: async () => null })
    await expect(run(['org', 'connect'])).rejects.toThrow(/orchestra login/)
  })

  it('never prints the device token it just minted', async () => {
    const token = 'orchestra_device_v1.secretsecretsecretsecret'
    const { run, output } = setup({ mintDevice: async () => token })

    await run(['org', 'connect', '--org', 'org_a'])

    expect(output.join('\n')).not.toContain(token)
    expect(output.join('\n')).not.toContain(signedIn.token)
  })

  // The waiting is only meaningful because the daemon connects live — see
  // src/org-sync/supervisor.ts. With no daemon running there is nothing to wait for.
  it('saves the credential and says so when no daemon is running', async () => {
    const { run, output, saved } = setup({
      daemonOrgState: async () => { throw new Error('daemon unreachable') },
    })

    await run(['org', 'connect', '--org', 'org_a'])

    expect(saved).toHaveLength(1)
    expect(output.join('\n')).toContain('will connect when you next start Orchestra')
  })

  it('waits for the sync loop rather than declaring success immediately', async () => {
    const states = [
      { joined: false, state: 'off' },
      { joined: true, state: 'connecting' },
      { joined: true, state: 'live' },
    ]
    let calls = 0
    const { run, output } = setup({
      daemonOrgState: async () => states[Math.min(calls++, states.length - 1)],
    })

    await run(['org', 'connect', '--org', 'org_a'])

    expect(calls).toBeGreaterThan(1)
    expect(output.join('\n')).not.toContain('will connect when you next start')
  })

  it('gives up waiting without claiming a connection that never happened', async () => {
    const { run, output } = setup({
      daemonOrgState: async () => ({ joined: false, state: 'off' }),
      connectTimeoutMs: 300,
    })

    await run(['org', 'connect', '--org', 'org_a'])

    expect(output.join('\n')).toContain('will connect when you next start Orchestra')
  })
})

describe('CLI credential storage', () => {
  it('writes 0600 and round-trips, returning null for a corrupt file', async () => {
    const { saveCliCredential, loadCliCredential, clearCliCredential } = await import('../src/cli-auth.js')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-auth-'))
    try {
      expect(await loadCliCredential(home)).toBeNull()
      await saveCliCredential(signedIn, home)
      expect(await loadCliCredential(home)).toEqual(signedIn)
      expect(fs.statSync(path.join(home, 'cli-auth.json')).mode & 0o777).toBe(0o600)

      fs.writeFileSync(path.join(home, 'cli-auth.json'), 'not json')
      expect(await loadCliCredential(home)).toBeNull()

      await clearCliCredential(home)
      expect(fs.existsSync(path.join(home, 'cli-auth.json'))).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
