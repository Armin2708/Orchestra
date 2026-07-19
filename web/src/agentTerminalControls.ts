export type AgentControlPanelName = 'model' | 'mcp' | 'plugin'
export type LocalConsoleCommandName = 'clear' | 'commands' | 'status' | 'usage'

export type SessionModelShape = {
  value?: string
  model?: string
  resolvedModel?: string
}

const CONTROL_COMMANDS = new Set<AgentControlPanelName>(['model', 'mcp', 'plugin'])
const LOCAL_COMMAND_ALIASES: Record<string, LocalConsoleCommandName> = {
  clear: 'clear',
  commands: 'commands',
  help: 'commands',
  status: 'status',
  usage: 'usage',
  cost: 'usage',
}

export function normalizeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '')
}

export function sessionModelValue(model: SessionModelShape): string {
  return [model.value, model.model, model.resolvedModel]
    .find((value) => typeof value === 'string' && value.trim())?.trim() ?? ''
}

export function localConsoleCommand(input: string): LocalConsoleCommandName | null {
  const match = input.trim().match(/^\/([^\s]+)(?:\s|$)/)
  return match ? LOCAL_COMMAND_ALIASES[match[1].toLowerCase()] ?? null : null
}

export function uniqueSlashCommands<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const name = normalizeSlashCommandName(item.name).toLowerCase()
    if (!name || seen.has(name)) return false
    seen.add(name)
    return true
  })
}

export function panelForSlashCommand(name: string): AgentControlPanelName | null {
  const normalized = name.trim().replace(/^\//, '').toLowerCase()
  return CONTROL_COMMANDS.has(normalized as AgentControlPanelName)
    ? normalized as AgentControlPanelName
    : null
}

export function panelForSlashInput(input: string): AgentControlPanelName | null {
  const match = input.trim().match(/^\/([^\s]+)$/)
  return match ? panelForSlashCommand(match[1]) : null
}
