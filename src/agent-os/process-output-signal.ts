import { EventEmitter } from 'node:events'

// Terminal output has no push transport — the drawer reads it with GET /processes/:id/output.
// A fixed poll interval loses both ways: at 160ms every echoed keystroke waited for the next
// tick before it could appear, and while output streamed the client re-polled with no delay
// at all. Parking the request until the pty actually writes fixes both ends — a keystroke
// echoes at network latency, and an idle terminal costs one open request instead of six a
// second. Opt-in per request (`wait=1`) so every existing caller keeps its old semantics.
const signal = new EventEmitter()
// one waiter per open terminal pane; the default ceiling of 10 would be a false positive
signal.setMaxListeners(0)

export const PROCESS_OUTPUT_WAIT_CEILING_MS = 25_000

export function notifyProcessOutput(processId: string): void {
  signal.emit(processId)
}

/** Resolves on the next write to this process, or when timeoutMs elapses — whichever is first. */
export function waitForProcessOutput(processId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.off(processId, finish)
      resolve()
    }
    const timer = setTimeout(finish, Math.min(timeoutMs, PROCESS_OUTPUT_WAIT_CEILING_MS))
    // a parked reader must never hold the daemon open on shutdown
    timer.unref?.()
    signal.once(processId, finish)
  })
}
