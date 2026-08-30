import { describe, it, expect, vi } from 'vitest'
import { TerminalStatus, awaitOrgSync, type OrgSyncSnapshot } from '../src/terminal-status.js'

function recorder(isTty = true) {
  const chunks: string[] = []
  const status = new TerminalStatus({
    write: (text) => chunks.push(text),
    isTty: () => isTty,
    intervalMs: 5,
  })
  return { chunks, status, text: () => chunks.join('') }
}

const snapshot = (over: Partial<OrgSyncSnapshot> = {}): OrgSyncSnapshot =>
  ({ joined: true, orgId: 'org_a', state: 'connecting', detail: null, ...over })

describe('TerminalStatus', () => {
  it('animates while running and settles on one final line', async () => {
    const { status, text, chunks } = recorder()
    status.start('connecting')
    await new Promise((resolve) => setTimeout(resolve, 40))
    status.succeed('done')

    expect(chunks.some((c) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(c))).toBe(true)
    expect(text()).toContain('✓ done')
  })

  // The whole reason this class exists: a bare spinner interleaved with other writers
  // produces a line that is neither the spinner nor the message.
  it('keeps a logged line intact instead of letting the spinner land inside it', async () => {
    const { status, text } = recorder()
    status.start('connecting')
    status.log('orchestra on http://127.0.0.1:4750')
    status.fail('stopped')

    expect(text()).toContain('orchestra on http://127.0.0.1:4750\n')
    expect(text()).toContain('✗ stopped')
    // the message is on its own line, not spliced into a spinner frame
    expect(text()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] orchestra on/u)
  })

  // Agents, scripts, CI and piped logs get plain text — escape codes there are just noise.
  it('emits no escape codes when stdout is not a TTY', async () => {
    const { status, text } = recorder(false)
    status.start('connecting')
    status.log('a line')
    status.succeed('done')

    expect(text()).not.toContain('\r')
    expect(text()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u)
    expect(text()).toContain('connecting…')
    expect(text()).toContain('a line')
  })
})

describe('awaitOrgSync', () => {
  it('spins until the loop goes live, then says so', async () => {
    const { status, text } = recorder()
    const states = ['connecting', 'connecting', 'live']
    let call = 0
    const read = vi.fn(async () => snapshot({ state: states[Math.min(call++, states.length - 1)] }))

    const result = await awaitOrgSync(read, { status, pollMs: 1 })

    expect(result?.state).toBe('live')
    expect(read.mock.calls.length).toBeGreaterThan(1)
    expect(text()).toContain('✓ connected to Orchestra Cloud — org_a')
  })

  // The failure that started all of this: the reason has to reach the final line.
  it('reports the hub\'s reason on a terminal failure', async () => {
    const { status, text } = recorder()
    const read = vi.fn(async () => snapshot({
      state: 'auth-failed',
      detail: 'this org has no subscription — writes are disabled until one is started.',
    }))

    await awaitOrgSync(read, { status, pollMs: 1 })

    expect(text()).toContain('✗ org-sync stopped — this org has no subscription')
  })

  it('does not spin at all when no organization is joined', async () => {
    const { status, text } = recorder()
    const read = vi.fn(async () => snapshot({ joined: false, orgId: null, state: 'off' }))

    await awaitOrgSync(read, { status, pollMs: 1 })

    expect(text()).toBe('')
  })

  it('gives up without claiming either outcome', async () => {
    const { status, text } = recorder()
    const read = vi.fn(async () => snapshot({ state: 'connecting' }))

    await awaitOrgSync(read, { status, timeoutMs: 20, pollMs: 1 })

    expect(text()).toContain('still connecting')
    expect(text()).not.toContain('✓')
  })

  // An earlier attempt routed the daemon's lines by reassigning console.log. It silently
  // did nothing — daemon-integration captures its output function once at startup — and
  // the daemon's line landed spliced through the middle of a spinner frame. The sink is
  // passed in now, so this asserts the spinner never touches the global.
  it('never reassigns console.log', async () => {
    const { status } = recorder()
    const original = console.log
    const read = vi.fn(async () => snapshot({ state: 'live' }))

    await awaitOrgSync(read, { status, pollMs: 1 })

    expect(console.log).toBe(original)
  })
})
