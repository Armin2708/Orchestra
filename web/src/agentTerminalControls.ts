export type AgentControlPanelName = 'model' | 'mcp' | 'plugin'
export type LocalConsoleCommandName = 'clear' | 'commands' | 'status' | 'usage'

export type SessionModelShape = {
  value?: string
  model?: string
  resolvedModel?: string
  displayName?: string
  description?: string
  isDefault?: boolean
  defaultEffort?: string
  supportedEffortLevels?: string[]
}

export type SessionModelState = {
  model?: string | null
  requestedModel?: string | null
  resolvedModel?: string | null
}

export type SessionModelSelection<T extends SessionModelShape = SessionModelShape> = {
  selectedIndex: number
  selectedModel: T | null
  resolvedIndex: number
  requestedModel: string | null
  resolvedModel: string | null
  selectedLabel: string
  resolvedLabel: string | null
  usesProviderDefault: boolean
  pending: boolean
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

const cleanModelValue = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const isDefaultModel = (model: SessionModelShape): boolean =>
  model.isDefault === true || sessionModelValue(model).toLowerCase() === 'default'

export function modelMatchesResolved(model: SessionModelShape, resolvedModel: string | null | undefined): boolean {
  const resolved = cleanModelValue(resolvedModel)
  if (!resolved) return false
  return sessionModelValue(model) === resolved || cleanModelValue(model.resolvedModel) === resolved
}

/**
 * Resolve one, and only one, selected catalog row while keeping the configured
 * provider value separate from the concrete model that is currently running.
 */
export function sessionModelSelection<T extends SessionModelShape>(
  models: T[],
  state: SessionModelState,
): SessionModelSelection<T> {
  const hasRequestedModel = Object.prototype.hasOwnProperty.call(state, 'requestedModel')
  const requestedModel = cleanModelValue(state.requestedModel)
  const legacyModel = cleanModelValue(state.model)
  const resolvedModel = cleanModelValue(state.resolvedModel) ?? (hasRequestedModel ? null : legacyModel)
  const defaultIndex = models.findIndex(isDefaultModel)
  const exactResolvedIndex = resolvedModel
    ? models.findIndex((model) => sessionModelValue(model) === resolvedModel)
    : -1
  const resolvedAliasIndexes = resolvedModel
    ? models
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => cleanModelValue(model.resolvedModel) === resolvedModel)
      .map(({ index }) => index)
    : []
  const resolvedIndex = exactResolvedIndex >= 0
    ? exactResolvedIndex
    : resolvedAliasIndexes.length === 1
      ? resolvedAliasIndexes[0]
      : defaultIndex >= 0 && resolvedAliasIndexes.includes(defaultIndex)
        ? defaultIndex
        : -1
  let selectedIndex = -1

  if (requestedModel) {
    selectedIndex = models.findIndex((model) => sessionModelValue(model) === requestedModel)
    if (selectedIndex < 0) {
      const aliases = models
        .map((model, index) => ({ model, index }))
        .filter(({ model }) => cleanModelValue(model.resolvedModel) === requestedModel)
      if (aliases.length === 1) selectedIndex = aliases[0].index
    }
  } else if (hasRequestedModel && defaultIndex >= 0) {
    selectedIndex = defaultIndex
  } else if (legacyModel) {
    selectedIndex = models.findIndex((model) => sessionModelValue(model) === legacyModel)
  }

  if (selectedIndex < 0 && !requestedModel) selectedIndex = resolvedIndex

  const selectedModel = selectedIndex >= 0 ? models[selectedIndex] : null
  const usesProviderDefault = hasRequestedModel
    && (requestedModel === null || requestedModel.toLowerCase() === 'default')
  const selectedLabel = usesProviderDefault
    ? 'Provider default'
    : selectedModel?.displayName?.trim() || requestedModel || legacyModel || resolvedModel || 'Model unavailable'
  const resolvedCatalogModel = resolvedIndex >= 0 ? models[resolvedIndex] : null
  const resolvedLabel = resolvedCatalogModel?.displayName?.trim() || resolvedModel
  const pending = !!requestedModel && !!resolvedModel
    && (selectedModel ? !modelMatchesResolved(selectedModel, resolvedModel) : requestedModel !== resolvedModel)

  return {
    selectedIndex,
    selectedModel,
    resolvedIndex,
    requestedModel,
    resolvedModel,
    selectedLabel,
    resolvedLabel,
    usesProviderDefault,
    pending,
  }
}

/** Stable comparison key so same-length provider catalog updates are not lost. */
export function modelCatalogSignature(models: SessionModelShape[] | undefined): string {
  return JSON.stringify((models ?? []).map((model) => ({
    value: sessionModelValue(model),
    resolvedModel: cleanModelValue(model.resolvedModel),
    displayName: model.displayName?.trim() ?? '',
    description: model.description?.trim() ?? '',
    isDefault: model.isDefault === true,
    defaultEffort: model.defaultEffort?.trim() ?? '',
    supportedEffortLevels: model.supportedEffortLevels ?? [],
  })))
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
