import { randomUUID } from 'node:crypto'
import type { Command } from 'commander'
import type { AgentOsCliDeps } from './agent-os-cli.js'

const integer = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`expected an integer, received "${value}"`)
  return parsed
}

const positiveInteger = (value: string): number => {
  const parsed = integer(value)
  if (parsed < 1) throw new Error(`expected a positive integer, received "${value}"`)
  return parsed
}

const opaqueId = (value: string): string => {
  const id = value.trim()
  if (!id) throw new Error('resource id cannot be empty')
  return id
}

const segment = (value: string): string => encodeURIComponent(opaqueId(value))

const compact = <T extends Record<string, unknown>>(value: T): Partial<T> => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined),
) as Partial<T>

const commandKey = (scope: string, explicit?: string): string =>
  explicit?.trim() || `orchestra-cli:${scope}:${randomUUID()}`

const rowsFrom = (value: any, keys: string[]): any[] => {
  if (Array.isArray(value)) return value
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key]
    if (value != null && Object.prototype.hasOwnProperty.call(value, key)) {
      return value[key] == null ? [] : [value[key]]
    }
  }
  return value == null ? [] : [value]
}

const summarize = (value: any): string => {
  if (value == null) return 'none'
  if (typeof value !== 'object') return String(value)
  const fields = [
    'id',
    'card_id',
    'status',
    'origin',
    'profile_id',
    'workspace_id',
    'assigned_market_version',
    'version',
    'created_at',
  ]
  const parts = fields
    .filter((field) => value[field] !== undefined && value[field] !== null)
    .map((field) => `${field}=${JSON.stringify(value[field])}`)
  return parts.length ? parts.join(' ') : JSON.stringify(value)
}

/** Register canonical Job Market assignment commands under the existing `job` command. */
export function registerJobAssignmentCommands(job: Command, deps: AgentOsCliDeps): void {
  const write = deps.output ?? console.log
  const ready = async (): Promise<void> => {
    await deps.ensureReady()
  }
  const boardId = async (explicit?: number): Promise<number> => {
    await ready()
    return explicit ?? (await deps.resolveBoard()).id
  }
  const print = (value: any, json: boolean, keys: string[]): void => {
    if (json) {
      write(JSON.stringify(value, null, 2))
      return
    }
    const rows = rowsFrom(value, keys)
    if (rows.length === 0) {
      write('none')
      return
    }
    for (const row of rows) write(summarize(row))
  }

  const assignment = job.command('assignment')
    .description('inspect and manage canonical Job Market ownership')

  assignment.command('list [card]')
    .description('list board assignments or one card assignment history')
    .option('--board <id>', 'board id', positiveInteger)
    .option('--status <status>', 'assignment status')
    .option('--profile <id>', 'assigned profile id')
    .option('--workspace <id>', 'workspace id')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      if (cardId !== undefined) {
        await ready()
        print(
          await deps.api('GET', `/os/cards/${positiveInteger(cardId)}/assignments`),
          options.json,
          ['assignments'],
        )
        return
      }
      const id = await boardId(options.board)
      const query = new URLSearchParams()
      if (options.status) query.set('status', opaqueId(options.status))
      if (options.profile) query.set('profile_id', opaqueId(options.profile))
      if (options.workspace) query.set('workspace_id', opaqueId(options.workspace))
      const suffix = query.size > 0 ? `?${query}` : ''
      print(
        await deps.api('GET', `/os/boards/${id}/assignments${suffix}`),
        options.json,
        ['assignments'],
      )
    })

  assignment.command('current <card>')
    .description('show the active assignment for a card')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      await ready()
      print(
        await deps.api('GET', `/os/cards/${positiveInteger(cardId)}/assignments/current`),
        options.json,
        ['assignment'],
      )
    })

  assignment.command('claim <card> <profile>')
    .description('claim an open Job Market contract')
    .requiredOption(
      '--expected-market-version <version>',
      'market version used for compare-and-set',
      positiveInteger,
    )
    .option('--workspace <id>', 'execution workspace id')
    .option('--reason <text>', 'human-readable assignment reason')
    .option('--idempotency <key>', 'safely replay this command')
    .option('--json', 'print the complete response')
    .action(async (cardId, profileId, options) => {
      await ready()
      const card = positiveInteger(cardId)
      const profile = opaqueId(profileId)
      print(await deps.api('POST', `/os/cards/${card}/assignments/claim`, compact({
        profile_id: profile,
        workspace_id: options.workspace === undefined ? undefined : opaqueId(options.workspace),
        expected_market_version: options.expectedMarketVersion,
        reason: options.reason,
        idempotency_key: commandKey(
          `job-assignment-claim:${card}:${profile}`,
          options.idempotency,
        ),
      })), options.json, ['assignment'])
    })

  assignment.command('assign <card> <profile>')
    .description('assign an open Job Market contract')
    .requiredOption(
      '--expected-market-version <version>',
      'market version used for compare-and-set',
      positiveInteger,
    )
    .option('--workspace <id>', 'execution workspace id')
    .option('--reason <text>', 'human-readable assignment reason')
    .option('--idempotency <key>', 'safely replay this command')
    .option('--json', 'print the complete response')
    .action(async (cardId, profileId, options) => {
      await ready()
      const card = positiveInteger(cardId)
      const profile = opaqueId(profileId)
      print(await deps.api('POST', `/os/cards/${card}/assignments/assign`, compact({
        profile_id: profile,
        workspace_id: options.workspace === undefined ? undefined : opaqueId(options.workspace),
        expected_market_version: options.expectedMarketVersion,
        reason: options.reason,
        idempotency_key: commandKey(
          `job-assignment-assign:${card}:${profile}`,
          options.idempotency,
        ),
      })), options.json, ['assignment'])
    })

  assignment.command('release <card> <assignment>')
    .description('release the active assignment for a card')
    .requiredOption(
      '--expected-market-version <version>',
      'market version used for compare-and-set',
      positiveInteger,
    )
    .requiredOption(
      '--expected-assignment-version <version>',
      'assignment version used for compare-and-set',
      positiveInteger,
    )
    .option('--reason <text>', 'human-readable release reason')
    .option('--idempotency <key>', 'safely replay this command')
    .option('--json', 'print the complete response')
    .action(async (cardId, assignmentId, options) => {
      await ready()
      const card = positiveInteger(cardId)
      const id = opaqueId(assignmentId)
      print(
        await deps.api('POST', `/os/cards/${card}/assignments/${segment(id)}/release`, compact({
          expected_market_version: options.expectedMarketVersion,
          expected_assignment_version: options.expectedAssignmentVersion,
          reason: options.reason,
          idempotency_key: commandKey(`job-assignment-release:${card}:${id}`, options.idempotency),
        })),
        options.json,
        ['assignment'],
      )
    })

  assignment.command('reassign <card> <assignment> <profile>')
    .description('move the active assignment to another profile')
    .requiredOption(
      '--expected-market-version <version>',
      'market version used for compare-and-set',
      positiveInteger,
    )
    .requiredOption(
      '--expected-assignment-version <version>',
      'assignment version used for compare-and-set',
      positiveInteger,
    )
    .option('--workspace <id>', 'execution workspace id')
    .option('--reason <text>', 'human-readable reassignment reason')
    .option('--idempotency <key>', 'safely replay this command')
    .option('--json', 'print the complete response')
    .action(async (cardId, assignmentId, profileId, options) => {
      await ready()
      const card = positiveInteger(cardId)
      const id = opaqueId(assignmentId)
      const profile = opaqueId(profileId)
      print(
        await deps.api('POST', `/os/cards/${card}/assignments/${segment(id)}/reassign`, compact({
          profile_id: profile,
          workspace_id: options.workspace === undefined ? undefined : opaqueId(options.workspace),
          expected_market_version: options.expectedMarketVersion,
          expected_assignment_version: options.expectedAssignmentVersion,
          reason: options.reason,
          idempotency_key: commandKey(
            `job-assignment-reassign:${card}:${id}:${profile}`,
            options.idempotency,
          ),
        })),
        options.json,
        ['assignment'],
      )
    })
}
