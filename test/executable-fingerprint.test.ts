import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintExecutableFileV1 } from '../src/runtime/drivers/executable-fingerprint.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('executable fingerprints', () => {
  it('hashes files larger than one read chunk without changing byte order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestra-executable-hash-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'provider-cli')
    const bytes = Buffer.alloc((64 * 1024 * 3) + 17)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251
    }
    writeFileSync(path, bytes)

    expect(fingerprintExecutableFileV1(path)).toBe(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    )
  })
})
