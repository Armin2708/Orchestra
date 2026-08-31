/**
 * Raw terminal control for the interactive session. Owns the alternate screen buffer
 * (the terminal is restored exactly as it was on any exit path, including signals and
 * crashes), raw-mode key decoding, and SGR mouse clicks. No dependencies: the escape
 * codes used here are the same VT/xterm sequences the org picker already relies on.
 */

export interface Key {
  /** Decoded name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'tab' | a literal character. */
  name: string
  ctrl: boolean
}

export interface Click {
  /** 1-based terminal column/row. */
  x: number
  y: number
}

export interface TermHandlers {
  onKey: (key: Key) => void
  onClick: (click: Click) => void
  onResize: () => void
}

const ENTER_ALT = '\u001b[?1049h'
const LEAVE_ALT = '\u001b[?1049l'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
// Button events only (1000) in SGR encoding (1006) — wheel/motion tracking would
// swallow scrollback gestures for no benefit.
const MOUSE_ON = '\u001b[?1000;1006h'
const MOUSE_OFF = '\u001b[?1000;1006l'

export class Term {
  #open = false
  #cleanup: Array<() => void> = []

  size(): { rows: number; cols: number } {
    return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 }
  }

  open(handlers: TermHandlers): void {
    if (this.#open) return
    this.#open = true
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdout.write(ENTER_ALT + HIDE_CURSOR + MOUSE_ON)

    const onData = (chunk: Buffer) => {
      for (const event of decode(chunk.toString('utf8'))) {
        if ('x' in event) handlers.onClick(event)
        else handlers.onKey(event)
      }
    }
    const onResize = () => handlers.onResize()
    process.stdin.on('data', onData)
    process.stdout.on('resize', onResize)
    // The terminal must come back no matter how the process leaves.
    const restore = () => this.close()
    process.on('exit', restore)
    this.#cleanup.push(
      () => process.stdin.off('data', onData),
      () => process.stdout.off('resize', onResize),
      () => process.off('exit', restore),
    )
  }

  /** Repaint the whole viewport. Lines are clipped/padded by the renderer. */
  draw(lines: string[]): void {
    if (!this.#open) return
    // Home + write each line with erase-to-end; no full clears, so there is no flicker.
    let frame = '\u001b[H'
    for (let i = 0; i < lines.length; i++) frame += `${lines[i]}\u001b[K${i < lines.length - 1 ? '\r\n' : ''}`
    frame += '\u001b[0J' // clear anything below the frame (after a shrink)
    process.stdout.write(frame)
  }

  close(): void {
    if (!this.#open) return
    this.#open = false
    for (const fn of this.#cleanup.splice(0)) fn()
    process.stdout.write(MOUSE_OFF + SHOW_CURSOR + LEAVE_ALT)
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
  }
}

/** Decode a raw stdin chunk into keys and clicks. Exported for tests. */
export function decode(data: string): Array<Key | Click> {
  const out: Array<Key | Click> = []
  let i = 0
  while (i < data.length) {
    const ch = data[i]
    if (ch === '\u001b') {
      // SGR mouse: ESC [ < b ; x ; y (M=press, m=release) — act on press only.
      const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i))
      if (mouse) {
        if (mouse[4] === 'M' && Number(mouse[1]) === 0) out.push({ x: Number(mouse[2]), y: Number(mouse[3]) })
        i += mouse[0].length
        continue
      }
      const arrow = /^\u001b\[([ABCD])/.exec(data.slice(i))
      if (arrow) {
        out.push({ name: { A: 'up', B: 'down', C: 'right', D: 'left' }[arrow[1]]!, ctrl: false })
        i += arrow[0].length
        continue
      }
      // Any other escape sequence collapses to escape; skip its tail conservatively.
      const tail = /^\u001b\[[0-9;?<]*[A-Za-z~]/.exec(data.slice(i))
      if (tail) { i += tail[0].length; continue }
      out.push({ name: 'escape', ctrl: false })
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') out.push({ name: 'enter', ctrl: false })
    else if (ch === '\t') out.push({ name: 'tab', ctrl: false })
    else if (ch === '\u0003') out.push({ name: 'c', ctrl: true })
    else if (ch >= ' ') out.push({ name: ch, ctrl: false })
    i += 1
  }
  return out
}
