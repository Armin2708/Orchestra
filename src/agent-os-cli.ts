import fs from 'node:fs'
import type { Command } from 'commander'

export type AgentOsApi = (method: string, path: string, body?: unknown) => Promise<any>

export interface AgentOsCliDeps {
  api: AgentOsApi
  ensureReady: () => Promise<void>
  resolveBoard: () => Promise<{ id: number }>
  output?: (line: string) => void
  readStdin?: () => string
}

const integer = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`expected an integer, received "${value}"`)
  return parsed
}

const decimal = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`expected a number, received "${value}"`)
  return parsed
}

const csv = (value?: string): string[] | undefined => value
  ?.split(',')
  .map((item) => item.trim())
  .filter(Boolean)

export function parseJsonOption<T>(value: string | undefined, label: string): T | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

const compact = <T extends Record<string, unknown>>(value: T): Partial<T> => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined),
) as Partial<T>

const arrayFrom = (value: any, keys: string[]): any[] => {
  if (Array.isArray(value)) return value
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key]
  return value == null ? [] : [value]
}

const summarize = (value: any): string => {
  if (value == null) return 'ok'
  if (typeof value !== 'object') return String(value)
  const fields = ['id', 'name', 'title', 'kind', 'provider', 'status', 'command', 'root_path', 'created_at']
  const parts = fields
    .filter((field) => value[field] !== undefined && value[field] !== null)
    .map((field) => `${field}=${JSON.stringify(value[field])}`)
  return parts.length ? parts.join(' ') : JSON.stringify(value)
}

export function registerAgentOsCommands(program: Command, deps: AgentOsCliDeps): void {
  const write = deps.output ?? console.log
  const stdin = deps.readStdin ?? (() => fs.readFileSync(0, 'utf8'))

  const ready = async () => {
    await deps.ensureReady()
  }

  const boardId = async (explicit?: number): Promise<number> => {
    await ready()
    return explicit ?? (await deps.resolveBoard()).id
  }

  const print = (value: any, json = false, keys: string[] = []): void => {
    if (json) {
      write(JSON.stringify(value, null, 2))
      return
    }
    const rows = keys.length ? arrayFrom(value, keys) : (Array.isArray(value) ? value : [value])
    if (!rows.length) {
      write('none')
      return
    }
    for (const row of rows) write(summarize(row))
  }

  const workspace = program.command('workspace').description('manage isolated Agent OS workspaces')
  workspace.command('list')
    .option('--board <id>', 'board id', integer)
    .option('--status <status>')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      const suffix = options.status ? `?status=${encodeURIComponent(options.status)}` : ''
      print(await deps.api('GET', `/os/boards/${id}/workspaces${suffix}`), options.json, ['workspaces'])
    })
  workspace.command('create <name>')
    .option('--board <id>', 'board id', integer)
    .option('--card <id>', 'linked card id', integer)
    .option('--kind <kind>', 'shared or worktree', 'worktree')
    .option('--root <path>', 'repository or execution root')
    .option('--branch <name>')
    .option('--base <ref>', 'base git ref')
    .option('--env <json>', 'environment overrides as JSON')
    .option('--json', 'print the complete response')
    .action(async (name, options) => {
      const id = await boardId(options.board)
      const body = compact({
        name,
        card_id: options.card,
        kind: options.kind,
        root_path: options.root,
        branch: options.branch,
        base_ref: options.base,
        env: parseJsonOption<Record<string, string>>(options.env, '--env'),
      })
      print(await deps.api('POST', `/os/boards/${id}/workspaces`, body), options.json)
    })
  workspace.command('show <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('GET', `/os/workspaces/${integer(id)}`), options.json)
    })
  workspace.command('update <id>')
    .option('--name <name>')
    .option('--status <status>')
    .option('--card <id>', 'linked card id', integer)
    .option('--env <json>', 'environment overrides as JSON')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      const body = compact({
        name: options.name,
        status: options.status,
        card_id: options.card,
        env: parseJsonOption<Record<string, string>>(options.env, '--env'),
      })
      print(await deps.api('PATCH', `/os/workspaces/${integer(id)}`, body), options.json)
    })
  workspace.command('archive <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('DELETE', `/os/workspaces/${integer(id)}`), options.json)
    })

  const processCommand = program.command('process').description('run and control real PTY processes')
  processCommand.command('list <workspace>')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, options) => {
      await ready()
      print(await deps.api('GET', `/os/workspaces/${integer(workspaceId)}/processes`), options.json, ['processes'])
    })
  processCommand.command('start <workspace> <command...>')
    .option('--name <name>', 'process label', 'terminal')
    .option('--cwd <path>')
    .option('--cols <number>', 'terminal columns', integer, 120)
    .option('--rows <number>', 'terminal rows', integer, 32)
    .option('--env <json>', 'environment overrides as JSON')
    .option('--no-restart', 'do not retain a restart recipe')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, command: string[], options) => {
      await ready()
      print(await deps.api('POST', `/os/workspaces/${integer(workspaceId)}/processes`, compact({
        name: options.name,
        command: command.join(' '),
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        env: parseJsonOption<Record<string, string>>(options.env, '--env'),
        restartable: options.restart,
      })), options.json)
    })
  processCommand.command('output <id>')
    .option('--after <seq>', 'only output after this sequence', integer, 0)
    .option('--json', 'print records instead of terminal bytes')
    .action(async (id, options) => {
      await ready()
      const result = await deps.api('GET', `/os/processes/${integer(id)}/output?after=${options.after}`)
      if (options.json) return print(result, true)
      const records = arrayFrom(result, ['output', 'records', 'chunks'])
      write(records.map((record) => typeof record === 'string' ? record : (record.data ?? '')).join(''))
    })
  processCommand.command('input <id> [text]')
    .option('--stdin', 'read exact input bytes from stdin')
    .option('--json', 'print the complete response')
    .action(async (id, text, options) => {
      await ready()
      const data = options.stdin ? stdin() : text
      if (data === undefined) throw new Error('input requires text or --stdin')
      print(await deps.api('POST', `/os/processes/${integer(id)}/input`, { data }), options.json)
    })
  processCommand.command('resize <id> <cols> <rows>')
    .option('--json', 'print the complete response')
    .action(async (id, cols, rows, options) => {
      await ready()
      print(await deps.api('POST', `/os/processes/${integer(id)}/resize`, {
        cols: integer(cols), rows: integer(rows),
      }), options.json)
    })
  processCommand.command('signal <id> [signal]')
    .option('--json', 'print the complete response')
    .action(async (id, signal, options) => {
      await ready()
      print(await deps.api('POST', `/os/processes/${integer(id)}/signal`, { signal: signal ?? 'SIGTERM' }), options.json)
    })

  const attention = program.command('attention').description('inspect and resolve items that need a human')
  attention.command('list')
    .option('--board <id>', 'board id', integer)
    .option('--status <status>', 'open, resolved, or all', 'open')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      print(await deps.api('GET', `/os/boards/${id}/attention?status=${encodeURIComponent(options.status)}`), options.json, ['attention'])
    })
  attention.command('resolve <id>')
    .option('--resolution <text>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/attention/${integer(id)}/resolve`, compact({ resolution: options.resolution })), options.json)
    })

  const contract = program.command('contract').description('manage executable task contracts')
  contract.command('show <card>')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      await ready()
      print(await deps.api('GET', `/os/cards/${integer(cardId)}/contract`), options.json)
    })
  contract.command('set <card>')
    .option('--objective <text>')
    .option('--accept <json>', 'acceptance criteria JSON array')
    .option('--depends <ids>', 'comma-separated card ids')
    .option('--verify <json>', 'verification command JSON array')
    .option('--base <ref>')
    .option('--priority <number>', 'higher runs first', integer)
    .option('--tokens <number>', 'token budget', integer)
    .option('--cost <number>', 'cost budget', decimal)
    .option('--policy <id>', 'policy id', integer)
    .option('--workspace <id>', 'workspace id', integer)
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      await ready()
      const dependencies = csv(options.depends)?.map(integer)
      print(await deps.api('PUT', `/os/cards/${integer(cardId)}/contract`, compact({
        objective: options.objective,
        acceptance_criteria: parseJsonOption<unknown[]>(options.accept, '--accept'),
        dependencies,
        verify_commands: parseJsonOption<string[]>(options.verify, '--verify'),
        base_ref: options.base,
        priority: options.priority,
        budget_tokens: options.tokens,
        budget_cents: options.cost,
        policy_id: options.policy,
        workspace_id: options.workspace,
      })), options.json)
    })

  const evidence = program.command('evidence').description('inspect or attach task evidence')
  evidence.command('list <card>')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      await ready()
      print(await deps.api('GET', `/os/cards/${integer(cardId)}/evidence`), options.json, ['artifacts', 'evidence'])
    })
  evidence.command('add <card> <kind> <name>')
    .option('--content <text>')
    .option('--file <path>', 'read artifact content from a file')
    .option('--mime <type>')
    .option('--metadata <json>')
    .option('--workspace <id>', 'workspace id', integer)
    .option('--json', 'print the complete response')
    .action(async (cardId, kind, name, options) => {
      await ready()
      if (options.file && options.content !== undefined) throw new Error('use either --file or --content')
      const content = options.file ? fs.readFileSync(options.file, 'utf8') : options.content
      print(await deps.api('POST', `/os/cards/${integer(cardId)}/evidence`, compact({
        kind,
        name,
        content,
        path: options.file,
        mime_type: options.mime,
        metadata: parseJsonOption<Record<string, unknown>>(options.metadata, '--metadata'),
        workspace_id: options.workspace,
      })), options.json)
    })

  const context = program.command('context').description('inspect or replace a workspace context manifest')
  context.command('show <workspace>')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, options) => {
      await ready()
      print(await deps.api('GET', `/os/workspaces/${integer(workspaceId)}/context`), options.json, ['context', 'items'])
    })
  context.command('set <workspace> <json>')
    .option('--json-output', 'print the complete response')
    .action(async (workspaceId, value, options) => {
      await ready()
      const items = parseJsonOption<unknown[]>(value, 'context')
      print(await deps.api('PUT', `/os/workspaces/${integer(workspaceId)}/context`, { items }), options.jsonOutput)
    })

  const checkpoint = program.command('checkpoint').description('create and safely fork durable checkpoints')
  checkpoint.command('list <workspace>')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, options) => {
      await ready()
      print(await deps.api('GET', `/os/workspaces/${integer(workspaceId)}/checkpoints`), options.json, ['checkpoints'])
    })
  checkpoint.command('create <workspace> <name>')
    .option('--context <json>')
    .option('--recipes <json>', 'restart recipe JSON array')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, name, options) => {
      await ready()
      print(await deps.api('POST', `/os/workspaces/${integer(workspaceId)}/checkpoints`, compact({
        name,
        context: parseJsonOption<Record<string, unknown>>(options.context, '--context'),
        process_recipes: parseJsonOption<unknown[]>(options.recipes, '--recipes'),
      })), options.json)
    })
  checkpoint.command('fork <id>')
    .requiredOption('--name <name>', 'new workspace name')
    .option('--path <path>', 'new worktree path')
    .option('--branch <name>', 'new branch')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/checkpoints/${integer(id)}/fork`, compact({
        name: options.name,
        worktree_path: options.path,
        branch: options.branch,
      })), options.json)
    })

  const job = program.command('job').description('schedule provider-neutral agent work')
  job.command('list')
    .option('--board <id>', 'board id', integer)
    .option('--status <status>')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      const suffix = options.status ? `?status=${encodeURIComponent(options.status)}` : ''
      print(await deps.api('GET', `/os/boards/${id}/jobs${suffix}`), options.json, ['jobs'])
    })
  job.command('create <card>')
    .option('--board <id>', 'board id', integer)
    .option('--workspace <id>', 'workspace id', integer)
    .option('--provider <name>', 'agent driver', 'claude')
    .option('--model <model>')
    .option('--priority <number>', 'higher runs first', integer)
    .option('--attempts <number>', 'maximum attempts', integer)
    .option('--tokens <number>', 'token budget', integer)
    .option('--cost <number>', 'cost budget', decimal)
    .option('--at <iso-time>', 'scheduled time')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      const id = await boardId(options.board)
      print(await deps.api('POST', `/os/boards/${id}/jobs`, compact({
        card_id: integer(cardId),
        workspace_id: options.workspace,
        provider: options.provider,
        model: options.model,
        priority: options.priority,
        max_attempts: options.attempts,
        budget_tokens: options.tokens,
        budget_cents: options.cost,
        scheduled_at: options.at,
      })), options.json)
    })
  job.command('cancel <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/jobs/${integer(id)}/cancel`), options.json)
    })

  const policy = program.command('policy').description('manage agent filesystem, command, network, and secret policy')
  policy.command('list')
    .option('--board <id>', 'board id', integer)
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      print(await deps.api('GET', `/os/boards/${id}/policies`), options.json, ['policies'])
    })
  policy.command('create <name>')
    .option('--board <id>', 'board id', integer)
    .option('--files <globs>', 'comma-separated filesystem globs')
    .option('--commands <globs>', 'comma-separated command globs')
    .option('--hosts <hosts>', 'comma-separated network hosts')
    .option('--secrets <names>', 'comma-separated secret names')
    .option('--approval <scope>', 'allow, ask, or deny', 'ask')
    .option('--json', 'print the complete response')
    .action(async (name, options) => {
      const id = await boardId(options.board)
      print(await deps.api('POST', `/os/boards/${id}/policies`, {
        name,
        file_globs: csv(options.files) ?? [],
        command_globs: csv(options.commands) ?? [],
        network_hosts: csv(options.hosts) ?? [],
        secret_names: csv(options.secrets) ?? [],
        approval_scope: options.approval,
      }), options.json)
    })
  policy.command('evaluate <id> <kind> <value>')
    .option('--json', 'print the complete response')
    .action(async (id, kind, value, options) => {
      await ready()
      print(await deps.api('POST', `/os/policies/${integer(id)}/evaluate`, { kind, value }), options.json)
    })

  program.command('events')
    .description('read the append-only Agent OS event stream')
    .option('--board <id>', 'board id', integer)
    .option('--after <id>', 'only events after this id', integer, 0)
    .option('--limit <number>', 'maximum events', integer, 100)
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      print(await deps.api('GET', `/os/boards/${id}/events?after=${options.after}&limit=${options.limit}`), options.json, ['events'])
    })

  program.command('conflicts')
    .description('show workspace and task conflicts')
    .option('--board <id>', 'board id', integer)
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      print(await deps.api('GET', `/os/boards/${id}/conflicts`), options.json, ['conflicts'])
    })

  program.command('drivers')
    .description('list installed agent provider drivers and capabilities')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      await ready()
      print(await deps.api('GET', '/os/drivers'), options.json, ['drivers'])
    })

  program.command('plugins')
    .description('list installed Agent OS plugins and capabilities')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      await ready()
      print(await deps.api('GET', '/os/plugins'), options.json, ['plugins'])
    })
}
