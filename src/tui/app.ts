/**
 * The interactive session behind bare `orchestra` at a TTY. Opens on a calm Home
 * landing (wordmark, pet, status) instead of a board dump; the board list, inbox, and
 * an event log live behind tabs. Board data stays read-only — every mutation belongs
 * to the subcommands and the web UI, so the TUI can never race an agent's writes.
 */

import { Term, type Click, type Key } from './term.js'
import {
  homeActionRow,
  listRegion,
  renderFrame,
  tabAt,
  type TuiOrgStatus,
  type TuiState,
} from './render.js'

export interface RunTuiOptions {
  api: (method: string, path: string) => Promise<any>
  boardId: number
  passwordSet?: boolean
  /** Runs the browser sign-in + org join with the terminal released; resolves when the
   * credential is in place (the TUI then animates until the sync stream reports live). */
  signIn?: (say: (line: string) => void) => Promise<void>
  /** Opens the hosted cloud board in the browser — the Home action once sync is live. */
  openCloudBoard?: () => void
  /** Fetch daemon org-sync status; defaults to GET /org through `api`. */
  orgStatus?: () => Promise<TuiOrgStatus | null>
  refreshMs?: number
  tickMs?: number
}

const LOG_CAP = 500
const CONNECT_TIMEOUT_TICKS = 400 // × tickMs ≈ 60s at the default cadence

export async function runTui(options: RunTuiOptions): Promise<void> {
  const term = new Term()
  const state: TuiState = {
    boardName: '', agents: [], org: null, passwordSet: options.passwordSet ?? false,
    tab: 'home', mode: 'home', tick: 0,
    cards: [], questions: [], logs: [], logScroll: 0,
    selected: 0, scroll: 0, detail: null, status: 'loading…',
  }
  const orgStatus = options.orgStatus ?? (async () => {
    try { return await options.api('GET', '/org') } catch { return null }
  })

  const now = () => new Date().toTimeString().slice(0, 8)
  const log = (tag: string, text: string) => {
    state.logs.push({ ts: now(), tag, text })
    if (state.logs.length > LOG_CAP) state.logs.splice(0, state.logs.length - LOG_CAP)
  }

  const items = () => (state.tab === 'board' ? state.cards : state.questions)

  const render = () => {
    const { rows, cols } = term.size()
    clampSelection(state, listRegion(rows).height)
    term.draw(renderFrame(state, rows, cols))
  }

  // Board deltas feed the log so "what just happened" survives leaving the Board tab.
  let known = new Map<number, string>()
  const refresh = async () => {
    try {
      const snap = await options.api('GET', `/boards/${options.boardId}/snapshot`)
      state.boardName = snap.board.name
      state.agents = snap.agents.filter((a: any) => a.status !== 'gone').map((a: any) => a.name)
      state.cards = snap.cards
        .filter((c: any) => c.column !== 'done')
        .map((c: any) => ({ id: c.id, column: c.column, title: c.title, owner: c.owner ?? null, paths: c.paths ?? [], description: c.description ?? null }))
      state.questions = snap.open_questions
        .map((q: any) => ({ id: q.id, from: q.from_name ?? 'human', to: q.to_name ?? 'all', body: q.body }))
      const seen = new Map<number, string>(state.cards.map((c) => [c.id, c.column]))
      if (known.size) {
        for (const [id, column] of seen) {
          const before = known.get(id)
          if (before === undefined) log('board', `card #${id} created [${column}]`)
          else if (before !== column) log('board', `card #${id} → ${column}`)
        }
      }
      known = seen
      state.status = ''
    } catch (error) {
      state.status = `refresh failed: ${error instanceof Error ? error.message : String(error)}`
      log('board', state.status)
    }
    const org = await orgStatus()
    if (org && org.state !== state.org?.state) log('org-sync', `sync ${org.state}${org.orgName ? ` (${org.orgName})` : ''}`)
    state.org = org
    if (state.detail) state.detail = state.cards.find((c) => c.id === state.detail!.id) ?? state.detail
    render()
  }

  return new Promise<void>((resolve) => {
    let refreshTimer: ReturnType<typeof setInterval>
    let tickTimer: ReturnType<typeof setInterval>
    let connecting = false
    const quit = () => { clearInterval(refreshTimer); clearInterval(tickTimer); term.close(); resolve() }

    // The connect flow: (optionally) release the terminal for the browser sign-in,
    // then hyperspace until the daemon's sync stream reports live.
    // Enter/click on the Home action: connect when disconnected, open the cloud board
    // in the browser when live — matching whichever label the landing shows.
    const homeAction = () => {
      if (state.org?.state === 'live') {
        if (options.openCloudBoard) {
          options.openCloudBoard()
          state.status = 'opening the cloud board in your browser…'
          log('daemon', 'opened the cloud board in the browser')
        }
        return render()
      }
      void connect()
    }

    const connect = async () => {
      if (connecting || state.org?.state === 'live') return
      connecting = true
      state.tab = 'home'
      try {
        const before = await orgStatus()
        if (!before?.joined && options.signIn) {
          term.close()
          process.stdout.write('\nopening the browser to sign in — come back when it says done\n\n')
          try {
            await options.signIn((line) => process.stdout.write(`  ${line}\n`))
          } catch (error) {
            log('org-sync', `sign-in failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          term.open(handlers)
        }
        state.mode = 'connecting'
        log('org-sync', 'connecting to orchestra cloud')
        // A joined-but-not-live loop may be parked terminal after a non-retryable hub
        // failure; the daemon relaunches it on this kick (older daemons 404 — ignore).
        if (before?.joined && before.state !== 'live') {
          try { await options.api('POST', '/org/reconnect') } catch { /* older daemon */ }
        }
        const started = state.tick
        while (state.tick - started < CONNECT_TIMEOUT_TICKS && state.mode === 'connecting') {
          const org = await orgStatus()
          state.org = org
          if (org?.state === 'live') {
            log('org-sync', `sync live${org.orgName ? ` (${org.orgName})` : ''}`)
            state.mode = 'celebrate'
            setTimeout(() => { if (state.mode === 'celebrate') { state.mode = 'home'; render() } }, 2_500)
            render()
            return
          }
          if (org && !org.joined) break
          await sleep(500)
        }
        if (state.mode === 'connecting') {
          state.mode = 'home'
          state.status = state.org?.joined
            ? `cloud not live yet — sync ${state.org.state}; check the Logs tab`
            : 'not connected — sign-in did not complete; run `orchestra login` or press ⏎ to retry'
          log('org-sync', state.status)
        }
        render()
      } finally {
        connecting = false
      }
    }

    const onKey = (key: Key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) return quit()
      if (state.mode === 'connecting' && key.name === 'escape') { state.mode = 'home'; return render() }
      if (state.detail) {
        if (key.name === 'escape' || key.name === 'b' || key.name === 'enter') state.detail = null
        return render()
      }
      const order: Array<TuiState['tab']> = ['home', 'board', 'logs']
      if (key.name === 'tab') state.tab = order[(order.indexOf(state.tab === 'inbox' ? 'board' : state.tab) + 1) % order.length]
      else if (key.name === '1') state.tab = 'home'
      else if (key.name === '2' || key.name === 'b') state.tab = 'board'
      else if (key.name === '3' || key.name === 'l') state.tab = 'logs'
      else if (key.name === 'i' && state.tab === 'board') { state.tab = 'inbox'; state.selected = 0; state.scroll = 0 }
      else if (key.name === 'enter' && state.tab === 'home') { homeAction(); return }
      else if (key.name === 'd' && state.tab === 'home' && state.org?.state === 'live') {
        void (async () => {
          try {
            state.org = await options.api('POST', '/org/pause')
            log('org-sync', 'paused — local only (⏎ to reconnect)')
            state.status = 'cloud paused — local only'
          } catch (error) {
            state.status = `pause failed: ${error instanceof Error ? error.message : String(error)}`
          }
          render()
        })()
        return
      }
      else if (key.name === 'enter' && state.tab === 'board' && state.cards.length) state.detail = state.cards[state.selected] ?? null
      else if (key.name === 'up' || key.name === 'k') state.tab === 'logs' ? (state.logScroll += 1) : (state.selected -= 1)
      else if (key.name === 'down' || key.name === 'j') state.tab === 'logs' ? (state.logScroll = Math.max(0, state.logScroll - 1)) : (state.selected += 1)
      else if (key.name === 'r') { state.status = 'refreshing…'; render(); void refresh(); return }
      render()
    }

    const onClick = (click: Click) => {
      if (state.detail) { state.detail = null; return render() }
      const { rows } = term.size()
      if (click.y === 2) {
        const tab = tabAt(click.x)
        if (tab) { state.tab = tab; state.selected = 0; state.scroll = 0; state.mode = state.mode === 'celebrate' ? 'home' : state.mode }
        return render()
      }
      if (state.tab === 'home') {
        if (click.y === homeActionRow(rows) && state.mode === 'home') homeAction()
        return
      }
      const { top, height } = listRegion(rows)
      if (click.y < top || click.y >= top + height) return
      const index = state.scroll + (click.y - top)
      if (index >= items().length) return
      if (index === state.selected && state.tab === 'board') state.detail = state.cards[index] ?? null
      else state.selected = index
      render()
    }

    const handlers = { onKey, onClick, onResize: render }
    term.open(handlers)
    render()
    log('daemon', `session opened — board #${options.boardId}`)
    void refresh()
    refreshTimer = setInterval(() => { void refresh() }, options.refreshMs ?? 3_000)
    refreshTimer.unref?.()
    // One animation clock: the pet idles slowly, hyperspace runs off the same tick.
    tickTimer = setInterval(() => {
      state.tick += 1
      if (state.tab === 'home') render() // only the animated tab repaints on ticks
    }, options.tickMs ?? 60)
    tickTimer.unref?.()
  })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Keep the cursor inside the list and the list scrolled around the cursor. */
export function clampSelection(state: TuiState, height: number): void {
  const total = state.tab === 'board' ? state.cards.length : state.tab === 'inbox' ? state.questions.length : 0
  state.selected = Math.max(0, Math.min(state.selected, Math.max(0, total - 1)))
  if (state.selected < state.scroll) state.scroll = state.selected
  if (state.selected >= state.scroll + height) state.scroll = state.selected - height + 1
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, total - height)))
  state.logScroll = Math.max(0, Math.min(state.logScroll, Math.max(0, state.logs.length - height)))
}
