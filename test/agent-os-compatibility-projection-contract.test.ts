import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_OS_LEGACY_AUTHORITY_MODES,
  AGENT_OS_LEGACY_COMPATIBILITY_TABLES,
  AGENT_OS_LEGACY_PROJECTION_CONTRACT,
  AGENT_OS_LEGACY_TARGET_DISPOSITIONS,
} from '../src/agent-os/compatibility-projection-contract.js'

type SurfaceInventory = {
  database_tables: {
    canonical: string[]
    compatibility: string[]
    legacy: string[]
  }
}

const root = join(import.meta.dirname, '..')
const inventory = JSON.parse(
  readFileSync(join(root, 'docs/agent-os-surface-inventory.json'), 'utf8'),
) as SurfaceInventory

describe('Agent OS legacy compatibility projection contract', () => {
  it('covers every compatibility and legacy table exactly once', () => {
    const expected = [
      ...inventory.database_tables.compatibility,
      ...inventory.database_tables.legacy,
    ].sort()
    const actual = AGENT_OS_LEGACY_PROJECTION_CONTRACT.tables
      .map(({ table }) => table)
      .sort()

    expect(actual).toEqual(expected)
    expect(new Set(actual).size).toBe(actual.length)
    expect(new Set(AGENT_OS_LEGACY_COMPATIBILITY_TABLES))
      .toEqual(new Set(expected))
  })

  it('freezes one versioned handoff from design to migration and telemetry', () => {
    expect(AGENT_OS_LEGACY_PROJECTION_CONTRACT).toMatchObject({
      schema_version: 1,
      backlog_item: 'DOM-016',
      migration_owner: 'DOM-017',
      telemetry_owner: 'DOM-019',
    })
    expect(Object.isFrozen(AGENT_OS_LEGACY_PROJECTION_CONTRACT)).toBe(true)
    expect(Object.isFrozen(AGENT_OS_LEGACY_PROJECTION_CONTRACT.invariants)).toBe(true)
    expect(Object.isFrozen(AGENT_OS_LEGACY_PROJECTION_CONTRACT.tables)).toBe(true)
    for (const entry of AGENT_OS_LEGACY_PROJECTION_CONTRACT.tables) {
      expect(Object.isFrozen(entry), entry.table).toBe(true)
      expect(Object.isFrozen(entry.canonical_tables), entry.table).toBe(true)
      expect(Object.isFrozen(entry.not_authoritative_for), entry.table).toBe(true)
      expect(entry.read_boundary.trim(), entry.table).not.toBe('')
      expect(entry.write_boundary.trim(), entry.table).not.toBe('')
      expect(entry.cutover_gate.trim(), entry.table).not.toBe('')
    }
  })

  it('permits no unnamed mode or dual-authoritative cutover', () => {
    const canonical = new Set(inventory.database_tables.canonical)
    const modes = new Set(AGENT_OS_LEGACY_AUTHORITY_MODES)
    const dispositions = new Set(AGENT_OS_LEGACY_TARGET_DISPOSITIONS)

    for (const entry of AGENT_OS_LEGACY_PROJECTION_CONTRACT.tables) {
      expect(modes.has(entry.current_mode), entry.table).toBe(true)
      expect(dispositions.has(entry.target_disposition), entry.table).toBe(true)
      expect(
        entry.canonical_tables.every((table) => canonical.has(table)),
        entry.table,
      ).toBe(true)
      expect(
        JSON.stringify(entry).toLowerCase(),
        entry.table,
      ).not.toContain('dual authoritative')

      if ([
        'scope_partitioned_bridge',
        'projection_sink',
        'legacy_event_ingress',
      ].includes(entry.current_mode)) {
        expect(entry.canonical_tables.length, entry.table).toBeGreaterThan(0)
        expect(entry.canonical_owned_scope, entry.table).not.toBeNull()
      }
      if (entry.current_mode === 'isolated_legacy_domain') {
        expect(entry.canonical_tables, entry.table).toEqual([])
        expect(entry.canonical_owned_scope, entry.table).toBeNull()
        expect([
          'retain_distinct_semantics',
          'retire_after_replacement',
        ]).toContain(entry.target_disposition)
      }
    }
  })

  it('pins the critical split-authority and naming boundaries', () => {
    const entries = new Map(
      AGENT_OS_LEGACY_PROJECTION_CONTRACT.tables
        .map((entry) => [entry.table, entry]),
    )

    expect(entries.get('boards')).toMatchObject({
      current_mode: 'shared_scope',
      target_disposition: 'retain_shared_scope',
      canonical_tables: [],
    })
    expect(entries.get('task_contracts')).toMatchObject({
      current_mode: 'compatibility_authority',
      target_disposition: 'canonical_command_adapter',
    })
    expect(entries.get('task_contracts')?.read_boundary)
      .toContain('one card identity')

    expect(entries.get('cards')).toMatchObject({
      current_mode: 'scope_partitioned_bridge',
      canonical_tables: [
        'job_market_assignments',
        'job_market_contracts',
        'jobs',
        'delivery_reports',
      ],
    })
    expect(entries.get('cards')?.not_authoritative_for)
      .toContain('active assignment')
    expect(entries.get('agents')?.not_authoritative_for)
      .toContain('managed profile identity')
    expect(entries.get('card_events')).toMatchObject({
      current_mode: 'legacy_event_ingress',
      canonical_tables: ['os_events'],
    })
    expect(entries.get('messages')?.not_authoritative_for)
      .toContain('Discussion')
    expect(entries.get('deliveries')?.not_authoritative_for)
      .toContain('Delivery')
    expect(entries.get('token_telemetry')?.not_authoritative_for)
      .toContain('provider usage')
  })
})
