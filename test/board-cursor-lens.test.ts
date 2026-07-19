import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('board cursor distortion lens', () => {
  it('keeps its compact visual size and pointer geometry synchronized', () => {
    const board = readFileSync(new URL('../web/src/Board.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

    expect(css).toMatch(/--cursor-lens-size:\s*168px;/)
    expect(css).toMatch(/width:\s*var\(--cursor-lens-size\);\s*height:\s*var\(--cursor-lens-size\);/)
    expect(board).toContain('const radius = lens.offsetWidth / 2 || 84')
  })
})
