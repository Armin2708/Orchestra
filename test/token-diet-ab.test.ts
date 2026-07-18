// A/B harness for the token diet (card #38): replays one identical multi-turn agent
// scenario under verbose (ORCHESTRA_VERBOSE_RULES=1) and compact (unset) injection modes,
// measures every char orchestra injects per hook event, and proves the compliance gates
// (registration nudge, stale nudge, overlap surfacing, stop-block) fire identically.
// Token formula matches the telemetry endpoint (#34): tokens = ceil(chars / 4).
import { afterAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

type EventCount = { chars: number; tokens: number; count: number }
type Compliance = {
  rules_have_registration_directive: boolean
  registration_nudge_fired: boolean
  card_registered: boolean
  message_delivered: boolean
  overlap_surfaced: boolean
  stale_nudge_fired: boolean
  card_updated: boolean
  stop_block_fired: boolean
  stop_no_loop_on_active: boolean
  stop_silent_after_done: boolean
}
type ArmResult = { by_event: Record<string, EventCount>; total: EventCount; compliance: Compliance }

const tok = (chars: number) => Math.ceil(chars / 4)
const TEN_MIN_AGO = () => new Date(Date.now() - 11 * 60_000)

const cleanups: (() => Promise<void> | void)[] = []
afterAll(async () => { for (const fn of cleanups.reverse()) await fn() })

async function runScenario(mode: 'verbose' | 'compact'): Promise<ArmResult> {
  if (mode === 'verbose') process.env.ORCHESTRA_VERBOSE_RULES = '1'
  else delete process.env.ORCHESTRA_VERBOSE_RULES

  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ab-${mode}-`))
  process.env.ORCHESTRA_HOME = home
  const db = openDb(':memory:')
  const server = buildServer(db)
  await server.listen({ host: '127.0.0.1', port: 0 })
  const port = (server.server.address() as any).port
  process.env.ORCHESTRA_PORT = String(port)
  cleanups.push(async () => { await server.close() })

  const http = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    expect(res.ok).toBe(true)
    return res.json() as Promise<any>
  }

  const hooks = await import('../src/hooks.js')
  const out: string[] = []
  const logSpy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => { out.push(String(s)) })
  cleanups.push(() => logSpy.mockRestore())
  const sid = `ab-${mode}-main`
  const stdin = vi.spyOn(hooks._internals, 'readStdin')
  const run = async (event: string, input: Record<string, unknown> = {}) => {
    stdin.mockResolvedValue(JSON.stringify({ session_id: sid, cwd: '/tmp', ...input }))
    out.length = 0
    await hooks.runHook(event)
    return out.join('\n')
  }
  // injected text is what lands in the agent's context: raw stdout for session-start,
  // additionalContext for deliveries, block reason for stop
  const injected = (raw: string): string => {
    if (!raw) return ''
    try {
      const p = JSON.parse(raw)
      return p.hookSpecificOutput?.additionalContext ?? p.reason ?? raw
    } catch { return raw }
  }
  const by_event: Record<string, EventCount> = {}
  const record = (event: string, text: string) => {
    const e = (by_event[event] ??= { chars: 0, tokens: 0, count: 0 })
    if (!text) return
    e.chars += text.length; e.tokens = tok(e.chars); e.count += 1
  }
  const sess = () => path.join(home, 'sessions', `${sid}.json`)
  const backdate = (suffix: string) => {
    const f = sess() + suffix
    if (fs.existsSync(f)) fs.utimesSync(f, TEN_MIN_AGO(), TEN_MIN_AGO())
  }

  // 0. seed a representative board (agents, cards, an open question) so the
  // session-start dump reflects a mid-project board, not an empty one
  const board = await http('POST', '/boards/resolve', { project_path: '/tmp' })
  // fixed names everywhere — random name lengths would skew the char counts between arms
  const seedAgents = await Promise.all(['seed-alpha', 'seed-bravo', 'seed-charlie'].map((name, i) =>
    http('POST', '/agents/register', { board_id: board.id, session_id: `ab-${mode}-seed-${i}`, name })))
  process.env.ORCHESTRA_NAME = 'ab-runner'
  cleanups.push(() => { delete process.env.ORCHESTRA_NAME })
  const SEED_CARDS: [string, string, string[], string][] = [
    ['Daemon token auth', 'bearer auth on API and SSE routes', ['src/server.ts', 'src/token.ts'], 'done'],
    ['Mobile PWA shell', 'manifest, icons, service worker with SSE bypass', ['web/src/push.ts'], 'done'],
    ['Review gates', 'request-events, launch gate, approve/send-back', ['src/review.ts'], 'in_progress'],
    ['Push notifications', 'web-push subscription and delivery', ['src/push.ts'], 'in_progress'],
    ['Launch agents from cards', 'POST /cards/:id/launch plus conductor queue', ['src/conductor.ts'], 'review'],
    ['Record the demo GIF', 'terminal capture for the README', [], 'backlog'],
    ['Publish to npm', 'package metadata, provenance, dist check', ['package.json'], 'backlog'],
    ['Show HN launch post', 'draft and timing', ['docs/launch-checklist.md'], 'backlog'],
    // board sized to match the live agentboard board at measurement time (11 active cards)
    ['Web terminal slash commands', 'autocomplete menu over SDK slash_commands', ['web/src/AgentTerminal.tsx'], 'backlog'],
    ['Per-chat model selector', 'model and effort controls for hired agents', ['web/src/CardDrawer.tsx'], 'backlog'],
    ['Permission-mode toggle', 'expose setPermissionMode for hired agents', ['src/conductor.ts'], 'backlog'],
    ['Feature brainstorm session', 'triage ideas into tickets', [], 'in_progress'],
    ['Plugin marketplace listing', 'metadata and screenshots', ['docs/launch-checklist.md'], 'backlog'],
  ]
  for (let i = 0; i < SEED_CARDS.length; i++) {
    const [title, description, paths, column] = SEED_CARDS[i]
    await http('POST', '/cards', {
      board_id: board.id, title, description, paths, column,
      agent: seedAgents[i % seedAgents.length].name,
    })
  }
  await http('POST', '/messages', {
    board_id: board.id, to: seedAgents[0].name, body: 'is the SSE stream path final?',
  })

  // 1. session starts: rules + board dump injected
  const start = injected(await run('session-start'))
  record('session_start', start)
  const me = JSON.parse(fs.readFileSync(sess(), 'utf8'))

  // 2. first turn begins with no card: registration reminder expected
  const nudge = injected(await run('user-prompt-submit'))
  record('user_prompt_submit', nudge)
  const registration_nudge_fired = /card create/.test(nudge)

  // 3. scripted agent complies: registers its card
  const created = await http('POST', '/cards', {
    board_id: me.board_id, title: 'AB replay: implement widget parser',
    description: 'parse widget config and emit tokens', paths: ['src/widget.ts'],
    column: 'in_progress', agent: me.agent_name,
  })
  const cardId = created.card.id

  // 4. a human message arrives mid-work and is delivered on the next tool use
  await http('POST', '/messages', { board_id: me.board_id, to: me.agent_name, body: 'status check: how far along?' })
  backdate('.throttle')
  const delivery = injected(await run('post-tool-use'))
  record('post_tool_use', delivery)
  const message_delivered = delivery.includes('status check: how far along?')

  // 5. a second agent claims overlapping paths: overlap must surface at creation
  const other = await http('POST', '/agents/register', { board_id: me.board_id, session_id: `ab-${mode}-other`, name: 'ab-rival' })
  const overlapping = await http('POST', '/cards', {
    board_id: me.board_id, title: 'AB replay: widget parser rework', paths: ['src/widget.ts'],
    column: 'in_progress', agent: other.name,
  })
  const overlap_surfaced = overlapping.overlaps.some((o: any) => o.id === cardId)

  // 6. the card goes stale (>10min): stale reminder expected on next pulse
  db.prepare(`UPDATE cards SET updated_at = datetime('now', '-11 minutes') WHERE id = ?`).run(cardId)
  backdate('.throttle'); backdate('.stale')
  const stale = injected(await run('post-tool-use'))
  record('post_tool_use', stale)
  const stale_nudge_fired = stale.includes(`#${cardId}`)

  // 7. scripted agent complies: updates the card
  await http('PATCH', `/cards/${cardId}`, { description: 'parser done, writing tests', agent: me.agent_name })

  // 7b. three ordinary turn-ends while the card is fresh — a compliant agent mid-task.
  // Pre-diet code blocked every one of these; the diet makes them silent, so this is
  // where multi-turn sessions actually save. Tokens recorded either way.
  for (let turn = 0; turn < 3; turn++) {
    db.prepare(`UPDATE cards SET updated_at = datetime('now') WHERE id = ?`).run(cardId)
    record('stop', injected(await run('stop')))
    await run('stop', { stop_hook_active: true }) // harness turn continuation, never counted twice
  }

  // 8. turn ends with the card stale and in_progress: stop must block once
  db.prepare(`UPDATE cards SET updated_at = datetime('now', '-11 minutes') WHERE id = ?`).run(cardId)
  const stopRaw = await run('stop')
  record('stop', injected(stopRaw))
  const stop_block_fired = stopRaw.includes('"block"') && stopRaw.includes(`#${cardId}`)

  // 9. the continuation turn must never re-block (loop guard)
  const stop_no_loop_on_active = (await run('stop', { stop_hook_active: true })) === ''

  // 10. card moved to done: stop goes silent
  await http('POST', `/cards/${cardId}/move`, { column: 'done', agent: me.agent_name })
  const stop_silent_after_done = (await run('stop')) === ''

  await run('session-end')
  logSpy.mockRestore(); stdin.mockRestore()

  const totalChars = Object.values(by_event).reduce((n, e) => n + e.chars, 0)
  return {
    by_event,
    total: { chars: totalChars, tokens: tok(totalChars), count: Object.values(by_event).reduce((n, e) => n + e.count, 0) },
    compliance: {
      rules_have_registration_directive: /card create/.test(start) && start.includes('--agent'),
      registration_nudge_fired,
      card_registered: created.card.column === 'in_progress' && created.card.owner === me.agent_name,
      message_delivered,
      overlap_surfaced,
      stale_nudge_fired,
      card_updated: true,
      stop_block_fired,
      stop_no_loop_on_active,
      stop_silent_after_done,
    },
  }
}

it('identical scenario: compact mode injects fewer tokens with compliance gates unchanged', async () => {
  const verbose = await runScenario('verbose')
  const compact = await runScenario('compact')

  // every compliance gate must hold in BOTH arms, and identically
  for (const [k, v] of Object.entries(verbose.compliance)) expect(v, `verbose ${k}`).toBe(true)
  expect(compact.compliance).toEqual(verbose.compliance)

  // the diet may only shrink injections, never grow them
  expect(compact.total.chars).toBeLessThanOrEqual(verbose.total.chars)

  const report = {
    generated_by: 'test/token-diet-ab.test.ts',
    scenario: 'session-start → no-card nudge → register → message delivery → overlap create → stale nudge → update → stop-block → loop-guard → done → session-end',
    verbose, compact,
    reduction_pct: verbose.total.chars === 0 ? 0
      : Math.round((1 - compact.total.chars / verbose.total.chars) * 1000) / 10,
    modes_differ: compact.total.chars !== verbose.total.chars,
  }
  if (process.env.AB_REPORT) fs.writeFileSync(process.env.AB_REPORT, JSON.stringify(report, null, 2))
  // eslint-disable-next-line no-console
  console.info(`[token-diet A/B] verbose=${verbose.total.tokens}tok compact=${compact.total.tokens}tok reduction=${report.reduction_pct}% (modes_differ=${report.modes_differ})`)
})
