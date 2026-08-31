/**
 * Terminal styling for the CLI. Color exists only for a human at an interactive
 * terminal: hooks, pipes, tests, and agents consuming `orchestra snapshot` must keep
 * receiving the exact plain bytes they always have, so every helper is a byte-for-byte
 * no-op unless stdout is a TTY that wants color (NO_COLOR and TERM=dumb win; FORCE_COLOR
 * opts back in for tooling that captures a pseudo-terminal).
 */

const colorEnabled = (): boolean => {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true
  return process.stdout.isTTY === true && process.env.TERM !== 'dumb'
}

const enabled = colorEnabled()

type Paint = (text: string) => string

const wrap = (open: number, close: number): Paint => (text) =>
  enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text

export const bold: Paint = wrap(1, 22)
export const inverse: Paint = wrap(7, 27)
export const dim: Paint = wrap(2, 22)
export const red: Paint = wrap(31, 39)
export const green: Paint = wrap(32, 39)
export const yellow: Paint = wrap(33, 39)
export const magenta: Paint = wrap(35, 39)
export const cyan: Paint = wrap(36, 39)

/** The one accent color. Card ids, message ids, anything the eye should land on. */
export const accent: Paint = cyan

/** Board columns get a stable hue so state reads at a glance. */
export const column: Paint = (name) => {
  if (name === 'in_progress') return yellow(name)
  if (name === 'review') return magenta(name)
  if (name === 'done') return green(name)
  return dim(name) // backlog and anything future
}
