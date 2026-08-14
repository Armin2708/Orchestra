import { describe, expect, it } from 'vitest'
import {
  loadQwenSessionTranscript,
  parseQwenTranscriptEntry,
} from '../src/external-transcript.js'

describe('qwen transcript parsing', () => {
  it('maps user, assistant, thought, tool-call and tool-result entries', () => {
    const user = parseQwenTranscriptEntry({
      type: 'user',
      timestamp: '2026-08-06T11:15:19.176Z',
      message: { role: 'user', parts: [{ text: 'Reply with exactly one word: PONG' }] },
    })
    expect(user).toEqual([
      { at: '2026-08-06T11:15:19.176Z', kind: 'user', text: 'Reply with exactly one word: PONG' },
    ])

    const assistant = parseQwenTranscriptEntry({
      type: 'assistant',
      timestamp: '2026-08-06T11:15:23.720Z',
      message: {
        role: 'assistant',
        parts: [
          { text: 'thinking about it', thought: true },
          { text: 'DONE' },
          { functionCall: { id: 'call-1', name: 'list_directory', args: { path: '/tmp' } } },
        ],
      },
    })
    expect(assistant.map((line) => line.kind)).toEqual(['thinking', 'text', 'tool'])
    expect(assistant[2].text).toContain('list_directory')

    const toolResult = parseQwenTranscriptEntry({
      type: 'tool_result',
      timestamp: '2026-08-06T11:16:38.070Z',
      message: {
        parts: [{
          functionResponse: {
            id: 'call-1',
            name: 'list_directory',
            response: { output: 'Listed 4 item(s)\nline two' },
          },
        }],
      },
    })
    expect(toolResult).toHaveLength(1)
    expect(toolResult[0].kind).toBe('tool_result')
    expect(toolResult[0].text).toContain('Listed 4 item(s)')
  })

  it('skips system telemetry and attribution entries entirely', () => {
    expect(parseQwenTranscriptEntry({
      type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: 'turn' },
    })).toEqual([])
    expect(parseQwenTranscriptEntry({ type: 'system', subtype: 'attribution_snapshot' })).toEqual([])
    expect(parseQwenTranscriptEntry(null)).toEqual([])
    expect(parseQwenTranscriptEntry({ type: 'user' })).toEqual([])
  })

  it('guards the session file loader against untrusted input', () => {
    expect(loadQwenSessionTranscript('/project', 'not-a-uuid')).toEqual([])
    expect(loadQwenSessionTranscript('relative/project', 'd6dafa6b-6659-4d1a-9759-1b97f5c4c81d')).toEqual([])
    expect(loadQwenSessionTranscript('/does/not/exist', 'd6dafa6b-6659-4d1a-9759-1b97f5c4c81d')).toEqual([])
  })
})
