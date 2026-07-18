// Renders the Orchestra mark (rounded #111 square, three light bars) to PNG
// app icons without any image dependency. Run: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

const INK = [0x11, 0x11, 0x11, 255]
const PAPER = [0xF7, 0xF6, 0xF3, 255]
// the 32-unit mark: [x, y, w, h, corner-radius]
const BARS = [[7, 9, 5, 14, 1.5], [14, 9, 5, 9, 1.5], [21, 9, 5, 11, 1.5]]

const inRoundRect = (px, py, x, y, w, h, r) => {
  if (px < x || px > x + w || py < y || py > y + h) return false
  const cx = Math.max(x + r, Math.min(px, x + w - r))
  const cy = Math.max(y + r, Math.min(py, y + h - r))
  const dx = px - cx, dy = py - cy
  return dx * dx + dy * dy <= r * r || (px >= x + r && px <= x + w - r) || (py >= y + r && py <= y + h - r)
}

function render(size, { maskable }) {
  const img = Buffer.alloc(size * size * 4)
  // maskable: full-bleed bg, mark shrunk into the 80% safe zone
  const scale = (maskable ? size * 0.8 : size) / 32
  const off = maskable ? size * 0.1 : 0
  const SS = 3 // supersample for smooth corners
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHit = 0, barHit = 0
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = (x + (sx + 0.5) / SS - off) / scale
        const py = (y + (sy + 0.5) / SS - off) / scale
        const inBg = maskable || inRoundRect(px, py, 0, 0, 32, 32, 8)
        if (inBg) bgHit++
        if (inBg && BARS.some(([bx, by, bw, bh, br]) => inRoundRect(px, py, bx, by, bw, bh, br))) barHit++
      }
      const n = SS * SS
      const i = (y * size + x) * 4
      const a = bgHit / n
      const t = barHit / n // bar coverage within the hit area
      for (let c = 0; c < 3; c++) img[i + c] = Math.round(INK[c] + (PAPER[c] - INK[c]) * (a ? t / a : 0))
      img[i + 3] = maskable ? 255 : Math.round(255 * a)
    }
  }
  return img
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xFFFFFFFF
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, img) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) img.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [name, size, opts] of [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
]) {
  writeFileSync(join(outDir, name), png(size, render(size, opts)))
  console.log('wrote', name)
}
