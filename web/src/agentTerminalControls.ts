export type AgentControlPanelName = 'model' | 'mcp' | 'plugin'

const CONTROL_COMMANDS = new Set<AgentControlPanelName>(['model', 'mcp', 'plugin'])

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
