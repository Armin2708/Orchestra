import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ExternalTranscriptService, parseTranscriptEntry, validTranscriptPath } from '../src/external-transcript.js'

// the tailer only reads .jsonl files under the user's home — fixtures must live there
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-ext-test-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const entry = (obj: Record<string, unknown>) => JSON.stringify(obj) + '\n'
const assistant = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  entry({ type: 'assistant', timestamp: '2026-08-04T10:00:00Z', message: { role: 'assistant', content: blocks }, ...extra })
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  entry({ type: 'user', timestamp: '2026-08-04T10:00:01Z', message: { role: 'user', content }, ...extra })

it('projects assistant text/thinking/tool_use blocks into transcript lines', () => {
  const lines = parseTranscriptEntry(JSON.parse(assistant([
    { type: 'thinking', thinking: 'pondering' },
    { type: 'text', text: 'hello there' },
    { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
  ])))
  expect(lines).toEqual([
    { at: '2026-08-04T10:00:00Z', kind: 'thinking', text: 'pondering' },
    { at: '2026-08-04T10:00:00Z', kind: 'text', text: 'hello there' },
    { at: '2026-08-04T10:00:00Z', kind: 'tool', text: 'Bash(git status)' },
  ])
})

it('projects user prompts and tool results, skipping hook/system noise', () => {
  expect(parseTranscriptEntry(JSON.parse(user('fix the login bug')))).toEqual([
    { at: '2026-08-04T10:00:01Z', kind: 'user', text: 'fix the login bug' },
  ])
  expect(parseTranscriptEntry(JSON.parse(user([
    { type: 'tool_result', tool_use_id: 't1', content: 'line one\nline two\nline three' },
  ])))[0]).toEqual({ at: '2026-08-04T10:00:01Z', kind: 'tool_result', text: 'line one  … +2 lines' })
  expect(parseTranscriptEntry(JSON.parse(user('<system-reminder>noise</system-reminder>')))).toEqual([])
  expect(parseTranscriptEntry(JSON.parse(user('<command-name>/clear</command-name>')))).toEqual([])
  expect(parseTranscriptEntry(JSON.parse(user('hi', { isMeta: true })))).toEqual([])
  expect(parseTranscriptEntry(JSON.parse(assistant([{ type: 'text', text: 'sub' }], { isSidechain: true })))).toEqual([])
  expect(parseTranscriptEntry(JSON.parse(entry({ type: 'file-history-snapshot' })))).toEqual([])
})

it('only accepts absolute .jsonl paths that really live under the home directory', () => {
  const good = path.join(dir, 'sess.jsonl')
  fs.writeFileSync(good, '')
  expect(validTranscriptPath(good)).toBe(fs.realpathSync(good))
  expect(validTranscriptPath('relative.jsonl')).toBeNull()
  expect(validTranscriptPath(path.join(dir, 'sess.txt'))).toBeNull()
  expect(validTranscriptPath('/etc/passwd')).toBeNull()
  expect(validTranscriptPath(path.join(dir, 'missing.jsonl'))).toBeNull()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-outside-'))
  try {
    const link = path.join(dir, 'link.jsonl')
    fs.writeFileSync(path.join(outside, 'real.jsonl'), '')
    fs.symlinkSync(path.join(outside, 'real.jsonl'), link)
    expect(validTranscriptPath(link)).toBeNull() // symlink escaping home is refused
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

it('tails incrementally across appends and survives malformed lines', () => {
  const file = path.join(dir, 'sess.jsonl')
  fs.writeFileSync(file, user('first prompt'))
  const svc = new ExternalTranscriptService()
  svc.track(7, file)
  expect(svc.transcript(7).lines.map((l) => l.text)).toEqual(['first prompt'])

  fs.appendFileSync(file, 'not json at all\n' + assistant([{ type: 'text', text: 'reply' }]))
  expect(svc.transcript(7).lines.map((l) => l.text)).toEqual(['first prompt', 'reply'])
  // re-reading without growth is a no-op
  expect(svc.transcript(7).lines).toHaveLength(2)
})

it('resets on truncation and switches files when the session rotates', () => {
  const file = path.join(dir, 'sess.jsonl')
  fs.writeFileSync(file, user('old prompt'))
  const svc = new ExternalTranscriptService()
  svc.track(7, file)
  expect(svc.transcript(7).lines).toHaveLength(1)

  fs.writeFileSync(file, assistant([{ type: 'text', text: 'fresh' }])) // truncated shorter
  expect(svc.transcript(7).lines.map((l) => l.text)).toEqual(['fresh'])

  const next = path.join(dir, 'sess2.jsonl')
  fs.writeFileSync(next, user('new session'))
  svc.track(7, next)
  expect(svc.transcript(7).lines.map((l) => l.text)).toEqual(['new session'])
  // re-tracking the same path keeps the tail state
  svc.track(7, next)
  expect(svc.transcript(7).lines.map((l) => l.text)).toEqual(['new session'])
})

it('caps the buffer at 500 lines and returns empty for unknown agents or invalid paths', () => {
  const file = path.join(dir, 'big.jsonl')
  fs.writeFileSync(file, Array.from({ length: 620 }, (_, i) => user(`prompt ${i}`)).join(''))
  const svc = new ExternalTranscriptService()
  svc.track(1, file)
  const lines = svc.transcript(1).lines
  expect(lines).toHaveLength(500)
  expect(lines[499].text).toBe('prompt 619')

  expect(svc.transcript(99).lines).toEqual([])
  svc.track(2, '/etc/passwd')
  expect(svc.transcript(2).lines).toEqual([])
})

// boots a full server — allow for slow first-boot work (static asset scan) under parallel load
it('pulse-reported transcript paths serve the read-only transcript endpoint fallback', { timeout: 30_000 }, async () => {
  const { openDb } = await import('../src/db.js')
  const { buildServer } = await import('../src/server.js')
  const server = buildServer(openDb(':memory:'))
  await server.ready()
  const board = (await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/tmp/ext' } })).json()
  const agent = (await server.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: board.id, session_id: 'ext1' } })).json()
  const identity = { provider: agent.provider, session_id: agent.external_session_id, session_token: agent.session_token }

  const file = path.join(dir, 'live.jsonl')
  fs.writeFileSync(file, user('hello from my terminal') + assistant([{ type: 'text', text: 'on it' }]))
  const pulse = await server.inject({
    method: 'POST', url: `/api/v1/agents/${agent.id}/pulse`,
    payload: { ...identity, transcript_path: file },
  })
  expect(pulse.statusCode).toBe(200)

  const t = (await server.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/transcript` })).json()
  expect(t.external).toBe(true)
  expect(t.working).toBeNull()
  expect(t.lines.map((l: any) => [l.kind, l.text])).toEqual([
    ['user', 'hello from my terminal'],
    ['text', 'on it'],
  ])
  await server.close()
})
