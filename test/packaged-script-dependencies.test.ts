import { readFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  files: string[]
}

describe('packaged script dependency closure', () => {
  it('ships every relative module imported by a packaged JavaScript entrypoint', () => {
    const packaged = new Set(packageJson.files)
    const entrypoints = packageJson.files.filter((file) =>
      file.startsWith('scripts/') && file.endsWith('.mjs'))

    for (const entrypoint of entrypoints) {
      const source = readFileSync(entrypoint, 'utf8')
      const imports = source.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/gu)
      for (const [, specifier] of imports) {
        const dependency = posix.normalize(posix.join(dirname(entrypoint), specifier))
        expect(packaged, `${entrypoint} imports unpackaged ${dependency}`).toContain(dependency)
      }
    }
  })
})
