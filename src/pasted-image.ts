import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A pasted image can't travel through a PTY byte stream or a board message — it
// lands as a file the provider CLI can read, and the web client puts the
// returned path into the prompt. Shared by the workspace process terminal and
// the agent chat composer. Content validation: the declared type must be a
// raster format AND the bytes must carry its magic number.
export const PASTED_IMAGE_TYPES: Record<string, { extension: string; magic: (bytes: Buffer) => boolean }> = {
  'image/png': { extension: 'png', magic: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  'image/jpeg': { extension: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { extension: 'gif', magic: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  'image/webp': { extension: 'webp', magic: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
}
export const PASTED_IMAGE_CAP = 10 * 1024 * 1024
// base64 inflates ~4/3 over the decoded cap; fastify's default 1 MiB body limit is too small
export const PASTE_IMAGE_BODY_LIMIT = 15 * 1024 * 1024

export const DEFAULT_PASTE_IMAGE_ROOT = () => path.join(os.tmpdir(), 'orchestra-pasted')

/** Validates a paste-image request body; returns the decoded image or a 400-worthy message. */
export function validatePastedImage(mediaType: unknown, data: unknown):
  { image: Buffer; extension: string } | { error: string } {
  if (typeof mediaType !== 'string' || !(mediaType in PASTED_IMAGE_TYPES))
    return { error: `media_type must be one of: ${Object.keys(PASTED_IMAGE_TYPES).join(', ')}` }
  if (typeof data !== 'string' || data.length === 0)
    return { error: 'data must be a base64 string' }
  const image = Buffer.from(data, 'base64')
  if (image.byteLength > PASTED_IMAGE_CAP)
    return { error: 'pasted image exceeds the 10 MiB limit' }
  const type = PASTED_IMAGE_TYPES[mediaType]
  if (!type.magic(image))
    return { error: `image bytes do not match the declared ${mediaType} format` }
  return { image, extension: type.extension }
}

/** Writes a validated image under `root` and returns its absolute path. */
export function savePastedImage(root: string, image: Buffer, extension: string): string {
  fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, `paste-${Date.now()}-${randomBytes(4).toString('hex')}.${extension}`)
  fs.writeFileSync(file, image, { mode: 0o600 })
  return file
}
