// Precompress dist output so @fastify/static (preCompressed: true) can serve
// .br/.gz siblings without spending CPU per request. Runs as the build's last step.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt', '.map'])
const MIN_BYTES = 1024

export function compressDist(root) {
  let compressed = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(file); continue }
      if (!COMPRESSIBLE.has(path.extname(entry.name))) continue
      const raw = fs.readFileSync(file)
      if (raw.length < MIN_BYTES) continue
      fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(raw, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
      }))
      fs.writeFileSync(`${file}.gz`, zlib.gzipSync(raw, { level: 9 }))
      compressed += 1
    }
  }
  walk(root)
  return compressed
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(process.argv[2] ?? 'dist')
  const count = compressDist(root)
  console.log(`precompressed ${count} files in ${root}`)
}
