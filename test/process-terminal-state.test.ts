import { describe, expect, it } from 'vitest'
import { isResizableProcess } from '../web/src/processTerminalState.js'

describe('ProcessTerminal runtime state', () => {
  it('only resizes live PTYs and ignores stopping or terminal records', () => {
    expect(isResizableProcess({ id: 'starting', status: 'starting' })).toBe(true)
    expect(isResizableProcess({ id: 'running', status: 'running' })).toBe(true)

    for (const status of ['stopping', 'stopped', 'exited', 'failed', 'lost']) {
      expect(isResizableProcess({ id: status, status })).toBe(false)
    }
    expect(isResizableProcess(null)).toBe(false)
  })
})
