const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface TerminalStatusOptions {
  write?: (text: string) => void
  isTty?: () => boolean
  intervalMs?: number
}

/**
 * A spinner that is the single owner of the terminal line while it runs.
 *
 * A spinner is only safe when nothing else writes to stdout behind its back — otherwise
 * the redraw lands in the middle of someone else's line and both are unreadable. So
 * everything printed during a spin goes through `log()`, which erases the spinner, writes
 * the line, and redraws underneath it. That is the whole reason this exists rather than a
 * bare setInterval.
 *
 * Outside a TTY — an agent, a script, CI, a piped log — there is no cursor to move and
 * escape codes would just be noise in a file, so every method degrades to a plain line.
 */
export class TerminalStatus {
  #write: (text: string) => void
  #isTty: () => boolean
  #intervalMs: number
  #timer: ReturnType<typeof setInterval> | undefined
  #label = ''
  #frame = 0
  #painted = false

  constructor(options: TerminalStatusOptions = {}) {
    this.#write = options.write ?? ((text) => process.stdout.write(text))
    this.#isTty = options.isTty ?? (() => Boolean(process.stdout.isTTY))
    this.#intervalMs = options.intervalMs ?? 80
  }

  start(label: string): void {
    this.#label = label
    if (!this.#isTty()) {
      this.#write(`  ${label}…\n`)
      return
    }
    if (this.#timer) return
    this.#paint()
    this.#timer = setInterval(() => { this.#frame += 1; this.#paint() }, this.#intervalMs)
    // Never hold the process open for a decoration.
    this.#timer.unref?.()
  }

  /** Change what the spinner says without interrupting it. */
  update(label: string): void {
    this.#label = label
    if (this.#isTty() && this.#timer) this.#paint()
  }

  /** Print a line without the spinner eating it or being eaten by it. */
  log(line: string): void {
    this.#erase()
    this.#write(`${line}\n`)
    if (this.#timer) this.#paint()
  }

  succeed(line: string): void { this.#finish(`  ✓ ${line}`) }
  fail(line: string): void { this.#finish(`  ✗ ${line}`) }

  /** Stop spinning and leave the line blank — for a spin that turned out to have no news. */
  stop(): void { this.#finish(null) }

  #finish(line: string | null): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined }
    this.#erase()
    if (line !== null) this.#write(`${line}\n`)
  }

  #paint(): void {
    if (!this.#isTty()) return
    this.#write(`\r  ${FRAMES[this.#frame % FRAMES.length]} ${this.#label}`)
    this.#painted = true
  }

  #erase(): void {
    if (!this.#isTty() || !this.#painted) return
    // Clear the whole line rather than returning the cursor: what replaces the spinner is
    // often shorter than it, and the tail would otherwise stay on screen.
    this.#write(`\r${' '.repeat(this.#label.length + 6)}\r`)
    this.#painted = false
  }
}

export interface OrgSyncSnapshot { joined: boolean; orgId: string | null; state: string; detail?: string | null }

/**
 * Spins while the daemon's sync loop is still deciding, then reports what it decided.
 *
 * The connect resolves asynchronously — after `serve()` has returned — so without this the
 * daemon's own success and failure lines arrive after the CLI has printed its last line,
 * which is exactly how a subscription refusal ended up buried under unrelated output.
 */
export async function awaitOrgSync(
  read: () => Promise<OrgSyncSnapshot | null>,
  options: { status?: TerminalStatus; timeoutMs?: number; pollMs?: number } = {},
): Promise<OrgSyncSnapshot | null> {
  const status = options.status ?? new TerminalStatus()
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)

  const first = await read().catch(() => null)
  if (!first || !first.joined) return first

  status.start(`org-sync · connecting to ${first.orgId}`)
  // Own stdout for the span of the spin. The daemon logs from this same process while the
  // loop settles, and a redraw landing mid-line makes both unreadable — routing those
  // lines through `log()` is what makes an animated CLI safe rather than a nice idea.
  const restore = console.log
  console.log = (...args: unknown[]) => status.log(args.map(String).join(' '))
  let latest = first
  try {
  while (Date.now() < deadline) {
    if (latest.state === 'live') {
      status.succeed(`org-sync live — ${latest.orgId}`)
      return latest
    }
    if (latest.state === 'auth-failed' || latest.state === 'terminal') {
      status.fail(`org-sync stopped — ${latest.detail ?? 'the hub refused this daemon'}`)
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250))
    latest = (await read().catch(() => null)) ?? latest
  }
  // Saying nothing is better than claiming either outcome: it may still be retrying.
  status.fail(`org-sync still connecting to ${latest.orgId} — check \`orchestra org status\``)
  return latest
  } finally {
    console.log = restore
  }
}
