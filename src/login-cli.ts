import http from 'node:http'
import os from 'node:os'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { Command } from 'commander'
import { clearCliCredential, loadCliCredential, saveCliCredential, type CliCredential } from './cli-auth.js'

export interface LoginCliDeps {
  loadCredential?: () => Promise<CliCredential | null>
  saveCredential?: (credential: CliCredential) => Promise<void>
  clearCredential?: () => Promise<void>
  openBrowser?: (url: string) => void
  output?: (line: string) => void
  /** Overall deadline for the browser round trip. */
  timeoutMs?: number
  deviceLabel?: () => string
}

const DEFAULT_HUB = 'https://api.orchestraboard.com'
const DEFAULT_WEB = 'https://cloud.orchestraboard.com'

// Overridable so a local hub can be driven end to end without editing anything.
export const cloudHubUrl = (): string => process.env.ORCHESTRA_HUB_URL?.trim() || DEFAULT_HUB
export const cloudWebUrl = (): string => process.env.ORCHESTRA_WEB_URL?.trim() || DEFAULT_WEB

const base64urlSha256 = (value: string) => createHash('sha256').update(value).digest('base64url')

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

const openInBrowser = (url: string): void => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true }).unref()
}

/**
 * OSC 8 hyperlink: modern terminals render this as clickable text and older ones just print
 * the URL, so there is no version to detect. Skipped when stdout is not a TTY, where the
 * escape sequence would be noise in a log or a pipe.
 */
const hyperlink = (url: string, text = url): string =>
  process.stdout.isTTY ? `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007` : text

interface CallbackResult { code: string }

/**
 * Waits for the browser to hand back a code on loopback.
 *
 * Binds 127.0.0.1 explicitly rather than every interface: the callback carries a
 * single-use code, and nothing outside this machine has any business delivering it.
 */
async function awaitCallback(
  state: string, timeoutMs: number,
): Promise<{ port: number; wait: Promise<CallbackResult>; close: () => void }> {
  let settle: (result: CallbackResult) => void
  let fail: (error: Error) => void
  const wait = new Promise<CallbackResult>((resolve, reject) => { settle = resolve; fail = reject })

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404).end('not found')
      return
    }
    const code = url.searchParams.get('code') ?? ''
    const returned = url.searchParams.get('state') ?? ''
    // A mismatched state means this callback did not come from the login we started —
    // a stray tab, or someone else's redirect aimed at this port.
    if (!code || !sameSecret(returned, state)) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('This login did not match the one in progress.')
      fail(new Error('the browser returned a login that does not match this one'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><meta charset="utf-8"><title>Orchestra</title>'
        + '<body style="font:16px system-ui;padding:3rem;text-align:center">'
        + '<p>Connected. You can close this tab and return to your terminal.</p>')
    settle({ code })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not open a local callback listener')

  const timer = setTimeout(() => fail(new Error('timed out waiting for the browser')), timeoutMs)
  timer.unref()

  return {
    port: address.port,
    wait,
    close: () => { clearTimeout(timer); server.close() },
  }
}

export interface PerformLoginOptions {
  hub: string
  web: string
}

export interface PerformLoginDeps {
  saveCredential?: (credential: CliCredential) => Promise<void>
  openBrowser?: (url: string) => void
  output?: (line: string) => void
  timeoutMs?: number
  deviceLabel?: () => string
}

/**
 * The whole browser handshake, shared by `orchestra login` and the sign-in prompt on the
 * startup splash. One implementation so the two can never drift apart on something as
 * security-relevant as how the code and verifier are exchanged.
 */
export async function performLogin(
  options: PerformLoginOptions, deps: PerformLoginDeps = {},
): Promise<CliCredential> {
  const save = deps.saveCredential ?? ((credential: CliCredential) => saveCliCredential(credential))
  const open = deps.openBrowser ?? openInBrowser
  const output = deps.output ?? console.log
  const timeoutMs = deps.timeoutMs ?? 180_000
  // hostnames arrive fully qualified (mac.home, mac.local) — the machine name is the useful part
  const label = deps.deviceLabel ?? (() => os.hostname().split('.')[0])

  const hub = options.hub.replace(/\/+$/, '')
  const web = options.web.replace(/\/+$/, '')
  // The verifier never leaves this process; only its hash is sent. A code lifted from
  // the redirect — browser history, a shared screen — cannot be exchanged without it.
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const machine = label()

  const started = await fetch(`${hub}/api/v1/hub/cli/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: base64urlSha256(verifier), label: machine }),
  })
  if (!started.ok) throw new Error(`could not start a login: the hub returned HTTP ${started.status}`)
  const { request_id: requestId } = await started.json() as { request_id: string }

  const callback = await awaitCallback(state, timeoutMs)
  try {
    const url = new URL(`${web}/cli`)
    url.searchParams.set('request', requestId)
    url.searchParams.set('port', String(callback.port))
    url.searchParams.set('state', state)
    url.searchParams.set('label', machine)
    output(`opening ${url.origin}/cli in your browser…`)
    output('if it does not open, paste this:')
    output(`  ${hyperlink(url.toString())}`)
    open(url.toString())

    const { code } = await callback.wait

    const exchanged = await fetch(`${hub}/api/v1/hub/cli/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, code, verifier }),
    })
    if (!exchanged.ok) throw new Error(`could not complete the login: the hub returned HTTP ${exchanged.status}`)
    const result = await exchanged.json() as { token: string; user: { email?: string } | null }

    const credential: CliCredential = {
      hubBaseUrl: hub, token: result.token, email: result.user?.email ?? 'unknown',
    }
    await save(credential)
    return credential
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}. If this machine has no browser, mint a token in Orchestra Cloud `
      + 'and run `orchestra org join --token-stdin` instead.')
  } finally {
    callback.close()
  }
}

export function registerLoginCommands(program: Command, deps: LoginCliDeps = {}): void {
  const load = deps.loadCredential ?? (() => loadCliCredential())
  const save = deps.saveCredential ?? ((credential: CliCredential) => saveCliCredential(credential))
  const clear = deps.clearCredential ?? (() => clearCliCredential())
  const open = deps.openBrowser ?? openInBrowser
  const output = deps.output ?? console.log
  const timeoutMs = deps.timeoutMs ?? 180_000
  // hostnames arrive fully qualified (mac.home, mac.local) — the machine name is the useful part
  const label = deps.deviceLabel ?? (() => os.hostname().split('.')[0])

  program.command('login')
    .description('sign in to Orchestra Cloud in your browser')
    .option('--hub <url>', 'hosted Orchestra hub base URL', cloudHubUrl())
    .option('--web <url>', 'Orchestra Cloud web URL', cloudWebUrl())
    .action(async (options: { hub: string; web: string }) => {
      const credential = await performLogin(options, {
        saveCredential: save, openBrowser: open, output, timeoutMs, deviceLabel: label,
      })
      output(`signed in as ${credential.email}`)
      output('next: orchestra org connect')
    })

  program.command('logout')
    .description('forget the Orchestra Cloud sign-in on this machine')
    .action(async () => {
      await clear()
      // Deliberately explicit: the token is gone from this machine, not from the account.
      output('signed out on this machine; the token remains valid until revoked in Orchestra Cloud')
      output('connected daemons keep their own device tokens — use `orchestra org leave` to disconnect one')
    })

  program.command('whoami')
    .description('show the Orchestra Cloud account signed in on this machine')
    .action(async () => {
      const credential = await load()
      if (!credential) {
        output('not signed in — run `orchestra login`')
        return
      }
      output(`signed in as ${credential.email}`)
      output(`hub: ${credential.hubBaseUrl}`)
    })
}
