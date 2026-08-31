import os from 'node:os'
import {
  cloudSignInDeclined,
  declineCloudSignIn,
  loadCliCredential,
  type CliCredential,
} from './cli-auth.js'
import { loadOrgCredential, type OrgCredential } from './org-sync/credentials.js'
import { dim, green } from './style.js'

export interface CloudSplashDeps {
  loadCliCredential?: () => Promise<CliCredential | null>
  loadOrgCredential?: () => Promise<OrgCredential | null>
  declined?: () => Promise<boolean>
  remember?: () => Promise<void>
  /** Asks the human. Absent/false answer means "not now". */
  confirm?: (question: string) => Promise<boolean>
  signIn?: () => Promise<{ email: string }>
  connect?: () => Promise<{ name: string; live: boolean }>
  output?: (line: string) => void
  /** Prompting only makes sense at a real terminal — never for agents, scripts, or CI. */
  interactive?: () => boolean
  /** The daemon's live org-sync state, when one is running. */
  orgSyncState?: () => Promise<{ joined: boolean; state: string } | null>
}

/**
 * The one-line cloud status shown on the splash, beside the daemon and password lines.
 *
 * A stored credential means "joined", never "working" — the sync loop can be offline or
 * stopped outright while the credential remains perfectly valid. Reporting a flat
 * "connected" in that state is how an operator ends up staring at an empty shared board
 * with nothing on screen disagreeing with them.
 */
export function cloudStatusLine(
  cli: CliCredential | null, org: OrgCredential | null, sync?: { state: string } | null,
): string {
  if (!cli && !org) return `  ${dim('○')} not signed in to Orchestra Cloud — local board only`
  const where = org ? syncPhrase(org, sync) : 'no organization connected yet'
  if (cli) return `  ${sync && sync.state !== 'live' ? dim('○') : green('●')} signed in as ${cli.email} — ${where}`
  // A device credential with no sign-in is the `org join --token-stdin` path; nothing is wrong.
  return `  ${green('●')} ${where} — this machine is not signed in`
}

const syncPhrase = (org: OrgCredential, sync?: { state: string } | null): string => {
  if (!sync) return `daemon connected to ${org.orgId}`
  if (sync.state === 'live') return `daemon syncing with ${org.orgId}`
  if (sync.state === 'off') return `joined ${org.orgId} — sync not started`
  // offline / auth-failed / terminal: joined, but not actually exchanging anything.
  return `joined ${org.orgId} — sync ${sync.state}; run \`orchestra snapshot\` or check the daemon output`
}

/**
 * Offers a cloud sign-in from the startup splash and, on yes, runs the whole browser flow
 * and connects an organization.
 *
 * The free local product must start with no account and no answer, so this only ever runs
 * at an interactive terminal, only when nothing is signed in, and only until it is declined
 * once. Any failure is reported and swallowed: a hub that is down or a browser that never
 * came back must never stop a local daemon booting.
 */
export async function offerCloudSignIn(deps: CloudSplashDeps = {}): Promise<void> {
  const output = deps.output ?? console.log
  const loadCli = deps.loadCliCredential ?? (() => loadCliCredential())
  const loadOrg = deps.loadOrgCredential ?? (() => loadOrgCredential())
  const interactive = deps.interactive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY))

  const [cli, org, sync] = await Promise.all([
    loadCli().catch(() => null),
    loadOrg().catch(() => null),
    deps.orgSyncState?.().catch(() => null) ?? Promise.resolve(null),
  ])
  output(cloudStatusLine(cli, org, sync))

  if (cli || !interactive() || !deps.confirm || !deps.signIn) return
  const declined = deps.declined ?? (() => cloudSignInDeclined())
  if (await declined().catch(() => false)) return

  const yes = await deps.confirm('  Sign in to Orchestra Cloud now? [y/N] ').catch(() => false)
  if (!yes) {
    // Remembered so the prompt never becomes something to dismiss on every start.
    await (deps.remember ?? (() => declineCloudSignIn()))().catch(() => undefined)
    output('  not now — run `orchestra login` whenever you want to connect')
    return
  }

  try {
    const account = await deps.signIn()
    output(`  signed in as ${account.email}`)
    if (!deps.connect) return
    const { name, live } = await deps.connect()
    output(live
      ? `  connected to ${name}`
      : `  connected to ${name} — the daemon will pick it up as it starts`)
  } catch (error) {
    // Never fatal: the local board is the free product and it owes nothing to the cloud.
    output(`  sign-in did not complete: ${error instanceof Error ? error.message : String(error)}`)
    output('  starting the local board anyway — run `orchestra login` to try again')
  }
}

/** Reads one line from the terminal, treating only an explicit yes as yes. */
export async function confirmAtTerminal(question: string): Promise<boolean> {
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

export const machineName = (): string => os.hostname().split('.')[0]
