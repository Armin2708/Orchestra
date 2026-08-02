import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_OS_LEGACY_AUTHORITY_MODES,
  AGENT_OS_LEGACY_PROJECTION_CONTRACT,
  AGENT_OS_LEGACY_TARGET_DISPOSITIONS,
} from '../src/agent-os/compatibility-projection-contract.js'

type ProjectionInventory = {
  observed_at_commit: string
  legacy_projection_contract: {
    schema_version: number
    backlog_item: string
    code_head: string
    source: string
    migration_owner: string
    telemetry_owner: string
    table_count: number
    authority_modes: string[]
    target_dispositions: string[]
  }
}

const INVENTORY_HEAD = '364967d'
const CODE_HEAD = 'f5df13666ccdfdf552e423a379faf60463fc6643'
const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('Agent OS compatibility projection documentation', () => {
  it('aligns the machine inventory with the executable contract at one code head', () => {
    const inventory = JSON.parse(
      read('docs/agent-os-surface-inventory.json'),
    ) as ProjectionInventory

    expect(inventory.observed_at_commit).toBe(INVENTORY_HEAD)
    expect(inventory.legacy_projection_contract).toEqual({
      schema_version: AGENT_OS_LEGACY_PROJECTION_CONTRACT.schema_version,
      backlog_item: AGENT_OS_LEGACY_PROJECTION_CONTRACT.backlog_item,
      code_head: CODE_HEAD,
      source: 'src/agent-os/compatibility-projection-contract.ts',
      migration_owner: AGENT_OS_LEGACY_PROJECTION_CONTRACT.migration_owner,
      telemetry_owner: AGENT_OS_LEGACY_PROJECTION_CONTRACT.telemetry_owner,
      table_count: AGENT_OS_LEGACY_PROJECTION_CONTRACT.tables.length,
      authority_modes: [...AGENT_OS_LEGACY_AUTHORITY_MODES],
      target_dispositions: [...AGENT_OS_LEGACY_TARGET_DISPOSITIONS],
    })
    expect(fs.existsSync(path.join(
      root,
      inventory.legacy_projection_contract.source,
    ))).toBe(true)
  })

  it('documents every table and keeps logical design separate from physical cutover', () => {
    const contract = read('docs/agent-os-compatibility-projections.md')

    expect(contract).toContain(CODE_HEAD)
    expect(contract).toContain('all **13 / 13** such tables')
    for (const entry of AGENT_OS_LEGACY_PROJECTION_CONTRACT.tables) {
      expect(contract, entry.table).toContain(`| \`${entry.table}\` |`)
    }
    expect(contract).toContain('does **not** create SQLite views')
    expect(contract).toMatch(/DOM-017 owns those\s+physical changes/)
    expect(contract).toContain('DOM-019 owns old-versus-canonical read/write telemetry')
  })

  it('does not relabel distinct legacy semantics as unfinished canonical domains', () => {
    const contract = read('docs/agent-os-compatibility-projections.md')

    expect(contract).toContain('`messages` is low-level wake/coordination transport, not Discussion')
    expect(contract).toContain('`deliveries` is a message receipt, not a verified or accepted work Delivery')
    expect(contract).toContain('`token_telemetry` estimates injected context, not provider-native usage')
    expect(contract).toContain('`cards.owner_agent_id` is a presentation projection')
    expect(contract).toMatch(/They\s+are not a second contract selected by update time/)
  })

  it('ships and links the contract while reconciling the backlog truth', () => {
    const packageManifest = JSON.parse(read('package.json')) as { files: string[] }
    const agentOs = read('docs/agent-os.md')
    const domain = read('docs/agent-os-domain.md')
    const inventory = read('docs/agent-os-surface-inventory.md')
    const program = read('docs/north-star-delivery-program.md')
    const checkpoint = read(
      'docs/checkpoints/2026-07-29-agent-os-dom016-legacy-projections.md',
    )

    expect(packageManifest.files)
      .toContain('docs/agent-os-compatibility-projections.md')
    expect(agentOs).toContain('[legacy projection and compatibility-view contract]')
    expect(domain).toContain('[legacy projection contract]')
    expect(inventory).toContain('## Legacy projection and compatibility-view contract')
    expect(program).toContain('176 / 400 checklist boxes delivered; 224 remain open')
    expect(program).toContain('| Phase 1 — Canonical domain/event ledger | 20 / 20 | 0 |')
    expect(checkpoint).toContain('136 / 375 delivered; 239 open')
    expect(checkpoint).toContain('DOM-017 and DOM-019 remain open')
  })
})
