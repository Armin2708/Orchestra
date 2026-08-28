// Syncs the human-approved Orchestra identity into the web app. The canonical
// masters live at the repository root so this script cannot redraw or drift them.
// Run from web/: node scripts/gen-icons.mjs
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const sourceDir = join(scriptDir, '..', '..', 'brand', 'identity')
const outDir = join(scriptDir, '..', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

for (const [source, name] of [
  ['orchestra-app-icon-32.png', 'icon-32.png'],
  ['orchestra-app-icon-192.png', 'icon-192.png'],
  ['orchestra-app-icon-512.png', 'icon-512.png'],
  ['orchestra-app-icon-512.png', 'icon-maskable-512.png'],
  ['orchestra-app-icon.svg', 'orchestra-icon.svg'],
  ['orchestra-mark.svg', 'orchestra-mark.svg'],
]) {
  copyFileSync(join(sourceDir, source), join(outDir, name))
  console.log('wrote', name)
}
