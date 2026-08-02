import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureTerminalHistoryDigestKey } from '../src/daemon.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('tightens and re-verifies an existing terminal history digest key', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terminal-history-key-'))
  roots.push(root)
  const keyPath = path.join(root, 'terminal-history.key')
  const expected = Buffer.alloc(32, 13)
  writeFileSync(keyPath, expected)
  chmodSync(keyPath, 0o644)

  expect(ensureTerminalHistoryDigestKey(root)).toEqual(expected)
  expect(statSync(keyPath).mode & 0o777).toBe(0o600)
})
