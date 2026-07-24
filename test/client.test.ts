import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { api, projectPath } from '../src/client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('falls back to cwd outside git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-'))
  expect(projectPath(dir)).toBe(fs.realpathSync(dir))
})

it('parses JSON APIs and preserves non-JSON response bodies as text', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('# redacted transcript\n', {
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    }))
    .mockResolvedValueOnce(new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }))
  vi.stubGlobal('fetch', fetch)

  expect(await api('GET', '/os/sessions/session-1/export?format=human'))
    .toBe('# redacted transcript\n')
  expect(await api('GET', '/os/sessions/session-1/export?format=json'))
    .toEqual({ ok: true })
})
