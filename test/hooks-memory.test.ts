import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMemory, writeHandoff } from '../src/memory.js'
import { renderMemorySection } from '../src/hooks.js'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })

describe('session-start memory injection', () => {
  it('renders memory + consumes the handoff exactly once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hookmem-'))
    roots.push(root)
    appendMemory(root, 5, 'violet-puffin', 'yesterday: shipped init')
    writeHandoff(root, 5, 'violet-puffin', 'Next: publish to npm')
    const first = renderMemorySection(5, root)
    expect(first).toContain('=== HANDOFF ===')
    expect(first).toContain('Next: publish to npm')
    expect(first).toContain('=== MEMORY ===')
    expect(first).toContain('shipped init')
    const second = renderMemorySection(5, root)
    expect(second).not.toContain('=== HANDOFF ===')
    expect(second).toContain('shipped init')
  })

  it('renders nothing for a board with no memory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hookmem-'))
    roots.push(root)
    expect(renderMemorySection(7, root)).toBe('')
  })
})
