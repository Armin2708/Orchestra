import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SERVER_COMPOSITION_CONTRACT } from '../src/server-composition.js'

type CompositionInventory = {
  observed_at_commit: string
  server_composition: {
    role: string
    source: string
    registrar: string
    registration_source: string
    owns: string[]
    excludes: string[]
  }
}

const INVENTORY_HEAD = 'fefec4c70810f1b5fd196835f0696fc2deaba8fe'
const DOM015_CODE_HEAD = '98c722f10357311d5c1dfdb4ca8e83228adc2b8c'
const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('Agent OS server composition documentation', () => {
  it('keeps the machine inventory aligned with the executable boundary', () => {
    const inventory = JSON.parse(
      read('docs/agent-os-surface-inventory.json'),
    ) as CompositionInventory

    expect(inventory.observed_at_commit).toBe(INVENTORY_HEAD)
    expect(inventory.server_composition).toEqual({
      role: SERVER_COMPOSITION_CONTRACT.role,
      source: 'src/server-composition.ts',
      registrar: SERVER_COMPOSITION_CONTRACT.canonical_route_registrar,
      registration_source: 'src/agent-os/routes.ts',
      owns: [...SERVER_COMPOSITION_CONTRACT.owns],
      excludes: [...SERVER_COMPOSITION_CONTRACT.excludes],
    })
    expect(fs.existsSync(path.join(root, inventory.server_composition.source))).toBe(true)
    expect(fs.existsSync(path.join(root, inventory.server_composition.registration_source)))
      .toBe(true)
  })

  it('records exact behavior-preservation evidence without claiming a route or schema change', () => {
    const contract = read('docs/agent-os-server-composition.md')

    expect(contract).toContain(DOM015_CODE_HEAD)
    expect(contract).toContain('1 file / 5 tests PASS')
    expect(contract).toContain('154 files / 1,228 tests PASS')
    expect(contract).toContain('changes no database schema, URL, status code, response envelope')
    expect(contract).toContain('DOM-016 still owns projection/compatibility-view design')
    expect(contract).toContain('TOOL-014 and BASE-010 remain open')
  })

  it('reconciles the exact backlog count and continuation point', () => {
    const checkpoint = read(
      'docs/checkpoints/2026-07-29-agent-os-dom015-buildserver-composition.md',
    )
    const program = read('docs/north-star-delivery-program.md')

    expect(checkpoint).toContain('135 / 375 delivered; 240 open')
    expect(checkpoint).toContain('DOM-016, DOM-017, and DOM-019 remain open')
    expect(checkpoint).toContain('DOM-016 is the next independent dependency-ready item')
    expect(program).toContain('176 / 400 checklist boxes delivered; 224 remain open')
    expect(program).toContain('| Phase 1 — Canonical domain/event ledger | 20 / 20 | 0 |')
    expect(program).toContain('DOM-013` through `DOM-019`')
  })

  it('keeps the human inventory explicit about composition ownership and exclusions', () => {
    const inventory = read('docs/agent-os-surface-inventory.md')

    expect(inventory).toContain('## Server composition boundary')
    expect(inventory).toContain('| Role | `composition_and_compatibility_routing` |')
    expect(inventory).toMatch(/neither module\s+constructs a canonical domain service/)
    expect(inventory).toContain('src/server-composition.ts:97')
    expect(inventory).toContain(INVENTORY_HEAD)
  })
})
