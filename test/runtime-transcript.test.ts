import { describe, expect, it } from 'vitest'
import { appendDriverTranscript, projectDriverTranscript } from '../src/runtime/transcript.js'
import type { DriverEvent } from '../src/runtime/types.js'

const event = (
  seq: number,
  type: DriverEvent['type'],
  data: string,
  metadata: Record<string, unknown> = {},
): DriverEvent => ({
  sessionId: 'codex:1',
  seq,
  type,
  at: `2026-07-19T20:00:${String(seq).padStart(2, '0')}.000Z`,
  data,
  metadata,
})

describe('driver transcript projection', () => {
  it('keeps protocol telemetry out of the human transcript', () => {
    const lines = projectDriverTranscript([
      event(1, 'status', 'thread/started', { method: 'thread/started', unknownNativeEvent: true }),
      event(2, 'status', 'mcpServer/startupStatus/updated', {
        method: 'mcpServer/startupStatus/updated', unknownNativeEvent: true,
      }),
      event(3, 'status', 'Codex turn started', { method: 'turn/started', turnActive: true }),
      event(4, 'status', 'Codex token usage updated', {
        method: 'thread/tokenUsage/updated', tokenUsage: { total: { totalTokens: 12 } },
      }),
      event(5, 'status', 'Codex thread idle', { method: 'thread/status/changed' }),
      event(6, 'status', 'hook/completed', { method: 'hook/completed', unknownNativeEvent: true }),
    ])

    expect(lines).toEqual([])
  })

  it('coalesces streaming assistant, reasoning, and tool output deltas', () => {
    const lines = projectDriverTranscript([
      event(1, 'output', 'Hello', { method: 'item/agentMessage/delta', itemId: 'message-1' }),
      event(2, 'output', '!', { method: 'item/agentMessage/delta', itemId: 'message-1' }),
      event(3, 'output', ' I', { method: 'item/agentMessage/delta', itemId: 'message-1' }),
      event(4, 'output', ' am Codex.', { method: 'item/agentMessage/delta', itemId: 'message-1' }),
      event(5, 'status', 'Check', { method: 'item/reasoning/textDelta', itemId: 'reasoning-1', kind: 'reasoning' }),
      event(6, 'status', 'ing', { method: 'item/reasoning/textDelta', itemId: 'reasoning-1', kind: 'reasoning' }),
      event(7, 'tool', 'first\n', { method: 'item/commandExecution/outputDelta', itemId: 'command-1' }),
      event(8, 'tool', 'second\n', { method: 'item/commandExecution/outputDelta', itemId: 'command-1' }),
    ])

    expect(lines.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'text', text: 'Hello! I am Codex.' },
      { kind: 'thinking', text: 'Checking' },
      { kind: 'tool_result', text: 'first\nsecond\n' },
    ])
  })

  it('replaces tool lifecycle entries and summarizes large plan and diff payloads', () => {
    const lines = projectDriverTranscript([
      event(1, 'tool', 'npm test (started)', { method: 'item/started', itemId: 'command-1' }),
      event(2, 'tool', 'npm test (completed)', { method: 'item/completed', itemId: 'command-1' }),
      event(3, 'status', 'Codex plan updated', {
        method: 'turn/plan/updated', plan: [{ step: 'one' }, { step: 'two' }], native: { large: true },
      }),
      event(4, 'tool', 'a very large raw diff', { method: 'turn/diff/updated', diff: 'a very large raw diff' }),
      event(5, 'status', 'Codex turn completed', { method: 'turn/completed', status: 'completed' }),
    ])

    expect(lines.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'tool', text: 'npm test (completed)' },
      { kind: 'status', text: 'plan updated · 2 steps' },
      { kind: 'status', text: 'working tree diff updated' },
      { kind: 'status', text: 'turn finished (completed)' },
    ])
    expect(lines[1].metadata).not.toHaveProperty('native')
    expect(lines[1].metadata).not.toHaveProperty('plan')
    expect(lines[2].metadata).not.toHaveProperty('diff')
  })

  it('keeps provider errors visible and enforces the transcript cap', () => {
    const lines = [] as ReturnType<typeof projectDriverTranscript>
    expect(appendDriverTranscript(lines, event(1, 'error', 'rate limit reached', { method: 'error' }), 2)).toBe(true)
    appendDriverTranscript(lines, event(2, 'output', 'one'), 2)
    appendDriverTranscript(lines, event(3, 'output', 'two'), 2)
    expect(lines.map((line) => line.text)).toEqual(['one', 'two'])
  })
})
