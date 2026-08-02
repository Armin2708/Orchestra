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
    service?: string
    composition_source?: string
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
      .toBe('3f8aed8a3b5af29c2dcbfaec634277cd32473034')
    expect(inventory.service_boundaries.map(({ name }) => name))
      .toEqual(AGENT_OS_DOMAIN_SERVICE_NAMES)
    expect(inventory.service_boundaries.map(({ implementation_state }) =>
      implementation_state)).toEqual([
      'canonical',
      'canonical',
      'canonical',
      'canonical',
      'canonical',
      'canonical',
      'canonical',
      'canonical',
      'canonical',
      'canonical',
    ])
    for (const boundary of inventory.service_boundaries) {
      expect(fs.existsSync(path.join(root, boundary.source))).toBe(true)
      expect(markdown).toContain(`| \`${boundary.name}\` |`)
      expect(contract).toContain(`| \`${boundary.name}\` |`)
    }
    expect(inventory.service_boundaries.at(-1)).toMatchObject({
      name: 'device_pairing',
      implementation_state: 'canonical',
      source: 'src/agent-os/device-sessions.ts',
      service: 'SqliteDeviceSessionRepository',
      composition_source: 'src/agent-os/service-boundaries.ts',
    })
    expect(contract).toContain('| `device_pairing` | `canonical` | `SqliteDeviceSessionRepository` |')
  })

  it('keeps implemented canonical domains out of the planned-only inventory', () => {
    const inventory = JSON.parse(
      read('docs/agent-os-surface-inventory.json'),
    ) as ServiceBoundaryInventory & {
      planned_not_implemented: Array<{ noun: string; reason: string }>
    }
    const planned = new Map(
      inventory.planned_not_implemented.map(({ noun, reason }) => [noun, reason]),
    )

    expect(planned.has('Discussion and DiscussionPost')).toBe(false)
    expect(planned.has('Conflict')).toBe(false)
    expect(planned.has('Knowledge compilation and operator surfaces')).toBe(false)
    expect(planned.has('DeviceSession')).toBe(false)
  })
})
