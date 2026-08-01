import { createHash } from 'node:crypto'
import {
  closeSync,
  openSync,
  readSync,
} from 'node:fs'

const EXECUTABLE_HASH_CHUNK_BYTES = 64 * 1024

export function fingerprintExecutableFileV1(resolvedPath: string): string {
  const handle = openSync(resolvedPath, 'r')
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(EXECUTABLE_HASH_CHUNK_BYTES)
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(handle, chunk, 0, chunk.byteLength, null)
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead))
    } while (bytesRead > 0)
    return `sha256:${hash.digest('hex')}`
  } finally {
    closeSync(handle)
  }
}
