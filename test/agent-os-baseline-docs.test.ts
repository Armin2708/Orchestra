import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'

type Classification = 'canonical' | 'compatibility' | 'legacy' | 'infrastructure'

type BaselineInventory = {
  observed_at_commit: string
  database_tables: Record<Classification, string[]>
  route_sources: Array<{ file: string; prefix: string }>
  http_routes: Record<Classification, string[]>
  cli_sources: string[]
  cli_commands: Record<Classification, string[]>
  event_vocabularies: {
    conversation_event_kinds: string[]
    message_kinds: string[]
    agent_home_session_actions: string[]
    driver_event_types: string[]
    runtime_event_kinds: string[]
    workspace_event_kinds: string[]
    legacy_bus_event_types: string[]
    canonical_bus_event_types: string[]
  }
  ui_surfaces: Array<{
    id: string
    classification: Classification
    file: string
    evidence: string
  }>
}

const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const inventory = JSON.parse(read('docs/agent-os-surface-inventory.json')) as BaselineInventory
const classifications: Classification[] = ['canonical', 'compatibility', 'legacy', 'infrastructure']
const flatten = (groups: Record<Classification, string[]>) =>
  classifications.flatMap((classification) => groups[classification])
const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort()
const commandName = (signature: string) => signature.trim().split(/\s+/)[0]
const quoted = (value: string) => [...value.matchAll(/'([^']+)'/g)].map((match) => match[1])

const literalArray = (source: string, name: string): string[] => {
  const match = source.match(new RegExp(`${name}\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`))
  if (!match) throw new Error(`could not find ${name}`)
  return quoted(match[1])
}

const typeBody = (source: string, start: RegExp, end: RegExp): string => {
  const from = source.search(start)
  if (from < 0) throw new Error(`could not find ${start}`)
  const remaining = source.slice(from)
  const until = remaining.search(end)
  if (until < 0) throw new Error(`could not find ${end} after ${start}`)
  return remaining.slice(0, until)
}

function registeredRoutes(): string[] {
  const routes: string[] = []
  const actions = inventory.event_vocabularies.agent_home_session_actions
  const pattern =
    /(?:server|app)\.(get|post|put|patch|delete)(?:<[\s\S]*?>)?\(\s*(["'`])(\/[^"'`]+)\2/g

  for (const source of inventory.route_sources) {
    const text = read(source.file)
    for (const match of text.matchAll(pattern)) {
      const method = match[1].toUpperCase()
      const localPath = match[3]
      const paths = localPath.includes('${action}')
        ? actions.map((action) => localPath.replace('${action}', action))
        : [localPath]
      for (const route of paths) routes.push(`${method} ${source.prefix}${route}`)
    }
  }
  return sortedUnique(routes)
}

function registeredCliCommands(): string[] {
  const commands = new Set<string>()
  for (const file of inventory.cli_sources) {
    const source = read(file)
    const parents = new Map<string, string>()
    for (const match of source.matchAll(
      /const\s+(\w+)\s*=\s*program\.command\('([^']+)'\)/g,
    )) {
      parents.set(match[1], commandName(match[2]))
    }
    for (const match of source.matchAll(/program\.command\('([^']+)'\)/g)) {
      commands.add(commandName(match[1]))
    }
    for (const match of source.matchAll(/(\w+)\.command\('([^']+)'\)/g)) {
      const parent = parents.get(match[1])
      if (parent) commands.add(`${parent} ${commandName(match[2])}`)
    }
  }
  for (const action of inventory.event_vocabularies.agent_home_session_actions) {
    commands.add(`session ${action}`)
  }
  return sortedUnique(commands)
}

describe('Agent OS baseline documentation drift', () => {
  it('matches every live application table exactly and classifies each once', () => {
    const expected = flatten(inventory.database_tables)
    expect(expected).toHaveLength(new Set(expected).size)
    const db = openDb(':memory:')
    try {
      const actual = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all().map((row) => String((row as { name: string }).name))
      expect(actual).toEqual([...expected].sort())
    } finally {
      db.close()
    }
  })

  it('matches every registered HTTP route exactly and classifies each once', () => {
    const expected = flatten(inventory.http_routes)
    expect(expected).toHaveLength(new Set(expected).size)
    expect(registeredRoutes()).toEqual([...expected].sort())
    const documented = read('docs/agent-os-surface-inventory.md').split('\n')
      .filter((line) => /^(?:DELETE|GET|PATCH|POST|PUT) \//.test(line))
    expect(documented.sort()).toEqual([...expected].sort())
    expect(inventory.http_routes.canonical.every((route) =>
      route.split(' ')[1].startsWith('/api/v1/os/'))).toBe(true)
  })

  it('matches every registered CLI command family and subcommand exactly', () => {
    const expected = flatten(inventory.cli_commands)
    expect(expected).toHaveLength(new Set(expected).size)
    expect(registeredCliCommands()).toEqual([...expected].sort())
  })

  it('keeps the closed event vocabularies source-backed', () => {
    const conversations = read('src/agent-os/conversations.ts')
    const server = read('src/server.ts')
    const lifecycle = read('src/agent-os/agent-home-lifecycle.ts')
    const runtime = read('src/runtime/types.ts')

    expect(literalArray(conversations, 'CONVERSATION_EVENT_KINDS'))
      .toEqual(inventory.event_vocabularies.conversation_event_kinds)
    expect(literalArray(server, 'MESSAGE_KINDS'))
      .toEqual(inventory.event_vocabularies.message_kinds)
    expect(literalArray(lifecycle, 'AGENT_HOME_SESSION_ACTIONS'))
      .toEqual(inventory.event_vocabularies.agent_home_session_actions)

    const workspaceBlock = typeBody(
      runtime,
      /export type WorkspaceEvent\s*=/,
      /\n\nexport type ProcessStatus/,
    )
    const runtimeBlock = typeBody(
      runtime,
      /export type RuntimeEventKind\s*=/,
      /\n\nexport type RuntimeEvent\s*=/,
    )
    const driverBlock = typeBody(
      runtime,
      /export type DriverEvent\s*=/,
      /\n\nexport interface AgentDriver/,
    )
    expect(quoted(workspaceBlock).filter((value) => value.startsWith('workspace.')))
      .toEqual(inventory.event_vocabularies.workspace_event_kinds)
    expect(quoted(runtimeBlock))
      .toEqual(inventory.event_vocabularies.runtime_event_kinds)
    expect(quoted(driverBlock))
      .toEqual(inventory.event_vocabularies.driver_event_types)
  })

  it('keeps legacy and canonical live-bus event names source-backed', () => {
    const legacy = `${read('src/server.ts')}\n${read('src/conductor.ts')}`
    const legacyTypes = sortedUnique(
      [...legacy.matchAll(/(?:this\.)?emit\([^,\n]+,\s*'([^']+)'/g)]
        .map((match) => match[1]),
    )
    const canonicalTypes = sortedUnique(
      [...read('src/agent-os/runtime-integration.ts').matchAll(/type:\s*'(os:[^']+)'/g)]
        .map((match) => match[1]),
    )
    expect(legacyTypes).toEqual([...inventory.event_vocabularies.legacy_bus_event_types].sort())
    expect(canonicalTypes).toEqual([...inventory.event_vocabularies.canonical_bus_event_types].sort())
  })

  it('keeps every documented UI surface tied to a current source marker', () => {
    const ids = inventory.ui_surfaces.map((surface) => surface.id)
    expect(ids).toHaveLength(new Set(ids).size)
    for (const surface of inventory.ui_surfaces) {
      expect(
        read(surface.file),
        `${surface.id} no longer has evidence ${JSON.stringify(surface.evidence)} in ${surface.file}`,
      ).toContain(surface.evidence)
    }
  })
})
