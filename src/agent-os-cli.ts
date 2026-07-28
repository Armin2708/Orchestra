import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Command } from 'commander'
import { registerJobAssignmentCommands } from './job-assignment-cli.js'

export type AgentOsApi = (method: string, path: string, body?: unknown) => Promise<any>

export interface AgentOsCliDeps {
  api: AgentOsApi
  ensureReady: () => Promise<void>
  resolveBoard: () => Promise<{ id: number }>
  output?: (line: string) => void
  readStdin?: () => string
  attachProcess?: (id: string) => Promise<void>
}

const terminalStatuses = new Set(['stopped', 'exited', 'failed', 'lost'])

/** Attach the local terminal to a managed PTY over the same durable HTTP byte stream as the cockpit. */
export async function attachManagedProcess(api: AgentOsApi, id: string): Promise<void> {
  const input = process.stdin
  const output = process.stdout
  let after = 0
  let detached = false
  let inputError: unknown
  let inputQueue = Promise.resolve()
  const wasRaw = Boolean(input.isTTY && input.isRaw)
  const send = (data: Buffer) => {
    if (data.length === 0) return
    inputQueue = inputQueue.then(() => api('POST', `/os/processes/${segment(id)}/input`, { data: data.toString('utf8') }))
      .catch((error) => { inputError = error; detached = true })
  }
  const onData = (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const detachAt = data.indexOf(0x1d) // Ctrl+] mirrors ssh/telnet-style detach controls.
    if (detachAt >= 0) {
      send(data.subarray(0, detachAt))
      detached = true
      return
    }
    send(data)
  }
  const resize = () => {
    const cols = output.columns
    const rows = output.rows
    if (cols && rows) void api('POST', `/os/processes/${segment(id)}/resize`, { cols, rows }).catch(() => undefined)
  }

  if (input.isTTY) input.setRawMode(true)
  input.on('data', onData)
  input.resume()
  process.on('SIGWINCH', resize)
  resize()
  output.write('\r\n[attached · Ctrl+] detaches]\r\n')
  try {
    while (!detached) {
      const page = await api('GET', `/os/processes/${segment(id)}/output?after=${after}`)
      const records = arrayFrom(page, ['output', 'records', 'chunks'])
      for (const record of records) output.write(typeof record === 'string' ? record : String(record.data ?? ''))
      const explicit = Number(page?.next_seq ?? page?.nextSeq)
      if (Number.isFinite(explicit)) after = explicit
      else for (const record of records) after = Math.max(after, Number(record?.seq) || 0)
      const detail = await api('GET', `/os/processes/${segment(id)}`)
      const status = String(detail?.process?.status ?? detail?.status ?? '')
      if (terminalStatuses.has(status)) break
      await new Promise((resolve) => setTimeout(resolve, records.length > 0 ? 10 : 120))
    }
    await inputQueue
    if (inputError) throw inputError
  } finally {
    input.off('data', onData)
    process.off('SIGWINCH', resize)
    if (input.isTTY) input.setRawMode(wasRaw)
    input.pause()
    output.write('\r\n[detached]\r\n')
  }
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

const opaqueId = (value: string): string => {
  const id = value.trim()
  if (!id) throw new Error('resource id cannot be empty')
  return id
}

const segment = (value: string): string => encodeURIComponent(opaqueId(value))

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

const commandKey = (scope: string, explicit?: string): string =>
  explicit?.trim() || `orchestra-cli:${scope}:${randomUUID()}`

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
  const attach = deps.attachProcess ?? ((id: string) => attachManagedProcess(deps.api, id))

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

  const agent = program.command('agent').description('manage durable Agent Home identities')
  agent.command('list')
    .option('--board <id>', 'board id', integer)
    .option('--archived', 'include archived profiles')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      const suffix = options.archived ? '?archived=true' : ''
      print(
        await deps.api('GET', `/os/boards/${id}/agent-profiles${suffix}`),
        options.json,
        ['profiles'],
      )
    })
  agent.command('create <name>')
    .option('--board <id>', 'board id', integer)
    .option('--role <role>')
    .option('--provider <provider>')
    .option('--model <model>')
    .option('--effort <effort>')
    .option('--access <profile>')
    .option('--capabilities <items>', 'comma-separated capabilities')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (name, options) => {
      const id = await boardId(options.board)
      print(await deps.api('POST', `/os/boards/${id}/agent-profiles`, compact({
        name,
        role: options.role,
        default_provider: options.provider,
        default_model: options.model,
        default_effort: options.effort,
        default_access_profile: options.access,
        capabilities: csv(options.capabilities),
        idempotency_key: commandKey(`agent-create:${id}:${name}`, options.idempotency),
      })), options.json, ['profile'])
    })
  agent.command('show <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('GET', `/os/agent-profiles/${segment(id)}`), options.json, ['profile'])
    })
  agent.command('home <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('GET', `/os/agent-profiles/${segment(id)}/home`), options.json, ['home'])
    })
  agent.command('rename <id> <name>')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (id, name, options) => {
      await ready()
      print(await deps.api('PATCH', `/os/agent-profiles/${segment(id)}`, {
        name,
        idempotency_key: commandKey(`agent-rename:${id}`, options.idempotency),
      }), options.json, ['profile'])
    })
  agent.command('archive <id>')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/agent-profiles/${segment(id)}/archive`, {
        idempotency_key: commandKey(`agent-archive:${id}`, options.idempotency),
      }), options.json, ['profile'])
    })

  const session = program.command('session').description('inspect and control durable provider sessions')
  session.command('list <agent-id>')
    .option('--json', 'print the complete response')
    .action(async (agentId, options) => {
      await ready()
      print(
        await deps.api('GET', `/os/agent-profiles/${segment(agentId)}/sessions`),
        options.json,
        ['sessions'],
      )
    })
  session.command('show <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('GET', `/os/sessions/${segment(id)}`), options.json, ['session'])
    })
  for (const action of ['resume', 'pause', 'stop', 'retry', 'fork', 'archive'] as const) {
    session.command(`${action} <id>`)
      .option('--idempotency <key>')
      .option('--json', 'print the complete response')
      .action(async (id, options) => {
        await ready()
        print(await deps.api('POST', `/os/sessions/${segment(id)}/${action}`, {
          idempotency_key: commandKey(`session-${action}:${id}`, options.idempotency),
        }), options.json, ['created_session', 'session'])
      })
  }
  session.command('rename <id> <name>')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (id, name, options) => {
      await ready()
      print(await deps.api('POST', `/os/sessions/${segment(id)}/rename`, {
        name,
        idempotency_key: commandKey(`session-rename:${id}`, options.idempotency),
      }), options.json, ['session'])
    })
  session.command('reconcile-fork <action-id>')
    .requiredOption(
      '--resolution <resolution>',
      'verify_adopt or confirm_absent',
    )
    .option('--note <text>', 'operator reconciliation note')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (actionId, options) => {
      await ready()
      if (options.resolution !== 'verify_adopt'
        && options.resolution !== 'confirm_absent') {
        throw new Error('resolution must be verify_adopt or confirm_absent')
      }
      print(await deps.api(
        'POST',
        `/os/session-actions/${segment(actionId)}/reconcile`,
        compact({
          resolution: options.resolution,
          note: options.note,
          idempotency_key: commandKey(
            `session-fork-reconcile:${actionId}:${options.resolution}`,
            options.idempotency,
          ),
        }),
      ), options.json, ['created_session', 'session', 'reconciliation'])
    })
  session.command('search <id>')
    .option('--query <text>')
    .option('--after <sequence>', 'sequence cursor', integer)
    .option('--limit <number>', 'maximum events', integer, 100)
    .option('--kind <items>', 'comma-separated event kinds')
    .option('--actor-type <type>')
    .option('--actor-id <id>')
    .option('--tool <tool>')
    .option('--status <status>')
    .option('--from <date>')
    .option('--to <date>')
    .option('--session <id>', 'restrict to one session')
    .option('--archived', 'include archived events')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      const query = new URLSearchParams({ limit: String(options.limit) })
      if (options.query) query.set('query', options.query)
      if (options.after !== undefined) query.set('after', String(options.after))
      if (options.kind) query.set('kind', options.kind)
      if (options.actorType) query.set('actor_type', options.actorType)
      if (options.actorId) query.set('actor_id', options.actorId)
      if (options.tool) query.set('tool', options.tool)
      if (options.status) query.set('status', options.status)
      if (options.from) query.set('from', options.from)
      if (options.to) query.set('to', options.to)
      if (options.session) query.set('session_id', options.session)
      if (options.archived) query.set('archived', 'true')
      print(
        await deps.api('GET', `/os/sessions/${segment(id)}/search?${query}`),
        options.json,
        ['events'],
      )
    })
  session.command('export <id>')
    .option('--json', 'export canonical JSON instead of human text')
    .option('--artifact', 'persist the redacted export as an Agent OS artifact')
    .option('--idempotency <key>')
    .action(async (id, options) => {
      await ready()
      const format = options.json ? 'json' : 'human'
      if (options.artifact) {
        return print(await deps.api('POST', `/os/sessions/${segment(id)}/export`, {
          format,
          idempotency_key: commandKey(`session-export:${id}:${format}`, options.idempotency),
        }), options.json, ['artifact'])
      }
      const result = await deps.api('GET', `/os/sessions/${segment(id)}/export?format=${format}`)
      if (options.json) return print(result, true)
      write(typeof result === 'string' ? result : String(result?.text ?? result))
    })

  const retention = program.command('retention')
    .description('configure and run Agent Home retention')
  retention.command('show')
    .option('--board <id>', 'board id', integer)
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      print(await deps.api('GET', `/os/boards/${id}/retention`), options.json, ['policy'])
    })
  retention.command('set')
    .option('--board <id>', 'board id', integer)
    .option('--transcript-days <days>', 'days before transcript events are archived', integer)
    .option('--ephemeral-days <days>', 'days before ephemeral events are archived', integer)
    .option('--raw-artifact-days <days>', 'days before eligible inline raw payloads are compacted', integer)
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      print(await deps.api('PUT', `/os/boards/${id}/retention`, compact({
        transcript_days: options.transcriptDays,
        ephemeral_days: options.ephemeralDays,
        raw_artifact_days: options.rawArtifactDays,
        idempotency_key: commandKey(`retention-set:${id}`, options.idempotency),
      })), options.json, ['policy'])
    })
  retention.command('run')
    .option('--board <id>', 'board id', integer)
    .option('--as-of <timestamp>', 'deterministic ISO retention cutoff time')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      print(await deps.api('POST', `/os/boards/${id}/retention/run`, compact({
        as_of: options.asOf,
        idempotency_key: commandKey(`retention-run:${id}`, options.idempotency),
      })), options.json, ['run'])
    })

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
    .option('--idempotency <key>')
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
        idempotency_key: commandKey(
          `workspace-create:${id}:${name}`,
          options.idempotency,
        ),
      })
      print(await deps.api('POST', `/os/boards/${id}/workspaces`, body), options.json)
    })
  workspace.command('show <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('GET', `/os/workspaces/${segment(id)}`), options.json)
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
      print(await deps.api('PATCH', `/os/workspaces/${segment(id)}`, body), options.json)
    })
  workspace.command('archive <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('DELETE', `/os/workspaces/${segment(id)}`), options.json)
    })

  const processCommand = program.command('process').description('run and control real PTY processes')
  processCommand.command('list <workspace>')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, options) => {
      await ready()
      print(await deps.api('GET', `/os/workspaces/${segment(workspaceId)}/processes`), options.json, ['processes'])
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
      print(await deps.api('POST', `/os/workspaces/${segment(workspaceId)}/processes`, compact({
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
      const result = await deps.api('GET', `/os/processes/${segment(id)}/output?after=${options.after}`)
      if (options.json) return print(result, true)
      const records = arrayFrom(result, ['output', 'records', 'chunks'])
      write(records.map((record) => typeof record === 'string' ? record : (record.data ?? '')).join(''))
    })
  processCommand.command('attach <id>')
    .description('attach this terminal to a managed PTY; Ctrl+] detaches')
    .action(async (id) => {
      await ready()
      await attach(opaqueId(id))
    })
  processCommand.command('input <id> [text]')
    .option('--stdin', 'read exact input bytes from stdin')
    .option('--json', 'print the complete response')
    .action(async (id, text, options) => {
      await ready()
      const data = options.stdin ? stdin() : text
      if (data === undefined) throw new Error('input requires text or --stdin')
      print(await deps.api('POST', `/os/processes/${segment(id)}/input`, { data }), options.json)
    })
  processCommand.command('resize <id> <cols> <rows>')
    .option('--json', 'print the complete response')
    .action(async (id, cols, rows, options) => {
      await ready()
      print(await deps.api('POST', `/os/processes/${segment(id)}/resize`, {
        cols: integer(cols), rows: integer(rows),
      }), options.json)
    })
  processCommand.command('signal <id> [signal]')
    .option('--json', 'print the complete response')
    .action(async (id, signal, options) => {
      await ready()
      print(await deps.api('POST', `/os/processes/${segment(id)}/signal`, { signal: signal ?? 'SIGTERM' }), options.json)
    })
  processCommand.command('restart <id>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/processes/${segment(id)}/restart`), options.json)
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
      print(await deps.api('POST', `/os/attention/${segment(id)}/resolve`, compact({ resolution: options.resolution })), options.json)
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
    .option('--deliverables <json>', 'promised deliverable JSON array')
    .option('--accept <json>', 'acceptance criteria JSON array')
    .option('--non-goals <json>', 'non-goal JSON array')
    .option('--risks <json>', 'risk JSON array')
    .option('--depends <ids>', 'comma-separated card ids')
    .option('--dependency-rules <json>', 'dependency records with blocking reason and completion condition')
    .option('--verify <json>', 'verification command JSON array')
    .option('--capabilities <json>', 'required capability JSON array')
    .option('--providers <json>', 'allowed provider JSON array')
    .option('--models <json>', 'allowed model JSON array')
    .option('--access <json>', 'required access-profile JSON array')
    .option('--base <ref>')
    .option('--priority <number>', 'higher runs first', integer)
    .option('--tokens <number>', 'token budget', integer)
    .option('--cost <number>', 'cost budget', decimal)
    .option('--time <seconds>', 'wall-time budget in seconds', integer)
    .option('--retries <number>', 'retry budget', integer)
    .option('--coordination-tokens <number>', 'coordination token budget', integer)
    .option('--coordination-messages <number>', 'coordination message budget', integer)
    .option('--policy <id>', 'policy id')
    .option('--workspace <id>', 'workspace id')
    .option('--actor <actor>', 'audited actor')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      await ready()
      const dependencies = csv(options.depends)?.map(integer)
      print(await deps.api('PUT', `/os/cards/${integer(cardId)}/contract`, compact({
        objective: options.objective,
        deliverables: parseJsonOption<unknown[]>(options.deliverables, '--deliverables'),
        acceptance_criteria: parseJsonOption<unknown[]>(options.accept, '--accept'),
        non_goals: parseJsonOption<string[]>(options.nonGoals, '--non-goals'),
        risks: parseJsonOption<string[]>(options.risks, '--risks'),
        dependencies,
        dependency_rules: parseJsonOption<unknown[]>(options.dependencyRules, '--dependency-rules'),
        verify_commands: parseJsonOption<string[]>(options.verify, '--verify'),
        required_capabilities: parseJsonOption<string[]>(options.capabilities, '--capabilities'),
        provider_constraints: parseJsonOption<string[]>(options.providers, '--providers'),
        model_constraints: parseJsonOption<string[]>(options.models, '--models'),
        access_needs: parseJsonOption<string[]>(options.access, '--access'),
        base_ref: options.base,
        priority: options.priority,
        budget_tokens: options.tokens,
        budget_cents: options.cost,
        budget_time_seconds: options.time,
        budget_retries: options.retries,
        budget_coordination_tokens: options.coordinationTokens,
        budget_coordination_messages: options.coordinationMessages,
        policy_id: options.policy,
        workspace_id: options.workspace,
        actor: options.actor,
      })), options.json)
    })
  contract.command('validate <card>')
    .option('--mode <mode>', 'publish or launch', 'publish')
    .option('--provider <name>')
    .option('--model <model>')
    .option('--access <profile>', 'read_only, workspace_write, or full_access')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      await ready()
      const query = new URLSearchParams({ mode: options.mode })
      if (options.provider) query.set('provider', options.provider)
      if (options.model) query.set('model', options.model)
      if (options.access) query.set('access_profile', options.access)
      print(
        await deps.api('GET', `/os/cards/${integer(cardId)}/contract/validate?${query}`),
        options.json,
      )
    })
  contract.command('publish <card>')
    .option('--actor <actor>', 'audited actor', 'human')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      await ready()
      print(
        await deps.api('POST', `/os/cards/${integer(cardId)}/contract/publish`, { actor: options.actor }),
        options.json,
      )
    })
  contract.command('transition <card> <status>')
    .option('--actor <actor>', 'audited actor', 'human')
    .option('--reason <text>')
    .option('--json', 'print the complete response')
    .action(async (cardId, status, options) => {
      await ready()
      print(
        await deps.api('POST', `/os/cards/${integer(cardId)}/contract/transition`, compact({
          status,
          actor: options.actor,
          reason: options.reason,
        })),
        options.json,
      )
    })

  const contractTemplate = program.command('contract-template')
    .description('list, preview, and explicitly apply built-in task contract templates')
  contractTemplate.command('list')
    .option('--json', 'print the complete response')
    .action(async (options) => {
      await ready()
      print(await deps.api('GET', '/os/contract-templates'), options.json, ['templates'])
    })
  contractTemplate.command('preview <card> <template>')
    .requiredOption('--vars <json>', 'required template variable JSON object')
    .option('--json', 'print the complete response')
    .action(async (cardId, templateId, options) => {
      await ready()
      print(await deps.api(
        'POST',
        `/os/contract-templates/${segment(templateId)}/preview`,
        {
          card_id: integer(cardId),
          variables: parseJsonOption<Record<string, string>>(options.vars, '--vars'),
        },
      ), options.json)
    })
  contractTemplate.command('apply <card> <template>')
    .requiredOption('--vars <json>', 'required template variable JSON object')
    .requiredOption('--expected <json>', 'expected-state JSON object from template preview')
    .option('--replace', 'explicitly replace conflicting template-owned fields')
    .option('--actor <actor>', 'audited actor', 'human')
    .option('--json', 'print the complete response')
    .action(async (cardId, templateId, options) => {
      await ready()
      print(await deps.api(
        'POST',
        `/os/cards/${integer(cardId)}/contract/templates/${segment(templateId)}/apply`,
        {
          variables: parseJsonOption<Record<string, string>>(options.vars, '--vars'),
          expected_state: parseJsonOption<Record<string, unknown>>(options.expected, '--expected'),
          conflict_strategy: options.replace ? 'replace' : 'reject',
          actor: options.actor,
        },
      ), options.json)
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
    .option('--workspace <id>', 'workspace id')
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

  const delivery = program.command('delivery').description('manage frozen delivery reports and review evidence')
  delivery.command('show <card>')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      await ready()
      print(await deps.api('GET', `/os/cards/${integer(cardId)}/deliveries`), options.json, ['deliveries'])
    })
  delivery.command('submit <job>')
    .option('--actor <actor>', 'reporting actor', 'agent')
    .option('--summary <text>', 'concise delivery summary')
    .option('--items <json>', 'delivered-item JSON array')
    .option('--criteria <json>', 'criterion-result JSON array')
    .option('--evidence <json>', 'evidence JSON object or artifact-id array')
    .option('--claims <json>', 'claim JSON array')
    .option('--files <json>', 'changed-file JSON array')
    .option('--commits <json>', 'commit JSON array')
    .option('--artifacts <json>', 'artifact-id JSON array')
    .option('--gaps <json>', 'reported-gap JSON array')
    .option('--stdin', 'read a JSON report object, or plain summary text, from stdin')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (jobId, options) => {
      await ready()
      let input: Record<string, unknown> = {}
      if (options.stdin) {
        const raw = stdin().trim()
        if (!raw) throw new Error('--stdin did not contain a delivery report')
        try {
          const parsed = JSON.parse(raw) as unknown
          input = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : { summary: raw }
        } catch {
          input = { summary: raw }
        }
      }
      const summary = options.summary ?? input.summary
      if (typeof summary !== 'string' || !summary.trim()) throw new Error('delivery submit requires --summary or --stdin')
      print(await deps.api('POST', `/os/jobs/${segment(jobId)}/deliveries/submit`, compact({
        ...input,
        actor: options.actor ?? input.actor,
        summary: summary.trim(),
        delivered_items: parseJsonOption<unknown[]>(options.items, '--items') ?? input.delivered_items ?? input.items,
        criteria: parseJsonOption<unknown[]>(options.criteria, '--criteria') ?? input.criteria,
        evidence: parseJsonOption<unknown>(options.evidence, '--evidence') ?? input.evidence,
        claims: parseJsonOption<unknown[]>(options.claims, '--claims') ?? input.claims,
        changed_files: parseJsonOption<string[]>(options.files, '--files') ?? input.changed_files ?? input.changedFiles,
        commits: parseJsonOption<string[]>(options.commits, '--commits') ?? input.commits,
        artifact_ids: parseJsonOption<string[]>(options.artifacts, '--artifacts')
          ?? input.artifact_ids ?? input.artifactIds,
        gaps: parseJsonOption<string[]>(options.gaps, '--gaps') ?? input.gaps,
        idempotency_key: commandKey(
          `delivery-submit:${jobId}`,
          options.idempotency,
        ),
      })), options.json, ['delivery'])
    })
  delivery.command('verify <id>')
    .option('--actor <actor>', 'verifying actor', 'verifier')
    .option('--criteria <json>', 'criterion-result JSON array')
    .option('--deliverables <json>', 'deliverable-result JSON array')
    .option('--stdin', 'read criterion results or a verification object from stdin')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      let input: Record<string, unknown> = {}
      if (options.stdin) {
        const raw = stdin().trim()
        if (!raw) throw new Error('--stdin did not contain verification results')
        const parsed = parseJsonOption<unknown>(raw, '--stdin')
        input = Array.isArray(parsed) ? { results: parsed } : parsed as Record<string, unknown>
      }
      print(await deps.api('POST', `/os/deliveries/${segment(id)}/verify`, compact({
        ...input,
        actor: options.actor ?? input.actor,
        results: parseJsonOption<unknown[]>(options.criteria, '--criteria') ?? input.results ?? input.criteria,
        deliverable_results: parseJsonOption<unknown[]>(options.deliverables, '--deliverables')
          ?? input.deliverable_results,
      })), options.json, ['delivery'])
    })
  delivery.command('accept <id>')
    .option('--actor <actor>', 'accepting actor', 'human')
    .option('--note <text>')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/deliveries/${segment(id)}/accept`, compact({
        actor: options.actor,
        note: options.note,
        idempotency_key: commandKey(
          `delivery-accept:${id}`,
          options.idempotency,
        ),
      })), options.json, ['delivery'])
    })
  delivery.command('reject <id>')
    .option('--actor <actor>', 'rejecting actor', 'human')
    .requiredOption('--reason <text>', 'reason the delivery needs revision')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/deliveries/${segment(id)}/reject`, {
        actor: options.actor,
        reason: options.reason,
      }), options.json, ['delivery'])
    })
  delivery.command('revise <id>')
    .option('--actor <actor>', 'revision actor', 'agent')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/deliveries/${segment(id)}/revise`, { actor: options.actor }), options.json, ['delivery'])
    })
  delivery.command('export <id>')
    .option('--json', 'export canonical JSON instead of the human trackbook')
    .action(async (id, options) => {
      await ready()
      const result = await deps.api('GET', `/os/deliveries/${segment(id)}/export?format=${options.json ? 'json' : 'human'}`)
      if (options.json) return print(result, true)
      write(typeof result === 'string' ? result : String(result?.text ?? result?.report ?? result))
    })

  const context = program.command('context').description('inspect or replace a workspace context manifest')
  context.command('show <workspace>')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, options) => {
      await ready()
      print(await deps.api('GET', `/os/workspaces/${segment(workspaceId)}/context`), options.json, ['context', 'items'])
    })
  context.command('set <workspace> <json>')
    .option('--json-output', 'print the complete response')
    .action(async (workspaceId, value, options) => {
      await ready()
      const items = parseJsonOption<unknown[]>(value, 'context')
      print(await deps.api('PUT', `/os/workspaces/${segment(workspaceId)}/context`, { items }), options.jsonOutput)
    })

  const checkpoint = program.command('checkpoint').description('create and safely fork durable checkpoints')
  checkpoint.command('list <workspace>')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, options) => {
      await ready()
      print(await deps.api('GET', `/os/workspaces/${segment(workspaceId)}/checkpoints`), options.json, ['checkpoints'])
    })
  checkpoint.command('create <workspace> <name>')
    .option('--context <json>')
    .option('--recipes <json>', 'restart recipe JSON array')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (workspaceId, name, options) => {
      await ready()
      print(await deps.api('POST', `/os/workspaces/${segment(workspaceId)}/checkpoints`, compact({
        name,
        context: parseJsonOption<Record<string, unknown>>(options.context, '--context'),
        process_recipes: parseJsonOption<unknown[]>(options.recipes, '--recipes'),
        idempotency_key: commandKey(
          `checkpoint-create:${workspaceId}:${name}`,
          options.idempotency,
        ),
      })), options.json)
    })
  checkpoint.command('fork <id>')
    .requiredOption('--name <name>', 'new workspace name')
    .option('--path <path>', 'new worktree path')
    .option('--branch <name>', 'new branch')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/checkpoints/${segment(id)}/fork`, compact({
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
    .option('--workspace <id>', 'workspace id')
    .option('--provider <name>', 'agent driver', 'claude')
    .option('--model <model>')
    .option('--priority <number>', 'higher runs first', integer)
    .option('--attempts <number>', 'maximum attempts', integer)
    .option('--tokens <number>', 'token budget', integer)
    .option('--cost <number>', 'cost budget', decimal)
    .option('--at <iso-time>', 'scheduled time')
    .option('--idempotency-key <key>', 'safely replay the same launch request')
    .option('--json', 'print the complete response')
    .action(async (cardId, options) => {
      const id = await boardId(options.board)
      const result = await deps.api('POST', `/os/boards/${id}/jobs`, compact({
        card_id: integer(cardId),
        workspace_id: options.workspace,
        provider: options.provider,
        model: options.model,
        priority: options.priority,
        max_attempts: options.attempts,
        budget_tokens: options.tokens,
        budget_cents: options.cost,
        scheduled_at: options.at,
        idempotency_key: commandKey(
          `job-create:${id}:${cardId}`,
          options.idempotencyKey,
        ),
      }))
      if (options.json) return print(result, true)
      const job = result?.job ?? result
      const identity = result?.orchestration ?? {}
      write([
        `mode=${result?.mode ?? 'canonical'}`,
        `job_id=${JSON.stringify(identity.job_id ?? job?.id ?? null)}`,
        `status=${JSON.stringify(job?.status ?? 'queued')}`,
        `workspace_id=${JSON.stringify(identity.workspace_id ?? job?.workspace_id ?? null)}`,
        `session_id=${JSON.stringify(identity.session_id ?? null)}`,
      ].join(' '))
    })
  job.command('cancel <id>')
    .option('--idempotency <key>')
    .option('--json', 'print the complete response')
    .action(async (id, options) => {
      await ready()
      print(await deps.api('POST', `/os/jobs/${segment(id)}/cancel`, {
        idempotency_key: commandKey(`job-cancel:${id}`, options.idempotency),
      }), options.json)
    })
  registerJobAssignmentCommands(job, deps)

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
    .option('--idempotency <key>')
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
        idempotency_key: commandKey(
          `policy-create:${id}:${name}`,
          options.idempotency,
        ),
      }), options.json)
    })
  policy.command('evaluate <id> <kind> <value>')
    .option('--json', 'print the complete response')
    .action(async (id, kind, value, options) => {
      await ready()
      print(await deps.api('POST', `/os/policies/${segment(id)}/evaluate`, { kind, value }), options.json)
    })

  program.command('events')
    .description('read the append-only Agent OS event stream')
    .option('--board <id>', 'board id', integer)
    .option('--after <id>', 'only events after this opaque cursor')
    .option('--limit <number>', 'maximum events', integer, 100)
    .option('--json', 'print the complete response')
    .action(async (options) => {
      const id = await boardId(options.board)
      const query = new URLSearchParams({ limit: String(options.limit) })
      if (options.after) query.set('after', opaqueId(options.after))
      print(await deps.api('GET', `/os/boards/${id}/events?${query}`), options.json, ['events'])
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
