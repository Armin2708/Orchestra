import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearOrgCredential,
  loadOrgCredential,
  saveOrgCredential,
  type OrgCredential,
} from '../src/org-sync/credentials.js'

const homes: string[] = []

const temporaryHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-org-credentials-'))
  homes.push(home)
  return home
}

const credential = (): OrgCredential => ({
  hubBaseUrl: 'https://hub.example.test',
  orgId: 'org_example',
  deviceToken: 'orchestra_device_v1.secret-value',
  deviceName: 'workstation',
})

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('org credential storage', () => {
  it('round-trips an owner-only credential file', async () => {
    const home = temporaryHome()
    await saveOrgCredential(credential(), home)

    expect(await loadOrgCredential(home)).toEqual(credential())
    expect(fs.statSync(path.join(home, 'org.json')).mode & 0o777).toBe(0o600)
  })

  it('returns null when the credential is absent or malformed', async () => {
    const home = temporaryHome()
    expect(await loadOrgCredential(home)).toBeNull()

    fs.writeFileSync(path.join(home, 'org.json'), '{not json', { mode: 0o600 })
    expect(await loadOrgCredential(home)).toBeNull()

    fs.writeFileSync(path.join(home, 'org.json'), JSON.stringify({ orgId: 'org_example' }), { mode: 0o600 })
    expect(await loadOrgCredential(home)).toBeNull()
  })

  it('clears an existing credential and tolerates an absent one', async () => {
    const home = temporaryHome()
    await saveOrgCredential(credential(), home)
    await clearOrgCredential(home)
    await clearOrgCredential(home)

    expect(await loadOrgCredential(home)).toBeNull()
    expect(fs.existsSync(path.join(home, 'org.json'))).toBe(false)
  })
})
