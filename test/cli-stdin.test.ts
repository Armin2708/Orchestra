// Shell-safe message bodies (card #53): --stdin must deliver bytes untouched by the
// shell, and the substitution guard must warn on leak smells without ever blocking.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { readStdinBody, substitutionWarning } from '../src/msgsafe.js'

const ROOT = path.join(__dirname, '..')

it('readStdinBody keeps backticks and $() byte-identical, stripping one heredoc newline', async () => {
  const feed = (s: string) => {
    const p = new PassThrough()
    p.end(s)
    return readStdinBody(p)
  }
  const tricky = 'field `updated_at` and $(whoami) and "quotes" and \'single\' and $HOME'
  expect(await feed(tricky)).toBe(tricky)
  expect(await feed(tricky + '\n')).toBe(tricky) // heredoc trailing newline
  expect(await feed(tricky + '\n\n')).toBe(tricky + '\n') // only ONE is stripped
  expect(await feed('multi\nline\nbody')).toBe('multi\nline\nbody')
})

it('substitutionWarning fires on leak smells and stays silent on prose', () => {
  // simulated keychain dump — the shape of the real msg #294 incident
  const dump = 'keychain: "/Users/x/Library/Keychains/login.keychain-db"\n' +
    'class: "genp"\nattributes:\n  "acct"<blob>="user"\npassword: "hunter2"'
  expect(substitutionWarning(dump)).toMatch(/credential|substitution/)
  expect(substitutionWarning('output of security find-generic-password -w')).toBeTruthy()
  expect(substitutionWarning('{"claudeAiOauth":{"accessToken":"sk-x"}}')).toBeTruthy()
  expect(substitutionWarning('body with one ` dangling')).toMatch(/unmatched backtick/)
  expect(substitutionWarning('an unclosed $( here')).toMatch(/unclosed/)
  // normal prose, including balanced code spans, stays silent
  expect(substitutionWarning('is the SSE stream path final?')).toBeUndefined()
  expect(substitutionWarning('the `updated_at` column and $(pwd) arrive intact')).toBeUndefined()
  expect(substitutionWarning('costs $40 and 50% off')).toBeUndefined()
})

// the rules must teach the safe pattern (teal-ibex's #35 budget test stays untouched:
// plain compact carries no note — the CLI warning + README teach it at point of failure)
it('rules teach single-quoting: no double-quoted body examples, stdin note where it fits', async () => {
  const { compactRules, verboseRules, conductorCompactRules, conductorVerboseRules } = await import('../src/rules.js')
  const variants = [compactRules, verboseRules, conductorCompactRules, conductorVerboseRules].map((f) => f('probe'))
  for (const text of variants) {
    expect(text).not.toMatch(/"</) // "<placeholder>" body in double quotes
    expect(text).not.toContain('"..."')
  }
  for (const text of [verboseRules('probe'), conductorCompactRules('probe'), conductorVerboseRules('probe')])
    expect(text).toContain('--stdin')
})

// E2E: printf body | orchestra <cmd> --stdin → byte-identical on the board
let server: any, port: number, home: string, proj: string
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-home-'))
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-proj-'))
  server = buildServer(openDb(':memory:'))
  await server.listen({ host: '127.0.0.1', port: 0 })
  port = server.server.address().port
})
afterAll(async () => { await server.close() })

function cli(args: string[], stdin?: string): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile('npx', ['tsx', path.join(ROOT, 'src/cli.ts'), ...args], {
      cwd: proj,
      env: { ...process.env, ORCHESTRA_HOME: home, ORCHESTRA_PORT: String(port), ORCHESTRA_AGENT: 'stdin-tester' },
    }, (e, out, err) => resolve({ out, err, code: (e as any)?.code ?? 0 }))
    if (stdin !== undefined) child.stdin!.end(stdin)
    else child.stdin!.end()
  })
}

const TRICKY = 'the `updated_at` field, $(whoami), "double", \'single\', ${HOME} — all intact'

it('note/reply --stdin deliver byte-identical bodies end to end', async () => {
  const note = await cli(['note', '--stdin'], TRICKY)
  expect(note.code).toBe(0)
  const noteId = Number(note.out.match(/msg #(\d+)/)?.[1])
  expect(noteId).toBeGreaterThan(0)

  const reply = await cli(['reply', String(noteId), '--stdin'], TRICKY + ' (reply)')
  expect(reply.code).toBe(0)

  const boards = await (await fetch(`http://127.0.0.1:${port}/api/v1/boards`)).json() as any[]
  const snap = await (await fetch(`http://127.0.0.1:${port}/api/v1/boards/${boards[0].id}/snapshot`)).json() as any
  const thread = snap.threads.find((t: any) => t.id === noteId)
  expect(thread.body).toBe(TRICKY) // byte-identical: backticks and $() intact
  expect(thread.replies[0].body).toBe(TRICKY + ' (reply)')
}, 30_000)

it('argv body with leak signature warns on stderr but still delivers', async () => {
  const r = await cli(['note', 'password: "hunter2" from find-generic-password'])
  expect(r.code).toBe(0)
  expect(r.err).toContain('⚠')
  expect(r.out).toMatch(/note posted/)
}, 30_000)

it('missing body without --stdin exits with guidance', async () => {
  const r = await cli(['note'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('--stdin')
}, 30_000)
