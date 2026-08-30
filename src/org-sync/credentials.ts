import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../daemon.js'

export const DEVICE_TOKEN_PREFIX = 'orchestra_device_v1.'

export interface OrgCredential {
  hubBaseUrl: string
  orgId: string
  deviceToken: string
  deviceName: string
  /** Human name of the organization, captured at connect time (the hub's /cli/orgs
   * listing). Display only — every API call still addresses the org by id. */
  orgName?: string
}

const credentialPath = (home?: string) => path.join(home ?? dataDir(), 'org.json')

const isCredential = (value: unknown): value is OrgCredential => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<OrgCredential>
  if (typeof candidate.hubBaseUrl !== 'string'
    || typeof candidate.orgId !== 'string'
    || typeof candidate.deviceToken !== 'string'
    || typeof candidate.deviceName !== 'string') return false
  if (!candidate.orgId || !candidate.deviceName || !candidate.deviceToken.startsWith(DEVICE_TOKEN_PREFIX)) return false
  if (candidate.orgName !== undefined && typeof candidate.orgName !== 'string') return false
  try {
    const url = new URL(candidate.hubBaseUrl)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/'
  } catch {
    return false
  }
}

export async function saveOrgCredential(credential: OrgCredential, home?: string): Promise<void> {
  if (!isCredential(credential)) throw new Error('cannot save an invalid organization credential')
  const destination = credentialPath(home)
  const directory = path.dirname(destination)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.org.json.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, destination)
    await fs.chmod(destination, 0o600)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function loadOrgCredential(home?: string): Promise<OrgCredential | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(credentialPath(home), 'utf8'))
    return isCredential(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function clearOrgCredential(home?: string): Promise<void> {
  await fs.rm(credentialPath(home), { force: true })
}
