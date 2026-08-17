import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMemory, consumeHandoff, readMemoryInjection, writeHandoff } from '../src/memory.js'

const roots: string[] = []
const freshRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mem-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('memory store', () => {
  it('appends a stamped entry to today and reads it back in the injection', () => {
    const root = freshRoot()
    appendMemory(root, 3, 'violet-puffin', 'shipped the widget', new Date('2026-08-18T09:15:00Z'))
    const injection = readMemoryInjection(root, 3)
    expect(injection).toContain('=== MEMORY ===')
    expect(injection).toContain('| violet-puffin')
    expect(injection).toContain('shipped the widget')
    expect(injection).toContain(`board-3`)
  })

  it('returns empty string when nothing was ever remembered', () => {
    expect(readMemoryInjection(freshRoot(), 9)).toBe('')
  })

  it('rotates yesterday into recent.md on the next append', () => {
    const root = freshRoot()
    appendMemory(root, 1, 'a', 'old work', new Date('2026-08-17T10:00:00Z'))
    appendMemory(root, 1, 'a', 'new work', new Date('2026-08-18T10:00:00Z'))
    const dir = path.join(root, 'board-1')
    expect(fs.existsSync(path.join(dir, 'today-2026-08-17.md'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'recent.md'), 'utf8')).toContain('old work')
    expect(fs.readFileSync(path.join(dir, 'today-2026-08-18.md'), 'utf8')).toContain('new work')
  })

  it('expires recent sections older than 7 days into archive.md', () => {
    const root = freshRoot()
    appendMemory(root, 1, 'a', 'ancient work', new Date('2026-08-01T10:00:00Z'))
    appendMemory(root, 1, 'a', 'today work', new Date('2026-08-18T10:00:00Z'))
    const dir = path.join(root, 'board-1')
    expect(fs.readFileSync(path.join(dir, 'archive.md'), 'utf8')).toContain('ancient work')
    expect(fs.readFileSync(path.join(dir, 'recent.md'), 'utf8')).not.toContain('ancient work')
  })

  it('truncates the injection from the top when over budget', () => {
    const root = freshRoot()
    for (let i = 0; i < 50; i++) appendMemory(root, 1, 'a', `entry ${i} ${'x'.repeat(200)}`, new Date('2026-08-18T10:00:00Z'))
    const injection = readMemoryInjection(root, 1, 2000)
    expect(injection.length).toBeLessThanOrEqual(2200) // header allowance
    expect(injection).toContain('entry 49')
    expect(injection).not.toContain('entry 0 ')
  })

  it('handoff round-trips once and archives itself', () => {
    const root = freshRoot()
    expect(consumeHandoff(root, 2)).toBeNull()
    writeHandoff(root, 2, 'violet-puffin', 'Next: publish to npm')
    const first = consumeHandoff(root, 2)
    expect(first).toContain('Next: publish to npm')
    expect(first).toContain('violet-puffin')
    expect(consumeHandoff(root, 2)).toBeNull()
    expect(fs.readFileSync(path.join(root, 'board-2', 'last-handoff.md'), 'utf8')).toContain('publish to npm')
  })
})
