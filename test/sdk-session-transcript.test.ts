import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSdkSessionTranscript } from '../src/external-transcript.js'

const SESSION = '11111111-2222-4333-8444-555555555555'
const CWD = `/tmp/orchestra-sdk-restore-test-${process.pid}`
const DIR = path.join(os.homedir(), '.claude', 'projects', CWD.replace(/[/.]/g, '-'))

afterEach(() => { fs.rmSync(DIR, { recursive: true, force: true }) })

describe('SDK session transcript recovery (#108)', () => {
  it('parses the session file the SDK resumes from', () => {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(path.join(DIR, `${SESSION}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: 't1', message: { content: 'fix the bug' } }),
      JSON.stringify({ type: 'assistant', timestamp: 't2', message: { content: [
        { type: 'text', text: 'on it' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', timestamp: 't3', message: { content: [
        { type: 'tool_result', content: 'file.ts' }] } }),
      'not json at all',
    ].join('\n'))
    expect(loadSdkSessionTranscript(CWD, SESSION)).toEqual([
      { at: 't1', kind: 'user', text: 'fix the bug' },
      { at: 't2', kind: 'text', text: 'on it' },
      { at: 't2', kind: 'tool', text: 'Bash(ls)' },
      { at: 't3', kind: 'tool_result', text: 'file.ts' },
    ])
  })

  it('returns empty for unknown sessions, bad ids, and relative cwds', () => {
    expect(loadSdkSessionTranscript(CWD, SESSION)).toEqual([])
    expect(loadSdkSessionTranscript(CWD, '../../etc/passwd')).toEqual([])
    expect(loadSdkSessionTranscript('relative/dir', SESSION)).toEqual([])
  })
})
