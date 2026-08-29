import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerOrgCommands } from '../src/org-cli.js'
import type { OrgCredential } from '../src/org-sync/credentials.js'

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
    activate: async () => undefined,
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
    const activate = vi.fn(async () => undefined)
    const { output, run, saved } = setup({ verifyCredential, activate })

    await run('org', 'join', '--hub', `${valid.hubBaseUrl}/`, '--org', valid.orgId, '--token-stdin')

    expect(saved).toEqual([valid])
    expect(verifyCredential).toHaveBeenCalledWith(valid)
    expect(activate).toHaveBeenCalledOnce()
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

  it('leave clears the credential and explains server-side revocation', async () => {
    const clearCredential = vi.fn(async () => undefined)
    const { output, run } = setup({ clearCredential })

    await run('org', 'leave')

    expect(clearCredential).toHaveBeenCalledOnce()
    expect(output.join('\n')).toContain('does not revoke')
    expect(output.join('\n')).toContain('organization settings')
  })
})
