// The cloud build's entry is cloud.html, but the host serves it at "/", so the built
// artifact has to be index.html. Renaming after `vite build` keeps Vercel's
// outputDirectory (web/dist) and its SPA rewrite unchanged, and runs before
// compress-dist so the precompressed pair matches the final filename.
import { rename, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const dist = resolve(process.argv[2] ?? 'dist')
const from = join(dist, 'cloud.html')
const to = join(dist, 'index.html')

try {
  await access(from)
} catch {
  // A local build never emits cloud.html — fail loudly rather than shipping the
  // wrong entry, since the difference is invisible until someone signs in.
  console.error(`rename-cloud-entry: ${from} not found — did this run after \`vite build --mode cloud\`?`)
  process.exit(1)
}

await rename(from, to)
console.log(`cloud entry: ${from} -> ${to}`)
