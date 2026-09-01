// Per-provider authentication status.
//
// Orchestra NEVER stores provider credentials. Each CLI owns its own login and
// credential storage; this module only *reads* the status each CLI already
// publishes, and hands back the documented login command for the operator to run.
// That is what makes "I already logged into claude, so Orchestra just works" true.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type ProviderAuthStatus = {
  provider_id: string
  status: 'authenticated' | 'signed_out' | 'unknown'
  /** Non-secret identity label (e.g. an account email) when the CLI reports one. */
  account: string | null
  method: string | null
  /** Documented command that starts the native login. Shown to the operator; never auto-run. */
  login_command: string | null
  detail?: string
}

type AuthProbe = {
  args: readonly string[]
  login: string
  parse: (output: string) => Pick<ProviderAuthStatus, 'status' | 'account' | 'method'>
}

// Redacted by construction: only a boolean state, a method name, and an account
// label ever leave the probe — tokens and keys are never read or surfaced.
const parseClaude = (output: string): Pick<ProviderAuthStatus, 'status' | 'account' | 'method'> => {
  try {
    const row = JSON.parse(output) as Record<string, unknown>
    const method = typeof row.authMethod === 'string' ? row.authMethod : null
    const account = typeof row.email === 'string' ? row.email : null
    if (row.loggedIn === true) return { status: 'authenticated', account, method }
    if (row.loggedIn === false) return { status: 'signed_out', account: null, method: null }
    return { status: 'unknown', account: null, method }
  } catch {
    return { status: 'unknown', account: null, method: null }
  }
}

const parseCodex = (output: string): Pick<ProviderAuthStatus, 'status' | 'account' | 'method'> => {
  const text = output.trim()
  if (/not logged in|logged out|no credentials/i.test(text)) {
    return { status: 'signed_out', account: null, method: null }
  }
  const match = text.match(/logged in(?:\s+using\s+(.+))?/i)
  if (match) {
    return { status: 'authenticated', account: null, method: match[1]?.trim() ?? null }
  }
  return { status: 'unknown', account: null, method: null }
}

// `qwen auth` was removed from the CLI; the only published auth state is the
// selected provider profile in ~/.qwen/settings.json. Only the selection label
// is read — never the keys it references.
const qwenSettingsAuthSelection = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const home = env.HOME ?? env.USERPROFILE
  if (!home) return null
  try {
    const raw = readFileSync(join(home, '.qwen', 'settings.json'), 'utf8')
    const row = JSON.parse(raw) as Record<string, unknown>
    const security = row.security
    const auth = security && typeof security === 'object'
      ? (security as Record<string, unknown>).auth
      : undefined
    const selected = auth && typeof auth === 'object'
      ? (auth as Record<string, unknown>).selectedType
      : undefined
    return typeof selected === 'string' && selected.trim() ? selected.trim() : null
  } catch {
    return null
  }
}

const parseQwen = (_output: string): Pick<ProviderAuthStatus, 'status' | 'account' | 'method'> => {
  const selectedType = qwenSettingsAuthSelection()
  if (!selectedType) return { status: 'signed_out', account: null, method: null }
  return { status: 'authenticated', account: null, method: `qwen_settings:${selectedType}` }
}

// OpenCode manages its own auth via `opencode auth login`, but this pass does
// not parse its output into a status: the provider adapter's own readiness
// probe (`probeOpenCodeProviderReadinessV1`) deliberately reports
// `auth_status: 'unknown'` rather than 'ready', since OpenCode's readiness
// depends on whichever upstream provider(s) the user configured — not a
// single vendor credential like Qwen/Codex. Reporting `unknown` here matches
// that same honest stance instead of inventing an unverified CLI output parse.
const PROBES: Readonly<Record<string, AuthProbe>> = {
  claude: { args: ['auth', 'status', '--json'], login: 'claude /login', parse: parseClaude },
  codex: { args: ['login', 'status'], login: 'codex login', parse: parseCodex },
  qwen: { args: ['--version'], login: 'qwen', parse: parseQwen },
  kimi: { args: ['--version'], login: 'kimi', parse: () => ({ status: 'unknown', account: null, method: null }) },
  opencode: { args: ['--version'], login: 'opencode auth login', parse: () => ({ status: 'unknown', account: null, method: null }) },
}

export const providerLoginCommand = (providerId: string): string | null =>
  PROBES[providerId]?.login ?? null

/** First executable named `command` on PATH, for providers without a standalone discovery. */
export const resolveExecutableOnPath = (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* keep scanning PATH */ }
  }
  return null
}

// Only variables the CLI needs to find its own config — no ambient secrets cross
// this boundary, matching how the Claude adapter already probes readiness.
const credentialFreeEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of [
    'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA',
    'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'PATH', 'PATHEXT',
    'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'TMPDIR',
    // USER/LOGNAME are not secrets, but the CLI needs them to resolve its own
    // credential store — without USER, Claude reports a FALSE "signed out",
    // which would tell an already-logged-in operator to log in again.
    'USER', 'LOGNAME',
  ]) {
    if (typeof source[name] === 'string') environment[name] = source[name]
  }
  return environment
}

export const readProviderAuthStatus = (
  providerId: string,
  executable: string | null,
  deps: { run?: (executable: string, args: readonly string[]) => string | null } = {},
): ProviderAuthStatus => {
  const probe = PROBES[providerId]
  const login_command = probe?.login ?? null
  if (!probe) {
    return { provider_id: providerId, status: 'unknown', account: null, method: null, login_command, detail: 'no auth probe for this provider' }
  }
  if (!executable) {
    return { provider_id: providerId, status: 'unknown', account: null, method: null, login_command, detail: 'CLI is not installed' }
  }
  // spawnSync, not execFileSync: Codex prints "Logged in using ChatGPT" to STDERR,
  // and a non-zero exit ("not logged in") is still an informative answer. Both
  // streams are read regardless of exit code so neither case reports a false unknown.
  const runner = deps.run ?? ((file: string, args: readonly string[]) => {
    const outcome = spawnSync(file, [...args], {
      encoding: 'utf8',
      env: credentialFreeEnvironment(process.env),
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 1 << 16,
    })
    if (outcome.error) return null
    const captured = `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}`.trim()
    return captured || null
  })
  const output = runner(executable, probe.args)
  if (output === null) {
    return { provider_id: providerId, status: 'unknown', account: null, method: null, login_command, detail: 'auth probe failed' }
  }
  return { provider_id: providerId, ...probe.parse(output), login_command }
}
