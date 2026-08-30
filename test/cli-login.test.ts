import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { Command } from 'commander'
import { registerLoginCommands } from '../src/login-cli.js'
import type { CliCredential } from '../src/cli-auth.js'

/**
 * A stand-in hub. Records what the CLI sent so the tests can assert the verifier is never
 * transmitted — only its hash — which is the whole basis of the PKCE binding.
 */
function fakeHub() {
  const seen: { challenge?: string; verifier?: string; code?: string; label?: string } = {}
  let issue = { token: 'orchestra_cli_v1.issued', email: 'armin@example.com' }
  let exchangeStatus = 200
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = body ? JSON.parse(body) : {}
      if (request.url === '/api/v1/hub/cli/auth/start') {
        seen.challenge = payload.challenge
        seen.label = payload.label
        response.writeHead(201, { 'content-type': 'application/json' })
          .end(JSON.stringify({ request_id: 'cliauth_1', expires_at: new Date().toISOString() }))
        return
      }
      if (request.url === '/api/v1/hub/cli/auth/exchange') {
        seen.verifier = payload.verifier
        seen.code = payload.code
        response.writeHead(exchangeStatus, { 'content-type': 'application/json' })
          .end(JSON.stringify({ token: issue.token, user: { email: issue.email } }))
        return
      }
      response.writeHead(404).end('{}')
    })
  })
  return {
    seen,
    failExchange: () => { exchangeStatus = 403 },
    listen: async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      return `http://127.0.0.1:${address.port}`
    },
    close: () => server.close(),
  }
}

const hubs: ReturnType<typeof fakeHub>[] = []
afterEach(() => { for (const hub of hubs.splice(0)) hub.close() })

/** Plays the part of the browser: reads the URL the CLI opened and calls its callback. */
function browser(respond: (url: URL) => { code?: string; state?: string } | null) {
  const opened: string[] = []
  return {
    opened,
    open: (raw: string) => {
      opened.push(raw)
      const url = new URL(raw)
      const answer = respond(url)
      if (!answer) return
      const port = url.searchParams.get('port')
      const target = new URL(`http://127.0.0.1:${port}/callback`)
      if (answer.code) target.searchParams.set('code', answer.code)
      target.searchParams.set('state', answer.state ?? url.searchParams.get('state') ?? '')
      // The real browser navigates; a plain GET is the same thing to the listener.
      setTimeout(() => { void fetch(target.toString()).catch(() => undefined) }, 10)
    },
  }
}

function setup(hubUrl: string, open: (url: string) => void, overrides = {}) {
  const output: string[] = []
  const saved: CliCredential[] = []
  const program = new Command()
  program.exitOverride()
  registerLoginCommands(program, {
    output: (line) => output.push(line),
    saveCredential: async (credential) => { saved.push(credential) },
    openBrowser: open,
    deviceLabel: () => 'mac',
    timeoutMs: 4_000,
    ...overrides,
  })
  return {
    output, saved,
    run: (args: string[]) => program.parseAsync(['node', 'orchestra', '--', ...args].filter((a) => a !== '--')),
  }
}

describe('orchestra login', () => {
  it('completes the browser handshake and stores the credential', async () => {
    const hub = fakeHub(); hubs.push(hub)
    const hubUrl = await hub.listen()
    const web = browser(() => ({ code: 'the-code' }))
    const { run, output, saved } = setup(hubUrl, web.open)

    await run(['login', '--hub', hubUrl, '--web', 'https://cloud.example.com'])

    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ hubBaseUrl: hubUrl, token: 'orchestra_cli_v1.issued', email: 'armin@example.com' })
    expect(output.join('\n')).toContain('signed in as armin@example.com')
  })

  it('sends only the hash of the verifier when starting, and the verifier only when exchanging', async () => {
    const hub = fakeHub(); hubs.push(hub)
    const hubUrl = await hub.listen()
    const web = browser(() => ({ code: 'the-code' }))
    const { run } = setup(hubUrl, web.open)

    await run(['login', '--hub', hubUrl, '--web', 'https://cloud.example.com'])

    expect(hub.seen.verifier).toBeTruthy()
    expect(hub.seen.challenge).toBe(createHash('sha256').update(hub.seen.verifier!).digest('base64url'))
    expect(hub.seen.challenge).not.toBe(hub.seen.verifier)
    expect(hub.seen.label).toBe('mac')
  })

  it('opens a URL carrying the request, the loopback port, and the state', async () => {
    const hub = fakeHub(); hubs.push(hub)
    const hubUrl = await hub.listen()
    const web = browser(() => ({ code: 'the-code' }))
    const { run } = setup(hubUrl, web.open)

    await run(['login', '--hub', hubUrl, '--web', 'https://cloud.example.com'])

    const opened = new URL(web.opened[0])
    expect(opened.origin + opened.pathname).toBe('https://cloud.example.com/cli')
    expect(opened.searchParams.get('request')).toBe('cliauth_1')
    expect(Number(opened.searchParams.get('port'))).toBeGreaterThan(0)
    expect(opened.searchParams.get('state')).toBeTruthy()
  })

  // A callback with someone else's state is not this login. Accepting it would let any page
  // the user visits complete a login against whatever port happens to be listening.
  it('refuses a callback whose state does not match', async () => {
    const hub = fakeHub(); hubs.push(hub)
    const hubUrl = await hub.listen()
    const web = browser(() => ({ code: 'the-code', state: 'not-the-state' }))
    const { run, saved } = setup(hubUrl, web.open)

    await expect(run(['login', '--hub', hubUrl, '--web', 'https://cloud.example.com']))
      .rejects.toThrow(/does not match/)
    expect(saved).toHaveLength(0)
  })

  it('refuses a callback with no code', async () => {
    const hub = fakeHub(); hubs.push(hub)
    const hubUrl = await hub.listen()
    const web = browser((url) => ({ state: url.searchParams.get('state') ?? '' }))
    const { run, saved } = setup(hubUrl, web.open)

    await expect(run(['login', '--hub', hubUrl, '--web', 'https://cloud.example.com'])).rejects.toThrow()
    expect(saved).toHaveLength(0)
  })

  it('times out with the headless fallback named, and stores nothing', async () => {
    const hub = fakeHub(); hubs.push(hub)
    const hubUrl = await hub.listen()
    const { run, saved } = setup(hubUrl, () => {}, { timeoutMs: 200 })

    await expect(run(['login', '--hub', hubUrl, '--web', 'https://cloud.example.com']))
      .rejects.toThrow(/token-stdin/)
    expect(saved).toHaveLength(0)
  })

  it('stores nothing when the hub refuses the exchange', async () => {
    const hub = fakeHub(); hubs.push(hub)
    const hubUrl = await hub.listen()
    hub.failExchange()
    const web = browser(() => ({ code: 'the-code' }))
    const { run, saved } = setup(hubUrl, web.open)

    await expect(run(['login', '--hub', hubUrl, '--web', 'https://cloud.example.com'])).rejects.toThrow(/403/)
    expect(saved).toHaveLength(0)
  })

  it('never prints the token it received', async () => {
    const hub = fakeHub(); hubs.push(hub)
    const hubUrl = await hub.listen()
    const web = browser(() => ({ code: 'the-code' }))
    const { run, output } = setup(hubUrl, web.open)

    await run(['login', '--hub', hubUrl, '--web', 'https://cloud.example.com'])

    expect(output.join('\n')).not.toContain('orchestra_cli_v1.issued')
  })
})

describe('orchestra whoami / logout', () => {
  it('reports the signed-in account without printing the token', async () => {
    const output: string[] = []
    const program = new Command()
    registerLoginCommands(program, {
      output: (line) => output.push(line),
      loadCredential: async () => ({
        hubBaseUrl: 'http://localhost:4760', token: 'orchestra_cli_v1.secret', email: 'armin@example.com',
      }),
    })
    await program.parseAsync(['node', 'orchestra', 'whoami'])

    expect(output.join('\n')).toContain('armin@example.com')
    expect(output.join('\n')).not.toContain('orchestra_cli_v1.secret')
  })

  it('says plainly that logging out does not revoke the token', async () => {
    const output: string[] = []
    const clear = vi.fn(async () => {})
    const program = new Command()
    registerLoginCommands(program, { output: (line) => output.push(line), clearCredential: clear })

    await program.parseAsync(['node', 'orchestra', 'logout'])

    expect(clear).toHaveBeenCalledOnce()
    expect(output.join('\n')).toMatch(/remains valid until revoked/)
  })

  it('tells you to log in when nobody has', async () => {
    const output: string[] = []
    const program = new Command()
    registerLoginCommands(program, { output: (line) => output.push(line), loadCredential: async () => null })
    await program.parseAsync(['node', 'orchestra', 'whoami'])
    expect(output.join('\n')).toContain('orchestra login')
  })
})
