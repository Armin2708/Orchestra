import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
  AGENT_OS_COMPATIBILITY_FORWARD_PLAN,
  AGENT_OS_COMPATIBILITY_VALIDATION_QUERIES,
  compatibilityForwardPlanCoverage,
} from '../src/agent-os/compatibility-forward-migration.js'

type ForwardMigrationInventory = {
  observed_at_commit: string
  compatibility_forward_migration: {
    schema_version: number
    backlog_item: string
    code_head: string
    source: string
    migration_id: string
    prior_schema: string
    plan_entry_count: number
    validation_categories: string[]
    evidence_tables: string[]
    automatic_down_migration: boolean
  }
  table_sources: string[]
  database_tables: {
    infrastructure: string[]
  }
}

const CODE_HEAD = '74d632f46bfeaaead1c7a52ced8a317915baacbf'
const INVENTORY_HEAD = '11c1691654094e74dbe9fc53f073aa602e5ae7bb'
const VALIDATION_CATEGORIES = ['count', 'key', 'scope', 'lifecycle', 'hash']
const EVIDENCE_TABLES = [
  'os_compatibility_projection_links',
  'os_compatibility_projection_quarantine',
  'os_compatibility_migration_checks',
]
const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('Agent OS compatibility forward-migration documentation', () => {
  it('pins the machine inventory to the executable DOM-017 plan', () => {
    const inventory = JSON.parse(
      read('docs/agent-os-surface-inventory.json'),
    ) as ForwardMigrationInventory
    const coverage = compatibilityForwardPlanCoverage()

    expect(inventory.observed_at_commit).toBe(INVENTORY_HEAD)
    expect(inventory.compatibility_forward_migration).toEqual({
      schema_version: AGENT_OS_COMPATIBILITY_FORWARD_PLAN.schema_version,
      backlog_item: AGENT_OS_COMPATIBILITY_FORWARD_PLAN.backlog_item,
      code_head: CODE_HEAD,
      source: 'src/agent-os/compatibility-forward-migration.ts',
      migration_id: AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
      prior_schema: AGENT_OS_COMPATIBILITY_FORWARD_PLAN.prior_schema,
      plan_entry_count: AGENT_OS_COMPATIBILITY_FORWARD_PLAN.entries.length,
      validation_categories: VALIDATION_CATEGORIES,
      evidence_tables: EVIDENCE_TABLES,
      automatic_down_migration: false,
    })
    expect(coverage.actual).toEqual(coverage.expected)
    expect(coverage.actual).toHaveLength(13)
    expect(inventory.table_sources)
      .toContain(inventory.compatibility_forward_migration.source)
    expect(inventory.database_tables.infrastructure)
      .toEqual(expect.arrayContaining(EVIDENCE_TABLES))
  })

  it('documents executable validators, upgrade atomicity, and fail-closed replay', () => {
    const contract = read('docs/agent-os-forward-migrations.md')

    expect(contract).toContain(CODE_HEAD)
    expect(contract).toContain('all **13 / 13** compatibility and legacy')
    expect(AGENT_OS_COMPATIBILITY_VALIDATION_QUERIES.map((query) => query.id))
      .toEqual([
        'count.coverage',
        'key.exclusive_disposition',
        'scope.unquarantined_rows',
        'lifecycle.canonical_owner',
      ])
    for (const category of VALIDATION_CATEGORIES) {
      expect(contract).toContain(category)
    }
    for (const table of EVIDENCE_TABLES) {
      expect(contract).toContain(`\`${table}\``)
    }
    expect(contract).toMatch(/commit in one SQLite transaction/)
    expect(contract).toContain('marker-loss replay')
    expect(contract).toContain('fails closed')
  })

  it('defines a backup checkpoint and forward-only rollback without data loss', () => {
    const contract = read('docs/agent-os-forward-migrations.md')

    expect(contract).toContain('Create and verify an offline-consistent SQLite backup')
    expect(contract).toContain('There is **no automatic down migration**')
    expect(contract).toContain('Keep canonical writes, imported events, link evidence')
    expect(contract).toContain('Restore the pre-022 backup only as an explicit offline')
    expect(contract).toContain('DOM-019')
    expect(contract).toContain('reserved `agent_os.domain.canonical_ledger` control')
  })

  it('ships and links DOM-017 while reconciling the exact backlog state', () => {
    const packageManifest = JSON.parse(read('package.json')) as { files: string[] }
    const agentOs = read('docs/agent-os.md')
    const domain = read('docs/agent-os-domain.md')
    const inventory = read('docs/agent-os-surface-inventory.md')
    const program = read('docs/north-star-delivery-program.md')
    const checkpoint = read(
      'docs/checkpoints/2026-07-29-agent-os-dom017-forward-migrations.md',
    )

    expect(packageManifest.files).toContain('docs/agent-os-forward-migrations.md')
    expect(agentOs).toContain('[compatibility forward-migration and rollback contract]')
    expect(domain).toContain('[compatibility forward-migration contract]')
    expect(inventory).toContain('## Compatibility forward migration')
    expect(program).toContain('151 / 400 checklist boxes delivered; 249 remain open')
    expect(program).toContain('| Phase 1 — Canonical domain/event ledger | 20 / 20 | 0 |')
    expect(program).toContain('DOM-013` through `DOM-019`')
    expect(checkpoint).toContain('137 / 375 delivered; 238 open')
    expect(checkpoint).toContain('DOM-019 is the only open Phase 1 item')
    expect(checkpoint).toContain(CODE_HEAD)
  })
})
