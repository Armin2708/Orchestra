import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cloudStatusLine, offerCloudSignIn } from '../src/cloud-splash.js'
import { cloudSignInDeclined, declineCloudSignIn } from '../src/cli-auth.js'
import type { CliCredential } from '../src/cli-auth.js'
import type { OrgCredential } from '../src/org-sync/credentials.js'

const cli: CliCredential = {
  hubBaseUrl: 'http://localhost:4760', token: 'orchestra_cli_v1.x', email: 'armin@example.com',
}
const org: OrgCredential = {
  hubBaseUrl: 'http://localhost:4760', orgId: 'org_a',
  deviceToken: 'orchestra_device_v1.x', deviceName: 'mac',
}

function setup(overrides: Parameters<typeof offerCloudSignIn>[0] = {}) {
  const output: string[] = []
  const deps = {
    output: (line: string) => output.push(line),
    loadCliCredential: async () => null,
    loadOrgCredential: async () => null,
    declined: async () => false,
    remember: vi.fn(async () => {}),
    interactive: () => true,
    confirm: vi.fn(async () => false),
    signIn: vi.fn(async () => ({ email: 'armin@example.com' })),
    connect: vi.fn(async () => ({ name: "Armin's Organization", live: true })),
    ...overrides,
  }
  return { deps, output, run: () => offerCloudSignIn(deps) }
}

describe('cloud status line', () => {
  it('reads the same way as the daemon and password lines', () => {
    expect(cloudStatusLine(null, null)).toContain('not signed in to Orchestra Cloud')
    expect(cloudStatusLine(cli, org)).toContain('signed in as armin@example.com')
    expect(cloudStatusLine(cli, org)).toContain('org_a')
    expect(cloudStatusLine(cli, null)).toContain('no organization connected yet')
    // the --token-stdin path: a connected daemon with nobody signed in on this machine
    expect(cloudStatusLine(null, org)).toContain('not signed in')
  })

  it('never prints a token', () => {
    for (const line of [cloudStatusLine(cli, org), cloudStatusLine(cli, null), cloudStatusLine(null, org)]) {
      expect(line).not.toContain(cli.token)
      expect(line).not.toContain(org.deviceToken)
    }
  })
})

describe('splash sign-in offer', () => {
  it('signs in and connects when accepted', async () => {
    const { deps, output, run } = setup({ confirm: vi.fn(async () => true) })

    await run()

    expect(deps.signIn).toHaveBeenCalledOnce()
    expect(deps.connect).toHaveBeenCalledOnce()
    expect(output.join('\n')).toContain("connected to Armin's Organization")
  })

  it('remembers a decline so it never asks twice', async () => {
    const { deps, output, run } = setup({ confirm: vi.fn(async () => false) })

    await run()

    expect(deps.remember).toHaveBeenCalledOnce()
    expect(deps.signIn).not.toHaveBeenCalled()
    expect(output.join('\n')).toContain('orchestra login')
  })

  it('does not ask again once declined', async () => {
    const { deps, run } = setup({ declined: async () => true })
    await run()
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('does not ask when already signed in', async () => {
    const { deps, output, run } = setup({ loadCliCredential: async () => cli })
    await run()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(output.join('\n')).toContain('signed in as armin@example.com')
  })

  // The free local product must boot for an agent, a script, or CI with nothing to answer.
  it('never prompts when the terminal is not interactive', async () => {
    const { deps, output, run } = setup({ interactive: () => false })
    await run()
    expect(deps.confirm).not.toHaveBeenCalled()
    // the status line still prints, so the option stays discoverable
    expect(output.join('\n')).toContain('not signed in to Orchestra Cloud')
  })

  it('starts the local board anyway when the sign-in fails', async () => {
    const { output, run } = setup({
      confirm: vi.fn(async () => true),
      signIn: vi.fn(async () => { throw new Error('the hub could not be reached') }),
    })

    // must not reject: a failed cloud sign-in cannot stop a local daemon booting
    await expect(run()).resolves.toBeUndefined()
    expect(output.join('\n')).toContain('the hub could not be reached')
    expect(output.join('\n')).toContain('starting the local board anyway')
  })

  it('survives a connect that fails after a successful sign-in', async () => {
    const { output, run } = setup({
      confirm: vi.fn(async () => true),
      connect: vi.fn(async () => { throw new Error('no organizations yet') }),
    })

    await expect(run()).resolves.toBeUndefined()
    expect(output.join('\n')).toContain('signed in as armin@example.com')
    expect(output.join('\n')).toContain('no organizations yet')
  })

  it('says so when the daemon has not picked the org up yet', async () => {
    const { output, run } = setup({
      confirm: vi.fn(async () => true),
      connect: vi.fn(async () => ({ name: 'Later Org', live: false })),
    })
    await run()
    expect(output.join('\n')).toContain('will pick it up as it starts')
  })
})

describe('decline memory', () => {
  it('round-trips through ORCHESTRA_HOME', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-splash-'))
    try {
      expect(await cloudSignInDeclined(home)).toBe(false)
      await declineCloudSignIn(home)
      expect(await cloudSignInDeclined(home)).toBe(true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
