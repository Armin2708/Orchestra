import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_OS_DOMAIN_SERVICE_NAMES } from '../src/agent-os/service-boundaries.js'

type ServiceBoundaryInventory = {
  observed_at_commit: string
  service_boundaries: Array<{
    name: string
    implementation_state: string
    source: string
  }>
}

const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('Agent OS service boundary documentation', () => {
  it('keeps the machine-readable and human inventories aligned to the exact code head', () => {
    const inventory = JSON.parse(
      read('docs/agent-os-surface-inventory.json'),
    ) as ServiceBoundaryInventory
    const markdown = read('docs/agent-os-surface-inventory.md')
    const contract = read('docs/agent-os-service-boundaries.md')

    expect(inventory.observed_at_commit)
      .toBe('11c1691654094e74dbe9fc53f073aa602e5ae7bb')
    expect(inventory.service_boundaries.map(({ name }) => name))
      .toEqual(AGENT_OS_DOMAIN_SERVICE_NAMES)
    expect(inventory.service_boundaries.map(({ implementation_state }) =>
      implementation_state)).toEqual([
      'canonical',
      'canonical',
      'canonical',
      'reserved',
      'canonical',
      'compatibility_only',
      'reserved',
    ])
    for (const boundary of inventory.service_boundaries) {
      expect(fs.existsSync(path.join(root, boundary.source))).toBe(true)
      expect(markdown).toContain(`| \`${boundary.name}\` |`)
      expect(contract).toContain(`| \`${boundary.name}\` |`)
    }
  })

  it('does not promote reserved or partial foundations into completed product domains', () => {
    const inventory = JSON.parse(
      read('docs/agent-os-surface-inventory.json'),
    ) as ServiceBoundaryInventory & {
      planned_not_implemented: Array<{ noun: string; reason: string }>
    }
    const planned = new Map(
      inventory.planned_not_implemented.map(({ noun, reason }) => [noun, reason]),
    )

    expect(planned.get('Discussion and DiscussionPost')).toMatch(/not a durable searchable Q&A/)
    expect(planned.get('Conflict')).toMatch(/not a durable resolution lifecycle/)
    expect(planned.get('Knowledge compilation and operator surfaces'))
      .toMatch(/managed prompt injection/)
    expect(planned.get('DeviceSession')).toMatch(/credentials do not exist/)
  })
})
