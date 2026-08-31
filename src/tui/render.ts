/**
 * Pure frame rendering for the interactive session: state + viewport size in, an array
 * of terminal lines out. No IO and no ANSI arithmetic surprises — every string is
 * truncated as plain text FIRST and styled after, so styling can never break column
 * alignment. Kept pure so tests can assert frames without a terminal.
 */

import { accent, bold, column as columnColor, dim, green, inverse } from '../style.js'

export interface TuiCard {
  id: number
  column: string
  title: string
  owner: string | null
  paths: string[]
  description?: string | null
}

export interface TuiQuestion {
  id: number
  from: string
  to: string
  body: string
}

export interface TuiState {
  boardName: string
  agents: string[]
  cloud: string | null
  tab: 'board' | 'inbox'
  cards: TuiCard[]
  questions: TuiQuestion[]
  selected: number
  scroll: number
  detail: TuiCard | null
  status: string
}

/** The list occupies these 1-based terminal rows; clicks map back through this. */
export const listRegion = (rows: number) => ({ top: 4, height: Math.max(1, rows - 5) })

// Board text is written by agents and other org members — untrusted for terminal
// purposes. Strip every C0/C1 control (ESC included, newline aside) at the render
// boundary so a hostile card title cannot inject escape sequences into the operator's
// terminal (screen rewriting, title spoofing, clipboard writes on some emulators).
const scrub = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

const truncate = (text: string, width: number): string => {
  if (width <= 0) return ''
  const flat = scrub(text).replace(/\s+/g, ' ')
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`
}

const pad = (text: string, width: number): string => truncate(text, width).padEnd(width)

const ANSI = /\u001b\[[0-9;]*m/y

/** Hard-clip a possibly-styled line to the viewport width, counting only visible
 * characters. A clipped styled line gets a reset so no style bleeds past the cut. */
export function clip(line: string, cols: number): string {
  let visible = 0
  let styled = false
  for (let i = 0; i < line.length;) {
    ANSI.lastIndex = i
    const m = ANSI.exec(line)
    if (m) { styled = true; i += m[0].length; continue }
    if (visible === cols) return line.slice(0, i) + (styled ? '\u001b[0m' : '')
    visible += 1
    i += 1
  }
  return line
}

export function renderFrame(state: TuiState, rows: number, cols: number): string[] {
  const lines: string[] = []
  const cloud = state.cloud === 'live' ? `${green('●')} cloud` : state.cloud ? dim(`○ ${truncate(state.cloud, 16)}`) : dim('○ local')
  lines.push(` ${bold('orchestra')} ${dim('·')} ${bold(truncate(state.boardName, Math.max(8, cols - 40)))} ${dim('·')} ${state.agents.length} agents ${dim('·')} ${cloud}`)

  const tab = (name: 'board' | 'inbox', label: string) =>
    state.tab === name ? inverse(` ${label} `) : dim(` ${label} `)
  lines.push(` ${tab('board', 'Board')}${tab('inbox', 'Inbox')}`)
  lines.push(dim(' ' + '─'.repeat(Math.max(0, cols - 2))))

  const { height } = listRegion(rows)
  if (state.detail) lines.push(...renderDetail(state.detail, height, cols))
  else if (state.tab === 'board') lines.push(...renderCards(state, height, cols))
  else lines.push(...renderQuestions(state, height, cols))

  lines.push(state.status ? ` ${dim(truncate(state.status, cols - 2))}` : '')
  lines.push(state.detail
    ? ` ${dim('esc back · q quit')}`
    : ` ${dim('↑↓/jk move · enter open · click select · tab switch · r refresh · q quit')}`)
  return lines.map((line) => clip(line, cols))
}

function renderCards(state: TuiState, height: number, cols: number): string[] {
  if (state.cards.length === 0) return fill([` ${dim('no open cards')}`], height)
  const rows: string[] = []
  for (let i = state.scroll; i < Math.min(state.cards.length, state.scroll + height); i++) {
    const c = state.cards[i]
    const active = i === state.selected
    const id = pad(`#${c.id}`, 6)
    const col = pad(c.column, 12)
    const owner = truncate(c.owner ?? 'unowned', 24)
    const title = truncate(c.title, Math.max(10, cols - 6 - 12 - owner.length - 8))
    const marker = active ? accent('❯ ') : '  '
    rows.push(` ${marker}${accent(id)}${columnColor(col)}${active ? bold(title) : title} ${dim(`(${owner})`)}`)
  }
  return fill(rows, height)
}

function renderQuestions(state: TuiState, height: number, cols: number): string[] {
  if (state.questions.length === 0) return fill([` ${dim('inbox empty')}`], height)
  const rows: string[] = []
  for (let i = state.scroll; i < Math.min(state.questions.length, state.scroll + height); i++) {
    const q = state.questions[i]
    const active = i === state.selected
    const marker = active ? accent('❯ ') : '  '
    const head = `${q.from} → ${q.to}`
    const body = truncate(q.body, Math.max(10, cols - head.length - 14))
    rows.push(` ${marker}${accent(pad(`Q#${q.id}`, 7))}${bold(pad(head, Math.min(34, head.length + 1)))}${active ? body : dim(body)}`)
  }
  return fill(rows, height)
}

function renderDetail(card: TuiCard, height: number, cols: number): string[] {
  const width = Math.max(20, cols - 4)
  const rows: string[] = [
    ` ${accent(`#${card.id}`)} ${bold(truncate(card.title, width - 8))}`,
    ` ${dim('column')} ${columnColor(truncate(card.column, 16))}   ${dim('owner')} ${truncate(card.owner ?? 'unowned', 24)}`,
    ` ${dim('paths')} ${truncate(card.paths.join(', ') || '-', width - 8)}`,
    '',
  ]
  for (const line of wrapText(card.description?.trim() || 'no description', width))
    rows.push(` ${line}`)
  return fill(rows.slice(0, height), height)
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of scrub(text.replace(/\r\n?/g, '\n')).split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (line && line.length + word.length + 1 > width) { out.push(line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    out.push(line)
  }
  return out
}

const fill = (rows: string[], height: number): string[] => {
  while (rows.length < height) rows.push('')
  return rows
}
