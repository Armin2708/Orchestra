import os from 'node:os'
import {
  cloudSignInDeclined,
  declineCloudSignIn,
  loadCliCredential,
  type CliCredential,
} from './cli-auth.js'
import { loadOrgCredential, type OrgCredential } from './org-sync/credentials.js'

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
}

/** The one-line cloud status shown on the splash, beside the daemon and password lines. */
export function cloudStatusLine(
  cli: CliCredential | null, org: OrgCredential | null,
): string {
  if (!cli && !org) return '  ○ not signed in to Orchestra Cloud — local board only'
  if (cli && org) return `  ● signed in as ${cli.email} — daemon connected to ${org.orgId}`
  if (cli) return `  ● signed in as ${cli.email} — no organization connected yet`
  // A device credential with no sign-in is the `org join --token-stdin` path; nothing is wrong.
  return `  ● daemon connected to ${org!.orgId} — this machine is not signed in`
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

  const [cli, org] = await Promise.all([
    loadCli().catch(() => null),
    loadOrg().catch(() => null),
  ])
  output(cloudStatusLine(cli, org))

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
