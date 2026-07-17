import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectPath } from '../src/client.js'

it('falls back to cwd outside git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-'))
  expect(projectPath(dir)).toBe(fs.realpathSync(dir))
})
