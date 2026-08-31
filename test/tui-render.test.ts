import { describe, expect, it } from 'vitest'
import { decode } from '../src/tui/term.js'
import { homeActionRow, listRegion, renderFrame, tabAt, type TuiState } from '../src/tui/render.js'
import { clampSelection } from '../src/tui/app.js'
import { PET_IDLE, petFrame } from '../src/tui/pet.js'

const state = (over: Partial<TuiState> = {}): TuiState => ({
  boardName: 'agentboard',
  agents: ['jade-newt', 'builder'],
  org: { joined: true, orgName: 'gatewayz', state: 'live' },
  passwordSet: false,
  tab: 'home',
  mode: 'home',
  tick: 0,
  cards: [
    { id: 325, column: 'review', title: 'CLI color + typography pass', owner: 'jade-newt', paths: ['src/cli.ts'] },
    { id: 301, column: 'backlog', title: 'Resolve boards from linked git worktrees', owner: null, paths: ['src/server.ts'] },
  ],
  questions: [{ id: 35, from: 'amber-raven', to: 'crimson-stoat', body: 'is the SSE stream path final?' }],
  logs: [],
  logScroll: 0,
  selected: 0,
  scroll: 0,
  detail: null,
  status: '',
  ...over,
})

// Tests run without a TTY, so style helpers are no-ops and frames are plain text.
describe('tui home landing', () => {
  it('renders wordmark, pet, status, and connect action — no board dump', () => {
    const lines = renderFrame(state({ org: { joined: false, orgName: null, state: 'off' } }), 24, 80)
    const frame = lines.join('\n')
    expect(lines).toHaveLength(24)
    expect(frame).toContain('O R C H E S T R A')
    expect(frame).toContain('( o.o )')
    expect(frame).toContain('● daemon running')
    expect(frame).toContain('○ cloud not connected')
    expect(frame).toContain('[ ⏎  connect to cloud ]')
    expect(frame).not.toContain('#325') // cards stay behind the Board tab
    expect(lines[1]).toContain('Home')
    expect(lines[1]).toContain('Board')
    expect(lines[1]).toContain('Logs')
  })

  it('shows the connected state when sync is live', () => {
    const frame = renderFrame(state(), 24, 80).join('\n')
    expect(frame).toContain('● cloud connected — org gatewayz')
    expect(frame).toContain('open cloud board')
  })

  it('animates the pet by tick', () => {
    expect(petFrame(PET_IDLE, 0)).not.toEqual(petFrame(PET_IDLE, 8))
    const a = renderFrame(state(), 24, 80).join('\n')
    const b = renderFrame(state({ tick: 8 }), 24, 80).join('\n')
    expect(a).not.toEqual(b)
  })

  it('maps clicks: tab bar hit zones and the connect action row', () => {
    expect(tabAt(3)).toBe('home')
    expect(tabAt(10)).toBe('board')
    expect(tabAt(17)).toBe('logs')
    expect(tabAt(60)).toBeNull()
    expect(homeActionRow(24)).toBeGreaterThan(listRegion(24).top)
    expect(homeActionRow(24)).toBeLessThan(24)
  })
})

describe('tui hyperspace + celebrate', () => {
  it('renders the jump message and moving streaks while connecting', () => {
    const t1 = renderFrame(state({ mode: 'connecting', tick: 10 }), 24, 80).join('\n')
    const t2 = renderFrame(state({ mode: 'connecting', tick: 30 }), 24, 80).join('\n')
    expect(t1).toContain('⟨ jumping to orchestra cloud ⟩')
    expect(t1).toContain('device handshake')
    expect(t1).not.toEqual(t2) // starfield advances with the tick
  })

  it('renders the celebration frame', () => {
    const frame = renderFrame(state({ mode: 'celebrate' }), 24, 80).join('\n')
    expect(frame).toContain('● cloud connected')
    expect(frame).toContain('( ^o^ )')
  })
})

describe('tui board, inbox, logs tabs', () => {
  it('board tab still lists cards', () => {
    const frame = renderFrame(state({ tab: 'board' }), 12, 80).join('\n')
    expect(frame).toContain('#325')
    expect(frame).toContain('(unowned)')
  })

  it('inbox renders questions', () => {
    const frame = renderFrame(state({ tab: 'inbox' }), 12, 80).join('\n')
    expect(frame).toContain('Q#35')
    expect(frame).toContain('amber-raven → crimson-stoat')
  })

  it('logs tab renders the event stream with timestamps', () => {
    const logs = [
      { ts: '17:49:02', tag: 'daemon', text: 'serving on 127.0.0.1:4750' },
      { ts: '17:52:44', tag: 'org-sync', text: 'stream closed by proxy — reconnecting (backoff 500ms)' },
    ]
    const frame = renderFrame(state({ tab: 'logs', logs }), 12, 100).join('\n')
    expect(frame).toContain('17:49:02')
    expect(frame).toContain('serving on 127.0.0.1:4750')
    expect(frame).toContain('reconnecting')
  })

  it('never exceeds the viewport width for plain frames', () => {
    for (const tab of ['home', 'board', 'logs'] as const) {
      for (const line of renderFrame(state({ tab }), 14, 44)) expect(line.length).toBeLessThanOrEqual(44)
    }
  })

  it('scrolls the board selection into view', () => {
    const s = state({ tab: 'board', cards: Array.from({ length: 30 }, (_, i) => ({ id: i, column: 'backlog', title: `card ${i}`, owner: null, paths: [] })), selected: 29 })
    clampSelection(s, listRegion(12).height)
    expect(s.scroll).toBe(29 - listRegion(12).height + 1)
    expect(renderFrame(s, 12, 80).join('\n')).toContain('card 29')
  })
})

describe('tui escape injection', () => {
  it('strips control characters from board-sourced text before it reaches the terminal', () => {
    const hostile = state({
      tab: 'board' as const,
      cards: [{
        id: 1,
        column: 'review',
        title: 'evil ESCAPE_2J title',
        owner: 'owner',
        paths: ['ab'],
        description: 'body hidden',
      }],
      questions: [{ id: 2, from: 'agent', to: 'all', body: 'ping ESCAPE_2J' }],
      boardName: 'board ESCAPE_31m',
      status: 'oops',
    })
    // Inject the real control bytes at runtime so no raw bytes live in this file.
    const ESC = String.fromCharCode(27)
    const BEL = String.fromCharCode(7)
    hostile.cards[0].title = `evil ${ESC}[2J${ESC}]0;spoofed${BEL} title`
    hostile.cards[0].description = `body ${ESC}[8m hidden ${BEL}`
    hostile.questions[0].body = `ping ${ESC}[2J`
    hostile.boardName = `board${ESC}[31m`
    for (const view of [
      renderFrame(hostile, 12, 80),
      renderFrame({ ...hostile, tab: 'inbox' as const }, 12, 80),
      renderFrame({ ...hostile, detail: hostile.cards[0] }, 12, 80),
    ]) {
      const frame = view.join('\n')
      expect(frame).not.toContain(ESC)
      expect(frame).not.toContain(BEL)
    }
    expect(renderFrame(hostile, 12, 80).join('\n')).toContain('evil')
  })
})

describe('tui input decoding', () => {
  const ESC = String.fromCharCode(27)
  it('decodes arrows, enter, tab, quit, and ctrl-c', () => {
    expect(decode(`${ESC}[A`)).toEqual([{ name: 'up', ctrl: false }])
    expect(decode(`${ESC}[B`)).toEqual([{ name: 'down', ctrl: false }])
    expect(decode('\r')).toEqual([{ name: 'enter', ctrl: false }])
    expect(decode('\t')).toEqual([{ name: 'tab', ctrl: false }])
    expect(decode('q')).toEqual([{ name: 'q', ctrl: false }])
    expect(decode(String.fromCharCode(3))).toEqual([{ name: 'c', ctrl: true }])
  })

  it('decodes SGR mouse presses and ignores releases and other buttons', () => {
    expect(decode(`${ESC}[<0;12;5M`)).toEqual([{ x: 12, y: 5 }])
    expect(decode(`${ESC}[<0;12;5m`)).toEqual([])
    expect(decode(`${ESC}[<64;12;5M`)).toEqual([]) // wheel
  })

  it('collapses unknown escape sequences instead of leaking characters', () => {
    expect(decode(`${ESC}[1;5C`)).toEqual([]) // ctrl-right: swallowed whole
    expect(decode(ESC)).toEqual([{ name: 'escape', ctrl: false }])
  })
})
