import { describe, expect, it } from 'vitest'
import { decode } from '../src/tui/term.js'
import { listRegion, renderFrame, type TuiState } from '../src/tui/render.js'
import { clampSelection } from '../src/tui/app.js'

const state = (over: Partial<TuiState> = {}): TuiState => ({
  boardName: 'agentboard',
  agents: ['jade-newt', 'builder'],
  cloud: 'live',
  tab: 'board',
  cards: [
    { id: 325, column: 'review', title: 'CLI color + typography pass', owner: 'jade-newt', paths: ['src/cli.ts'] },
    { id: 301, column: 'backlog', title: 'Resolve boards from linked git worktrees', owner: null, paths: ['src/server.ts'] },
  ],
  questions: [{ id: 35, from: 'amber-raven', to: 'crimson-stoat', body: 'is the SSE stream path final?' }],
  selected: 0,
  scroll: 0,
  detail: null,
  status: '',
  ...over,
})

describe('tui renderFrame', () => {
  // Tests run without a TTY, so style helpers are no-ops and frames are plain text.
  it('renders header, tabs, cards, and footer within the viewport', () => {
    const lines = renderFrame(state(), 12, 80)
    expect(lines).toHaveLength(12)
    expect(lines[0]).toContain('orchestra')
    expect(lines[0]).toContain('agentboard')
    expect(lines[0]).toContain('2 agents')
    expect(lines[1]).toContain('Board')
    expect(lines[1]).toContain('Inbox')
    expect(lines[3]).toContain('#325')
    expect(lines[3]).toContain('❯')
    expect(lines[4]).toContain('#301')
    expect(lines[4]).toContain('(unowned)')
    expect(lines[11]).toContain('q quit')
  })

  it('never exceeds the viewport width for plain frames', () => {
    const lines = renderFrame(state(), 10, 40)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
  })

  it('renders the inbox tab and card detail', () => {
    const inbox = renderFrame(state({ tab: 'inbox' }), 12, 80)
    expect(inbox.join('\n')).toContain('Q#35')
    expect(inbox.join('\n')).toContain('amber-raven → crimson-stoat')

    const detail = renderFrame(state({ detail: state().cards[0] }), 12, 80)
    expect(detail.join('\n')).toContain('CLI color + typography pass')
    expect(detail.join('\n')).toContain('no description')
    expect(detail[11]).toContain('esc back')
  })

  it('scrolls the selection into view', () => {
    const s = state({ cards: Array.from({ length: 30 }, (_, i) => ({ id: i, column: 'backlog', title: `card ${i}`, owner: null, paths: [] })), selected: 29 })
    clampSelection(s, listRegion(12).height)
    expect(s.scroll).toBe(29 - listRegion(12).height + 1)
    const lines = renderFrame(s, 12, 80)
    expect(lines.join('\n')).toContain('card 29')
  })
})

describe('tui input decoding', () => {
  it('decodes arrows, enter, tab, quit, and ctrl-c', () => {
    expect(decode('\u001b[A')).toEqual([{ name: 'up', ctrl: false }])
    expect(decode('\u001b[B')).toEqual([{ name: 'down', ctrl: false }])
    expect(decode('\r')).toEqual([{ name: 'enter', ctrl: false }])
    expect(decode('\t')).toEqual([{ name: 'tab', ctrl: false }])
    expect(decode('q')).toEqual([{ name: 'q', ctrl: false }])
    expect(decode('\u0003')).toEqual([{ name: 'c', ctrl: true }])
  })

  it('decodes SGR mouse presses and ignores releases and other buttons', () => {
    expect(decode('\u001b[<0;12;5M')).toEqual([{ x: 12, y: 5 }])
    expect(decode('\u001b[<0;12;5m')).toEqual([])
    expect(decode('\u001b[<64;12;5M')).toEqual([]) // wheel
  })

  it('collapses unknown escape sequences instead of leaking characters', () => {
    expect(decode('\u001b[1;5C')).toEqual([]) // ctrl-right: swallowed whole
    expect(decode('\u001b')).toEqual([{ name: 'escape', ctrl: false }])
  })
})
