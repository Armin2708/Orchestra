import type { Command } from 'commander'
import os from 'node:os'
import {
  clearOrgCredential,
  DEVICE_TOKEN_PREFIX,
  loadOrgCredential,
  saveOrgCredential,
  type OrgCredential,
} from './org-sync/credentials.js'
import { clearOrgSyncState } from './org-sync/state.js'

export interface OrgCliDeps {
  loadCredential?: () => Promise<OrgCredential | null>
  saveCredential?: (credential: OrgCredential) => Promise<void>
  clearCredential?: () => Promise<void>
  clearSyncState?: () => Promise<void>
  verifyCredential?: (credential: OrgCredential) => Promise<void>
  readToken?: () => Promise<string>
  deviceName?: () => string
  output?: (line: string) => void
  activate?: () => Promise<void>
}

const normalizedHubUrl = (raw: string): string => {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('--hub must be a valid http(s) URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--hub must be a valid http(s) URL')
  if (url.username || url.password || url.search || url.hash) throw new Error('--hub must be a bare http(s) base URL')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

const tokenFromStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').trim()
}

const verificationPath = (credential: OrgCredential): string =>
  `${credential.hubBaseUrl}/api/v1/hub/orgs/${encodeURIComponent(credential.orgId)}/boards`

export async function verifyOrgCredential(credential: OrgCredential): Promise<void> {
  let response: Response
  try {
    response = await fetch(verificationPath(credential), {
      headers: { authorization: `Bearer ${credential.deviceToken}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('credential verification failed: the hub could not be reached')
  }
  if (response.ok) return
  if (response.status === 401 || response.status === 403) {
    throw new Error('credential verification failed: the token was rejected, revoked, or belongs to another organization')
  }
  throw new Error(`credential verification failed: hub returned HTTP ${response.status}`)
}

const activateOrgSync = async (): Promise<void> => {
  const { ensureDaemon, stopDaemon, waitForDaemonExit } = await import('./daemon.js')
  if (stopDaemon() && !(await waitForDaemonExit())) {
    throw new Error('organization connection changed, but the existing daemon did not stop cleanly')
  }
  if (!(await ensureDaemon())) {
    throw new Error('organization connection changed, but the daemon could not start; run `orchestra serve`')
  }
}

export function registerOrgCommands(program: Command, deps: OrgCliDeps = {}): void {
  const load = deps.loadCredential ?? (() => loadOrgCredential())
  const save = deps.saveCredential ?? ((credential) => saveOrgCredential(credential))
  const clear = deps.clearCredential ?? (() => clearOrgCredential())
  const clearState = deps.clearSyncState ?? (() => clearOrgSyncState())
  const verify = deps.verifyCredential ?? verifyOrgCredential
  const readToken = deps.readToken ?? tokenFromStdin
  const deviceName = deps.deviceName ?? os.hostname
  const output = deps.output ?? console.log
  const activate = deps.activate ?? activateOrgSync

  const org = program.command('org').description('join or inspect a hosted Orchestra organization')
  org.command('join')
    .description('connect this daemon to a hosted Orchestra organization')
    .requiredOption('--hub <url>', 'hosted Orchestra hub base URL')
    .requiredOption('--org <id>', 'organization id')
    .option('--token <token>', 'device token (prefer --token-stdin to avoid shell history)')
    .option('--token-stdin', 'read the device token from stdin')
    .option('--name <name>', 'device name shown in organization settings')
    .action(async (options: {
      hub: string
      org: string
      token?: string
      tokenStdin?: boolean
      name?: string
    }) => {
      if (Boolean(options.token) === Boolean(options.tokenStdin)) {
        throw new Error('provide exactly one of --token or --token-stdin')
      }
      const token = (options.tokenStdin ? await readToken() : options.token ?? '').trim()
      if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length === DEVICE_TOKEN_PREFIX.length) {
        throw new Error('a valid Orchestra device token is required')
      }
      const orgId = options.org.trim()
      const name = (options.name ?? deviceName()).trim()
      if (!orgId) throw new Error('--org must not be empty')
      if (!name) throw new Error('--name must not be empty')
      const credential: OrgCredential = {
        hubBaseUrl: normalizedHubUrl(options.hub),
        orgId,
        deviceToken: token,
        deviceName: name,
      }
      await verify(credential)
      await save(credential)
      await activate()
      output(`joined ${credential.orgId} at ${credential.hubBaseUrl} as ${credential.deviceName}`)
    })

  org.command('status')
    .description('show the hosted organization connection')
    .action(async () => {
      const credential = await load()
      if (!credential) {
        output('not joined to a hosted organization')
        return
      }
      let status = 'verified'
      try { await verify(credential) } catch (error) {
        status = `not verified (${error instanceof Error ? error.message : 'verification failed'})`
      }
      output(`hub: ${credential.hubBaseUrl}`)
      output(`org: ${credential.orgId}`)
      output(`device: ${credential.deviceName}`)
      output(`credential: ${status}`)
    })

  org.command('leave')
    .description('disconnect this daemon from its hosted organization')
    .action(async () => {
      await clear()
      try {
        await activate()
      } finally {
        await clearState()
      }
      output('local organization credential removed; this does not revoke the device token server-side')
      output('revoke the device from the hosted organization settings')
    })
}
