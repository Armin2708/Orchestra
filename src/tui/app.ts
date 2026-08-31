/**
 * The interactive session behind bare `orchestra` at a TTY: a full-screen live board
 * in the alternate screen buffer. Reads only — every mutation stays with the existing
 * subcommands and the web UI, so the TUI can never race an agent's board writes.
 */

import { Term, type Click, type Key } from './term.js'
import { listRegion, renderFrame, type TuiState } from './render.js'

export interface RunTuiOptions {
  api: (method: string, path: string) => Promise<any>
  boardId: number
  /** Poll cadence for live refresh. */
  refreshMs?: number
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  const term = new Term()
  const state: TuiState = {
    boardName: '', agents: [], cloud: null,
    tab: 'board', cards: [], questions: [],
    selected: 0, scroll: 0, detail: null, status: 'loading…',
  }

  const items = () => (state.tab === 'board' ? state.cards : state.questions)

  const render = () => {
    const { rows, cols } = term.size()
    clampSelection(state, listRegion(rows).height)
    term.draw(renderFrame(state, rows, cols))
  }

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
      state.status = ''
    } catch (error) {
      state.status = `refresh failed: ${error instanceof Error ? error.message : String(error)}`
    }
    // A refreshed list may have shrunk under the cursor; keep the open detail current too.
    if (state.detail) state.detail = state.cards.find((c) => c.id === state.detail!.id) ?? state.detail
    render()
  }

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setInterval>
    const quit = () => { clearInterval(timer); term.close(); resolve() }

    const onKey = (key: Key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) return quit()
      if (state.detail) {
        if (key.name === 'escape' || key.name === 'b' || key.name === 'enter') state.detail = null
        return render()
      }
      if (key.name === 'up' || key.name === 'k') state.selected -= 1
      else if (key.name === 'down' || key.name === 'j') state.selected += 1
      else if (key.name === 'enter' && state.tab === 'board' && state.cards.length) state.detail = state.cards[state.selected] ?? null
      else if (key.name === 'tab' || key.name === '1' || key.name === '2') {
        state.tab = key.name === '1' ? 'board' : key.name === '2' ? 'inbox' : state.tab === 'board' ? 'inbox' : 'board'
        state.selected = 0; state.scroll = 0
      } else if (key.name === 'r') { state.status = 'refreshing…'; render(); void refresh(); return }
      render()
    }

    const onClick = (click: Click) => {
      if (state.detail) { state.detail = null; return render() }
      const { top, height } = listRegion(term.size().rows)
      if (click.y === 2) { // tab bar: Board is the first 8 columns, Inbox after it
        state.tab = click.x <= 8 ? 'board' : 'inbox'
        state.selected = 0; state.scroll = 0
        return render()
      }
      if (click.y < top || click.y >= top + height) return
      const index = state.scroll + (click.y - top)
      if (index >= items().length) return
      // First click selects; a click on the already-selected card opens it.
      if (index === state.selected && state.tab === 'board') state.detail = state.cards[index] ?? null
      else state.selected = index
      render()
    }

    term.open({ onKey, onClick, onResize: render })
    render()
    void refresh()
    timer = setInterval(() => { void refresh() }, options.refreshMs ?? 3_000)
    timer.unref?.()
  })
}

/** Keep the cursor inside the list and the list scrolled around the cursor. */
export function clampSelection(state: TuiState, height: number): void {
  const count = (state.tab === 'board' ? state.cards : state.questions).length
  state.selected = Math.max(0, Math.min(state.selected, count - 1))
  if (state.selected < state.scroll) state.scroll = state.selected
  if (state.selected >= state.scroll + height) state.scroll = state.selected - height + 1
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, count - height)))
}
