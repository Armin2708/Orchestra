import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectIntegrations } from '../src/integrations.js'

const roots: string[] = []
const freshRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-integrations-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const statusFor = (root: string, id: string) => {
  const found = detectIntegrations(root).find((s) => s.id === id)
  if (!found) throw new Error(`no status for ${id}`)
  return found
}

describe('detectIntegrations', () => {
  it('always reports all three integrations in a stable order', () => {
    expect(detectIntegrations(freshRoot()).map((s) => s.id)).toEqual(['graphify', 'obsidian', 'gitnexus'])
  })

  it('reports every integration absent for an empty project', () => {
    const statuses = detectIntegrations(freshRoot())
    expect(statuses.map((s) => s.present)).toEqual([false, false, false])
    for (const status of statuses) {
      expect(status.detail.length).toBeGreaterThan(0)
      expect(status.enable_hint.length).toBeGreaterThan(0)
    }
  })

  it('detects graphify only when graph.json is a file under graphify-out', () => {
    const root = freshRoot()
    expect(statusFor(root, 'graphify').present).toBe(false)
    expect(statusFor(root, 'graphify').enable_hint).toMatch(/graphify/i)

    fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true })
    expect(statusFor(root, 'graphify').present).toBe(false)

    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), '{}')
    const present = statusFor(root, 'graphify')
    expect(present.present).toBe(true)
    expect(present.detail).toContain('graphify-out/graph.json')
  })

  it('detects gitnexus only when .gitnexus is a directory', () => {
    const root = freshRoot()
    expect(statusFor(root, 'gitnexus').present).toBe(false)
    expect(statusFor(root, 'gitnexus').enable_hint).toContain('gitnexus analyze')

    fs.writeFileSync(path.join(root, '.gitnexus'), 'not a directory')
    expect(statusFor(root, 'gitnexus').present).toBe(false)

    fs.rmSync(path.join(root, '.gitnexus'))
    fs.mkdirSync(path.join(root, '.gitnexus'))
    const present = statusFor(root, 'gitnexus')
    expect(present.present).toBe(true)
    expect(present.detail).toContain('.gitnexus')
  })

  it('detects an obsidian vault only when CLAUDE.md mentions one', () => {
    const root = freshRoot()
    expect(statusFor(root, 'obsidian').present).toBe(false)

    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Project\n\nRun the tests before committing.\n')
    const withoutVault = statusFor(root, 'obsidian')
    expect(withoutVault.present).toBe(false)
    expect(withoutVault.enable_hint).toContain('CLAUDE.md')

    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Project\n\nRecord decisions in the project Vault.\n')
    const present = statusFor(root, 'obsidian')
    expect(present.present).toBe(true)
    expect(present.detail).toContain('CLAUDE.md')
  })

  it('never leaks absolute paths or personal names into details or hints', () => {
    const root = freshRoot()
    fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true })
    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), '{}')
    fs.mkdirSync(path.join(root, '.gitnexus'))
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'vault notes live alongside this repo\n')
    for (const status of detectIntegrations(root)) {
      expect(status.present).toBe(true)
      expect(`${status.detail} ${status.enable_hint}`).not.toMatch(/\/Users\/|~\/|arminrad/i)
    }
  })
})
