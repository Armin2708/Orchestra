import { expect, it } from 'vitest'
import { projectPath } from '../src/client.js'
it('falls back to cwd outside git', () => {
  const p = projectPath('/private/tmp')
  expect(p).toBe('/private/tmp')
})
