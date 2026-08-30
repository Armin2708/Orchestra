import type { Command } from 'commander'
import os from 'node:os'
import { loadCliCredential, type CliCredential } from './cli-auth.js'
import {
  clearOrgCredential,
  DEVICE_TOKEN_PREFIX,
  loadOrgCredential,
  saveOrgCredential,
  type OrgCredential,
} from './org-sync/credentials.js'

export interface OrgConnectDeps {
  loadCliCredential?: () => Promise<CliCredential | null>
  /** Injected in tests; in production these are plain fetches to the hub and the daemon. */
  listOrgs?: (credential: CliCredential) => Promise<HubOrgSummary[]>
  mintDevice?: (credential: CliCredential, orgId: string, name: string) => Promise<string>
  daemonOrgState?: () => Promise<{ joined: boolean; state: string }>
  chooseOrg?: (orgs: HubOrgSummary[]) => Promise<HubOrgSummary>
  spinner?: (label: string, work: () => Promise<void>) => Promise<void>
  connectTimeoutMs?: number
}

export interface HubOrgSummary { org_id: string; name: string; role: string }

export interface OrgCliDeps extends OrgConnectDeps {
  loadCredential?: () => Promise<OrgCredential | null>
  saveCredential?: (credential: OrgCredential) => Promise<void>
  clearCredential?: () => Promise<void>
  clearSyncState?: () => Promise<void>
  verifyCredential?: (credential: OrgCredential) => Promise<void>
  readToken?: () => Promise<string>
  deviceName?: () => string
  output?: (line: string) => void
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

// Joining used to stop and restart the daemon, because the daemon read the credential
// only at boot. It now watches for the change (src/org-sync/supervisor.ts), so joining
// no longer interrupts anyone's agents — a running daemon connects on its own, and one
// that is not running picks the credential up whenever it next starts.


/** A terminal spinner that yields to a plain line when stdout is not a TTY (CI, pipes). */
export function ttySpinner(output: (line: string) => void) {
  return async (label: string, work: () => Promise<void>): Promise<void> => {
    if (!process.stdout.isTTY) {
      output(`${label}…`)
      await work()
      return
    }
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let index = 0
    const timer = setInterval(() => {
      process.stdout.write(`\r${frames[index++ % frames.length]} ${label}`)
    }, 80)
    try {
      await work()
    } finally {
      clearInterval(timer)
      // Clear the whole line rather than just returning the cursor: the spinner text is
      // longer than what replaces it, so leftovers would remain on screen.
      process.stdout.write(`\r${' '.repeat(label.length + 4)}\r`)
    }
  }
}

const hubJson = async (
  credential: CliCredential, method: string, path: string, body?: unknown,
): Promise<unknown> => {
  const response = await fetch(`${credential.hubBaseUrl}/api/v1/hub${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 403) {
    throw new Error('your Orchestra Cloud sign-in is no longer valid — run `orchestra login` again')
  }
  if (!response.ok) throw new Error(`the hub returned HTTP ${response.status}`)
  return response.json()
}


/**
 * Numbered picker rather than arrow-key navigation: it needs no raw-mode terminal handling,
 * works over ssh and in every terminal, and is readable when someone screenshots it.
 */
async function promptForOrg(orgs: HubOrgSummary[]): Promise<HubOrgSummary> {
  const readline = await import('node:readline/promises')
  console.log('which organization?')
  orgs.forEach((org, index) => console.log(`  ${index + 1}) ${org.name}  (${org.role})`))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`choose 1-${orgs.length}: `)).trim()
    const index = Number(answer) - 1
    if (!Number.isInteger(index) || index < 0 || index >= orgs.length) {
      throw new Error(`expected a number between 1 and ${orgs.length}`)
    }
    return orgs[index]
  } finally {
    rl.close()
  }
}


export interface ConnectOrgDeps {
  loadCliCredential: () => Promise<CliCredential | null>
  listOrgs: (credential: CliCredential) => Promise<HubOrgSummary[]>
  mintDevice: (credential: CliCredential, orgId: string, name: string) => Promise<string>
  saveCredential: (credential: OrgCredential) => Promise<void>
  daemonOrgState: () => Promise<{ joined: boolean; state: string }>
  chooseOrg: (orgs: HubOrgSummary[]) => Promise<HubOrgSummary>
  spinner: (label: string, work: () => Promise<void>) => Promise<void>
  deviceName: () => string
  output: (line: string) => void
  connectTimeoutMs: number
}

/**
 * Connect this machine to an organization. Shared by `orchestra org connect` and the
 * sign-in prompt on the startup splash, so both behave identically.
 */
export async function connectOrg(
  deps: ConnectOrgDeps, options: { org?: string; name?: string } = {},
): Promise<{ org: HubOrgSummary; live: boolean }> {
  const credential = await deps.loadCliCredential()
  if (!credential) throw new Error('not signed in — run `orchestra login` first')

  const orgs = await deps.listOrgs(credential)
  if (orgs.length === 0) {
    throw new Error('this account has no organizations yet — create one in Orchestra Cloud')
  }
  const wanted = options.org?.trim()
  const chosen = wanted
    ? orgs.find((org) => org.org_id === wanted)
    // A single organization is not a choice worth interrupting anyone for.
    : orgs.length === 1 ? orgs[0] : await deps.chooseOrg(orgs)
  if (!chosen) throw new Error(`you are not a member of ${wanted}`)

  const name = (options.name ?? deps.deviceName()).trim()
  const token = await deps.mintDevice(credential, chosen.org_id, name)
  await deps.saveCredential({
    hubBaseUrl: normalizedHubUrl(credential.hubBaseUrl),
    orgId: chosen.org_id,
    deviceToken: token,
    deviceName: name,
  })

  // The daemon watches the credential file, so this is a real wait on a real state change,
  // not a decorative pause. If no daemon is running there is nothing to wait for — the
  // credential is saved and the next start picks it up.
  let live = false
  await deps.spinner(`connecting to ${chosen.name}`, async () => {
    const deadline = Date.now() + deps.connectTimeoutMs
    while (Date.now() < deadline) {
      const state = await deps.daemonOrgState().catch(() => null)
      if (state === null) return
      if (state.joined && state.state !== 'off' && state.state !== 'offline') { live = true; return }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })
  return { org: chosen, live }
}

/** The production wiring for `connectOrg`, shared by the CLI command and the splash prompt. */
export function defaultConnectOrgDeps(output: (line: string) => void = console.log): ConnectOrgDeps {
  return {
    loadCliCredential: () => loadCliCredential(),
    listOrgs: async (credential) =>
      ((await hubJson(credential, 'GET', '/cli/orgs')) as { orgs: HubOrgSummary[] }).orgs,
    mintDevice: async (credential, orgId, name) =>
      ((await hubJson(credential, 'POST', `/cli/orgs/${encodeURIComponent(orgId)}/devices`, { name })) as { token: string }).token,
    saveCredential: (credential) => saveOrgCredential(credential),
    daemonOrgState: async () => {
      const { baseUrl } = await import('./daemon.js')
      const response = await fetch(`${baseUrl()}/api/v1/org`, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new Error('daemon unreachable')
      return await response.json() as { joined: boolean; state: string }
    },
    chooseOrg: promptForOrg,
    spinner: ttySpinner(output),
    deviceName: () => os.hostname().split('.')[0],
    output,
    connectTimeoutMs: 20_000,
  }
}

export function registerOrgCommands(program: Command, deps: OrgCliDeps = {}): void {
  const load = deps.loadCredential ?? (() => loadOrgCredential())
  const save = deps.saveCredential ?? ((credential) => saveOrgCredential(credential))
  const clear = deps.clearCredential ?? (() => clearOrgCredential())
  const clearState = deps.clearSyncState ?? (async () => {
    const { clearOrgSyncState } = await import('./org-sync/state.js')
    await clearOrgSyncState()
  })
  const verify = deps.verifyCredential ?? verifyOrgCredential
  const loadCli = deps.loadCliCredential ?? (() => loadCliCredential())
  const listOrgs = deps.listOrgs ?? (async (credential: CliCredential) =>
    ((await hubJson(credential, 'GET', '/cli/orgs')) as { orgs: HubOrgSummary[] }).orgs)
  const mintDevice = deps.mintDevice ?? (async (credential: CliCredential, orgId: string, name: string) =>
    ((await hubJson(credential, 'POST', `/cli/orgs/${encodeURIComponent(orgId)}/devices`, { name })) as { token: string }).token)
  const daemonOrgState = deps.daemonOrgState ?? (async () => {
    const { baseUrl } = await import('./daemon.js')
    const response = await fetch(`${baseUrl()}/api/v1/org`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) throw new Error('daemon unreachable')
    return await response.json() as { joined: boolean; state: string }
  })
  const chooseOrg = deps.chooseOrg ?? promptForOrg
  const connectTimeoutMs = deps.connectTimeoutMs ?? 20_000
  const readToken = deps.readToken ?? tokenFromStdin
  const deviceName = deps.deviceName ?? (() => os.hostname().split('.')[0])
  const output = deps.output ?? console.log
  const spin = deps.spinner ?? ttySpinner(output)

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
      output(`joined ${credential.orgId} at ${credential.hubBaseUrl} as ${credential.deviceName}`)
    })

  org.command('connect')
    .description('connect this machine to one of your organizations (requires `orchestra login`)')
    .option('--org <id>', 'skip the picker and connect this organization')
    .option('--name <name>', 'device name shown in organization settings')
    .action(async (options: { org?: string; name?: string }) => {
      const { org, live } = await connectOrg({
        loadCliCredential: loadCli, listOrgs, mintDevice, saveCredential: save,
        daemonOrgState, chooseOrg, spinner: spin, deviceName, output, connectTimeoutMs,
      }, options)
      output(`connected to ${org.name}`)
      if (!live) {
        output('the daemon is not running yet — it will connect when you next start Orchestra')
      }
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
      // A running daemon clears its own cursor and outbox once it has stopped syncing;
      // this covers the case where no daemon is running to do it.
      await clearState()
      output('local organization credential removed; this does not revoke the device token server-side')
      output('revoke the device from the hosted organization settings')
    })
}
