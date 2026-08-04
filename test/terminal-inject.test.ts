import { describe, expect, it } from 'vitest'
import {
  formatInjectedMessage,
  sanitizeInjectionText,
  sanitizeTerminalEndpoint,
} from '../src/terminal-inject.js'

describe('terminal injection (#103)', () => {
  it('accepts a plausible iTerm seat and strips /dev prefixes', () => {
    expect(sanitizeTerminalEndpoint({
      tty: '/dev/ttys006',
      term_program: 'iTerm.app',
      iterm_session_id: 'w0t0p2:D8BE0945',
    })).toEqual({ tty: 'ttys006', term_program: 'iTerm.app', iterm_session_id: 'w0t0p2:D8BE0945' })
  })

  it('accepts a tmux seat only with an absolute socket and %pane', () => {
    expect(sanitizeTerminalEndpoint({
      tmux_socket: '/private/tmp/tmux-501/default', tmux_pane: '%3',
    })).toEqual({ tmux_socket: '/private/tmp/tmux-501/default', tmux_pane: '%3' })
    expect(sanitizeTerminalEndpoint({ tmux_socket: 'relative/socket', tmux_pane: '%3' })).toBeNull()
    expect(sanitizeTerminalEndpoint({ tmux_socket: '/tmp/s', tmux_pane: '3' })).toBeNull()
  })

  it('rejects injection-shaped ttys and control characters', () => {
    expect(sanitizeTerminalEndpoint({ tty: '../../etc/passwd' })).toBeNull()
    expect(sanitizeTerminalEndpoint({ tty: 'ttys006; rm -rf /' })).toBeNull()
    expect(sanitizeTerminalEndpoint({ term_program: 'iTerm\napp' })).toBeNull()
    expect(sanitizeTerminalEndpoint('ttys006')).toBeNull()
    expect(sanitizeTerminalEndpoint(null)).toBeNull()
  })

  it('flattens injected text to one bounded line', () => {
    expect(sanitizeInjectionText('hello\nworld\r\n\ttabs')).toBe('hello world tabs')
    expect(sanitizeInjectionText('\x1b[31mred\x1b[0m')).toBe('[31mred [0m')
    expect(sanitizeInjectionText('x'.repeat(3000)).length).toBe(2000)
    expect(sanitizeInjectionText('  \n  ')).toBe('')
  })

  it('formats injected messages exactly like hook pulse delivery', () => {
    expect(formatInjectedMessage('ask', 7, null, 'hello', null))
      .toBe(`direct orchestra ask from human: "hello" — reply required with: orchestra reply 7 '<answer>'; no acknowledgment-only reply.`)
    expect(formatInjectedMessage('task', 9, 'strategist', 'do it', null))
      .toBe('orchestra task from strategist: "do it" — act on it; do not send an acknowledgment-only reply.')
    expect(formatInjectedMessage('reply', 11, 'slate-newt', 'done', 8))
      .toBe('orchestra reply from slate-newt: "done" (answers your msg #8) — no response required unless a follow-up is materially needed.')
  })
})
