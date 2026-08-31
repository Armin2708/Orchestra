/**
 * Pure frame rendering for the interactive session: state + viewport size in, an array
 * of terminal lines out. No IO and no ANSI arithmetic surprises — every string is
 * truncated as plain text FIRST and styled after, so styling can never break column
 * alignment. Kept pure (animation is just `tick` in state) so tests can assert frames
 * without a terminal.
 */

import { accent, bold, column as columnColor, dim, green, inverse, red, yellow } from '../style.js'
import { PET_IDLE, PET_JUMP, PET_PARTY, petFrame } from './pet.js'

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

export interface TuiLogLine {
  ts: string
  tag: string
  text: string
}

export interface TuiOrgStatus {
  joined: boolean
  orgName: string | null
  state: string
}

export type TuiTab = 'home' | 'board' | 'inbox' | 'logs'
/** Home-tab submode: the connect flow replaces the landing until it resolves. */
export type TuiMode = 'home' | 'connecting' | 'celebrate'

export interface TuiState {
  boardName: string
  agents: string[]
  org: TuiOrgStatus | null
  passwordSet: boolean
  tab: TuiTab
  mode: TuiMode
  tick: number
  cards: TuiCard[]
  questions: TuiQuestion[]
  logs: TuiLogLine[]
  logScroll: number
  selected: number
  scroll: number
  detail: TuiCard | null
  status: string
}

/** List rows (board/inbox/logs) occupy these 1-based terminal rows; clicks map back. */
export const listRegion = (rows: number) => ({ top: 4, height: Math.max(1, rows - 5) })

/** 1-based terminal row of the Home connect action, for click mapping. */
export const homeActionRow = (rows: number): number => listRegion(rows).top + homeActionOffset(listRegion(rows).height)

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

const center = (text: string, cols: number): number => Math.max(0, Math.floor((cols - text.length) / 2))

/** Place styled text at a column by padding with spaces first (styling never shifts it). */
const at = (col: number, styled: string): string => ' '.repeat(col) + styled

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

const TAB_LABELS: Array<{ tab: TuiTab; label: string }> = [
  { tab: 'home', label: 'Home' },
  { tab: 'board', label: 'Board' },
  { tab: 'logs', label: 'Logs' },
]

/** Which tab a click at 1-based column x on the tab row lands on. */
export function tabAt(x: number): TuiTab | null {
  // ` Home  Board  Logs ` — each label padded with a space either side, two between.
  let start = 2
  for (const { tab, label } of TAB_LABELS) {
    const end = start + label.length + 1
    if (x >= start && x <= end) return tab
    start = end + 2
  }
  return null
}

export function renderFrame(state: TuiState, rows: number, cols: number): string[] {
  const lines: string[] = []
  lines.push(headerLine(state, cols))
  lines.push(tabLine(state))
  lines.push(dim(' ' + '─'.repeat(Math.max(0, cols - 2))))

  const { height } = listRegion(rows)
  if (state.tab === 'home' && state.mode === 'connecting') lines.push(...renderHyper(state, height, cols))
  else if (state.tab === 'home' && state.mode === 'celebrate') lines.push(...renderCelebrate(state, height, cols))
  else if (state.tab === 'home') lines.push(...renderHome(state, height, cols))
  else if (state.detail) lines.push(...renderDetail(state.detail, height, cols))
  else if (state.tab === 'board') lines.push(...renderCards(state, height, cols))
  else if (state.tab === 'inbox') lines.push(...renderQuestions(state, height, cols))
  else lines.push(...renderLogs(state, height, cols))

  lines.push(state.status ? ` ${dim(truncate(state.status, cols - 2))}` : '')
  lines.push(` ${dim(footerFor(state))}`)
  return lines.map((line) => clip(line, cols))
}

function headerLine(state: TuiState, cols: number): string {
  const cloud = state.org?.state === 'live'
    ? `${green('●')} ${truncate(state.org.orgName ?? 'cloud', 20)}`
    : state.org?.state === 'paused' ? dim('○ local only')
      : state.org?.joined ? dim(`○ ${truncate(state.org.state, 16)}`) : dim('○ local')
  return ` ${bold('orchestra')} ${dim('·')} ${bold(truncate(state.boardName, Math.max(8, cols - 44)))} ${dim('·')} ${state.agents.length} agents ${dim('·')} ${cloud}`
}

function tabLine(state: TuiState): string {
  const pills = TAB_LABELS.map(({ tab, label }) =>
    state.tab === tab ? inverse(` ${label} `) : dim(` ${label} `))
  if (state.tab === 'inbox') pills.push(inverse(' Inbox '))
  return ` ${pills.join(' ')}`
}

function footerFor(state: TuiState): string {
  if (state.detail) return 'esc back · q quit'
  if (state.tab === 'home' && state.mode === 'connecting') return 'connecting… · esc cancel · q quit'
  if (state.tab === 'home' && state.org?.state === 'live') return 'tab switch · ⏎ open board · d disconnect · b board · l logs · q quit'
  if (state.tab === 'home') return 'tab switch · ⏎ connect · b board · l logs · q quit'
  if (state.tab === 'logs') return '↑↓ scroll · tab switch · q quit'
  if (state.tab === 'inbox') return '↑↓/jk move · tab switch · q quit'
  return '↑↓/jk move · enter open · click select · i inbox · tab switch · r refresh · q quit'
}

// ─── Home ────────────────────────────────────────────────────────────────────

// Row offsets inside the list region, so click mapping and rendering agree.
const homeActionOffset = (height: number): number => Math.min(height - 2, 13)

function renderHome(state: TuiState, height: number, cols: number): string[] {
  const rows: string[] = []
  const word = 'O R C H E S T R A'
  const tag = 'agents coordinating on a live board'
  rows.push('')
  rows.push(at(center(word, cols), bold(word)))
  rows.push(at(center(tag, cols), dim(tag)))
  rows.push('')
  for (const line of petFrame(PET_IDLE, state.tick).split('\n'))
    rows.push(at(center('( o.o )', cols), accent(line)))
  rows.push('')
  const pw = state.passwordSet ? '● password set' : '○ password not set'
  const cloudLive = state.org?.state === 'live'
  const cloudLine = cloudLive
    ? `● cloud connected — org ${state.org?.orgName ?? ''}`
    : state.org?.state === 'paused' ? '○ cloud paused — local only'
      : state.org?.joined ? `○ cloud ${state.org.state}` : '○ cloud not connected'
  const left = center(cloudLine, cols)
  rows.push(at(left, `${green('●')} daemon running`))
  rows.push(at(left, dim(pw)))
  rows.push(at(left, cloudLive ? green(cloudLine) : dim(cloudLine)))
  rows.push('')
  while (rows.length < homeActionOffset(height)) rows.push('')
  const action = cloudLive ? `⏎  open cloud board in browser`
    : state.org?.state === 'paused' ? `⏎  reconnect to cloud` : `⏎  connect to cloud`
  const framed = `[ ${action} ]`
  rows.push(at(center(framed, cols), accent(bold(framed))))
  return fill(rows.slice(0, height), height)
}

// ─── Hyperspace ──────────────────────────────────────────────────────────────

// Deterministic streak field: angle/phase per streak, radius driven by tick.
const STREAKS = Array.from({ length: 24 }, (_, i) => ({
  angle: (i / 24) * Math.PI * 2 + (i % 3) * 0.13,
  phase: (i * 7) % 23,
  speed: 1.1 + (i % 5) * 0.5,
}))

function renderHyper(state: TuiState, height: number, cols: number): string[] {
  const grid: string[][] = Array.from({ length: height }, () => Array(cols).fill(' '))
  const cy = Math.floor(height / 2) - 2
  const cx = Math.floor(cols / 2)
  const maxR = Math.max(cols, height)
  for (const s of STREAKS) {
    // Hyperspace reads as speed only if the rays accelerate outward: radius grows
    // quadratically from the center, and each ray drags a long tail behind it.
    const base = ((state.tick * s.speed * 2.2 + s.phase * 3) % maxR)
    const r = 6 + (base * base) / maxR
    for (let seg = 0; seg < 6; seg++) {
      const rr = r - seg * (2 + r / 18)
      if (rr < 6) continue
      const x = Math.round(cx + Math.cos(s.angle) * rr)
      const y = Math.round(cy + Math.sin(s.angle) * rr * 0.5) // terminal cells are tall
      if (x < 1 || x >= cols - 1 || y < 0 || y >= height) continue
      const glyph = rr < 14 ? '·' : Math.abs(Math.cos(s.angle)) > 0.7 ? '─' : Math.abs(Math.sin(s.angle)) > 0.7 ? '│' : Math.cos(s.angle) * Math.sin(s.angle) > 0 ? '╲' : '╱'
      grid[y][x] = glyph
    }
  }
  const rows = grid.map((r) => dim(r.join('')))
  // carve the center: pet + message drawn over the field
  const pet = petFrame(PET_JUMP, state.tick, 2).split('\n')
  const msg = '⟨ jumping to orchestra cloud ⟩'
  const sub = 'device handshake … org lookup … sync stream'
  const overlay = (row: number, text: string, paint: (s: string) => string) => {
    if (row >= 0 && row < height) rows[row] = at(center(text, cols), paint(text))
  }
  pet.forEach((line, i) => overlay(cy - 1 + i, line, accent))
  overlay(cy + 3, msg, bold)
  overlay(cy + 5, sub, dim)
  return fill(rows.slice(0, height), height)
}

// ─── Celebration ─────────────────────────────────────────────────────────────

function renderCelebrate(state: TuiState, height: number, cols: number): string[] {
  const rows: string[] = []
  const confetti = ['*      ✦   *', '   ·        ✧', ' ✦    *     ·']
  rows.push('')
  for (const c of confetti) rows.push(at(center(c, cols), accent(c)))
  for (const line of petFrame(PET_PARTY, state.tick, 2).split('\n'))
    rows.push(at(center('( ^o^ )', cols), green(line)))
  rows.push('')
  const head = '● cloud connected'
  rows.push(at(center(head, cols), green(bold(head))))
  const sub = `org ${state.org?.orgName ?? '—'} · this machine linked · sync live`
  rows.push(at(center(sub, cols), truncate(sub, cols - 2)))
  return fill(rows.slice(0, height), height)
}

// ─── Board / Inbox / Detail (v1 views) ───────────────────────────────────────

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

// ─── Logs ────────────────────────────────────────────────────────────────────

function renderLogs(state: TuiState, height: number, cols: number): string[] {
  if (state.logs.length === 0) return fill([` ${dim('no events yet — everything the session sees lands here')}`], height)
  const rows: string[] = []
  const start = Math.max(0, state.logs.length - height - state.logScroll)
  for (const entry of state.logs.slice(start, start + height)) {
    const bad = /failed|error|terminal|auth/i.test(entry.text)
    const warn = /reconnect|backoff|offline/i.test(entry.text)
    const text = truncate(entry.text, Math.max(10, cols - 24))
    rows.push(` ${dim(entry.ts)}  ${accent(pad(entry.tag, 9))}${bad ? red(text) : warn ? yellow(text) : text}`)
  }
  return fill(rows, height)
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

