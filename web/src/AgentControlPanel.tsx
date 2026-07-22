import React, { useEffect, useRef, useState } from 'react'
import { api } from './api'
import {
  sessionModelSelection,
  sessionModelValue,
  type AgentControlPanelName,
} from './agentTerminalControls'
import './agentTerminalControls.css'

export type SessionModel = {
  value?: string
  model?: string
  resolvedModel?: string
  displayName?: string
  description?: string
  isDefault?: boolean
  defaultEffort?: string
  supportedEffortLevels?: string[]
}

type McpServer = {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | string
  error?: string
  scope?: string
  serverInfo?: { name?: string; version?: string }
  tools?: unknown[]
}

type LoadedPlugin = { name: string; path?: string; source?: string }
type PluginResult = { plugins?: LoadedPlugin[]; error_count?: number }

const readableError = (error: unknown) => {
  const raw = error instanceof Error ? error.message : 'Session control failed'
  try { return JSON.parse(raw).error ?? raw } catch { return raw }
}

const titles: Record<AgentControlPanelName, { title: string; hint: string }> = {
  model: { title: 'Select model', hint: 'Applies to this session from the next turn.' },
  mcp: { title: 'MCP servers', hint: 'Live status and controls from this session.' },
  plugin: { title: 'Loaded plugins', hint: 'Reloads plugin commands from disk without restarting the agent.' },
}

type AgentControlPanelProps = {
  agentId: number
  panel: AgentControlPanelName
  models: SessionModel[]
  legacyModel?: string | null
  requestedModel?: string | null
  resolvedModel?: string | null
  currentEffort: string | null
  resolvedEffort?: string | null
  working: boolean
  canSelectModel: boolean
  canSetEffort: boolean
  onClose: () => void
  onChange: (patch?: { requestedModel?: string; effort?: string }) => void
}

export function AgentControlPanel(props: AgentControlPanelProps) {
  const {
    agentId,
    panel,
    models,
    legacyModel,
    requestedModel,
    resolvedModel,
    currentEffort,
    resolvedEffort,
    working,
    canSelectModel,
    canSetEffort,
    onClose,
    onChange,
  } = props
  const [servers, setServers] = useState<McpServer[]>([])
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([])
  const [pluginErrors, setPluginErrors] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(panel !== 'model')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [optimisticModel, setOptimisticModel] = useState<string | null>(null)
  const [optimisticEffort, setOptimisticEffort] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const selection = sessionModelSelection(models, optimisticModel !== null
    ? { model: legacyModel, requestedModel: optimisticModel, resolvedModel }
    : requestedModel !== undefined
      ? { model: legacyModel, requestedModel, resolvedModel }
      : { model: legacyModel, resolvedModel })

  const loadMcp = async () => {
    setLoading(true); setError(null)
    try {
      const result = await api('GET', `/agents/${agentId}/mcp`)
      setServers(Array.isArray(result.servers) ? result.servers : [])
    } catch (cause) { setError(readableError(cause)) }
    finally { setLoading(false) }
  }

  const loadPlugins = async () => {
    setLoading(true); setError(null)
    try {
      const result = await api('POST', `/agents/${agentId}/plugins/reload`) as PluginResult
      setPlugins(Array.isArray(result.plugins) ? result.plugins : [])
      setPluginErrors(Number(result.error_count) || 0)
      onChange()
    } catch (cause) { setError(readableError(cause)) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    setCursor(panel === 'model' ? Math.max(0, selection.selectedIndex) : 0)
    setLoading(panel !== 'model')
    setBusy(null)
    setError(null)
    setOptimisticModel(null)
    setOptimisticEffort(null)
    if (panel === 'mcp') void loadMcp()
    if (panel === 'plugin') void loadPlugins()
    requestAnimationFrame(() => panelRef.current?.focus())
    // Opening a panel is the refresh boundary; button clicks refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, panel])

  const changeMcp = async (server: McpServer, action: 'toggle' | 'reconnect') => {
    const key = `${action}:${server.name}`
    setBusy(key); setError(null)
    try {
      const name = encodeURIComponent(server.name)
      const result = action === 'toggle'
        ? await api('POST', `/agents/${agentId}/mcp/${name}/toggle`, { enabled: server.status === 'disabled' })
        : await api('POST', `/agents/${agentId}/mcp/${name}/reconnect`)
      setServers(Array.isArray(result.servers) ? result.servers : [])
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(null) }
  }

  const selectModel = async (model: SessionModel) => {
    const value = sessionModelValue(model)
    if (!canSelectModel || model === selection.selectedModel || busy) return
    if (!value) {
      setError('This model entry has no provider identifier. Refresh the session and try again.')
      return
    }
    setBusy(value); setError(null)
    try {
      await api('POST', `/agents/${agentId}/model`, { model: value })
      setOptimisticModel(value)
      onChange({ requestedModel: value })
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(null) }
  }

  const selectedModel = selection.selectedModel
  const effortLevels = selectedModel?.supportedEffortLevels ?? []
  const selectedEffort = optimisticEffort ?? currentEffort
  const effectiveEffort = selectedEffort ?? resolvedEffort ?? selectedModel?.defaultEffort ?? null
  const changeEffort = async (level: string) => {
    if (!canSetEffort || working || busy || level === selectedEffort) return
    setBusy(`effort:${level}`); setError(null)
    try {
      await api('POST', `/agents/${agentId}/effort`, { level })
      setOptimisticEffort(level)
      onChange({ effort: level })
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(null) }
  }

  const rowCount = panel === 'model' ? models.length : panel === 'mcp' ? servers.length : plugins.length
  const moveCursor = (step: -1 | 1) => {
    if (rowCount === 0) return
    setCursor((current) => (current + step + rowCount) % rowCount)
  }

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, rowCount - 1)))
  }, [rowCount])

  const handlePanelKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onClose(); return
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveCursor(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveCursor(-1); return }
    if (event.target instanceof HTMLButtonElement) return

    if (panel === 'model') {
      if (/^[1-9]$/.test(event.key)) {
        const model = models[Number(event.key) - 1]
        if (model) { event.preventDefault(); void selectModel(model) }
        return
      }
      if (canSetEffort && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && effortLevels.length > 0) {
        event.preventDefault()
        const current = Math.max(0, effortLevels.indexOf(selectedEffort ?? effectiveEffort ?? ''))
        const direction = event.key === 'ArrowRight' ? 1 : -1
        void changeEffort(effortLevels[(current + direction + effortLevels.length) % effortLevels.length])
        return
      }
      if (event.key === 'Enter' && models[cursor]) { event.preventDefault(); void selectModel(models[cursor]); return }
    }

    if (panel === 'mcp' && servers[cursor]) {
      if (event.key === 'Enter') { event.preventDefault(); void changeMcp(servers[cursor], 'reconnect'); return }
      if (event.key === ' ') { event.preventDefault(); void changeMcp(servers[cursor], 'toggle') }
    }
  }

  const meta = titles[panel]
  return (
    <section ref={panelRef} tabIndex={-1} className="cc-control-panel" aria-label={meta.title}
      onKeyDown={handlePanelKeys}>
      <header className="cc-control-head">
        <div><strong>{meta.title}</strong><span>{meta.hint}</span></div>
        <button type="button" onClick={onClose} aria-label={`Close ${meta.title}`}>×</button>
      </header>

      {error && <p className="cc-control-error" role="alert">{error}</p>}
      {loading && <p className="cc-control-empty">Loading session controls…</p>}

      {!loading && panel === 'model' && (
        <>
          <div className="cc-model-state" aria-live="polite">
            <span>
              <small>{selection.pending ? 'Selected for next turn' : 'Selected'}</small>
              <b>{selection.selectedLabel}</b>
            </span>
            <span>
              <small>Active model</small>
              <b>{selection.resolvedLabel ?? selection.resolvedModel ?? 'Waiting for provider'}</b>
            </span>
          </div>
          <div className="cc-control-list" role="listbox" aria-label="Available models">
            {models.map((model, index) => {
              const value = sessionModelValue(model)
              const selected = index === selection.selectedIndex
              const running = index === selection.resolvedIndex
              const providerDefault = selection.usesProviderDefault && selected
              const description = providerDefault && selection.resolvedLabel
                ? [`Currently resolves to ${selection.resolvedLabel}`, model.description].filter(Boolean).join(' · ')
                : model.description
              const status = busy === value
                ? 'switching…'
                : selected && selection.pending
                  ? 'next turn'
                  : selected
                    ? 'current'
                    : running
                      ? 'active'
                      : model.isDefault
                        ? 'provider default'
                        : value
              return (
                <button type="button" role="option" aria-selected={selected} key={value || `model-${index}`}
                  disabled={!canSelectModel || busy !== null}
                  className={`cc-control-row${selected ? ' selected' : ''}${running ? ' running' : ''}${index === cursor ? ' active' : ''}`}
                  onMouseEnter={() => setCursor(index)} onClick={() => void selectModel(model)}>
                  <span>
                    <b>{providerDefault ? 'Provider default' : model.displayName ?? (value || 'Unnamed model')}</b>
                    {description && <small>{description}</small>}
                  </span>
                  <em>{status}</em>
                </button>
              )
            })}
            {models.length === 0 && <p className="cc-control-empty">The provider has not reported any models for this session yet.</p>}
          </div>
          {canSetEffort && selectedModel && effortLevels.length > 0 && (
            <fieldset className="cc-model-effort-panel">
              <legend>Reasoning effort</legend>
              <p>{selectedEffort ? `Selected: ${selectedEffort}`
                : `Provider default${effectiveEffort ? ` · currently ${effectiveEffort}` : ''}`}</p>
              <div role="group" aria-label="Reasoning effort">
                {effortLevels.map((level) => (
                  <button type="button" key={level} disabled={working || busy !== null}
                    aria-pressed={selectedEffort === level}
                    className={`${selectedEffort === level ? 'selected' : ''}${effectiveEffort === level ? ' running' : ''}`}
                    onClick={() => void changeEffort(level)}>
                    {busy === `effort:${level}` ? 'updating…' : level}
                  </button>
                ))}
              </div>
              {working && <small>Effort can change when the current turn finishes.</small>}
            </fieldset>
          )}
        </>
      )}

      {!loading && panel === 'mcp' && (
        <div className="cc-control-list">
          {servers.map((server, index) => (
            <div className={`cc-control-row${index === cursor ? ' active' : ''}`} key={server.name}
              onMouseEnter={() => setCursor(index)}>
              <span>
                <b><i className={`cc-control-status ${server.status}`} />{server.name}</b>
                <small>{server.error || [server.status, server.scope, server.tools?.length != null ? `${server.tools.length} tools` : ''].filter(Boolean).join(' · ')}</small>
              </span>
              <div className="cc-control-actions">
                {server.status !== 'disabled' && <button type="button" disabled={busy !== null}
                  onClick={() => void changeMcp(server, 'reconnect')}>{busy === `reconnect:${server.name}` ? 'connecting…' : 'reconnect'}</button>}
                <button type="button" disabled={busy !== null}
                  onClick={() => void changeMcp(server, 'toggle')}>{busy === `toggle:${server.name}` ? 'updating…' : server.status === 'disabled' ? 'enable' : 'disable'}</button>
              </div>
            </div>
          ))}
          {servers.length === 0 && <p className="cc-control-empty">No MCP servers are configured for this session.</p>}
          <button type="button" className="cc-control-refresh" onClick={() => void loadMcp()}>refresh status</button>
        </div>
      )}

      {!loading && panel === 'plugin' && (
        <div className="cc-control-list">
          {plugins.map((plugin, index) => (
            <div className={`cc-control-row${index === cursor ? ' active' : ''}`} key={`${plugin.name}:${plugin.path ?? ''}`}
              onMouseEnter={() => setCursor(index)}>
              <span><b>{plugin.name}</b><small>{[plugin.source, plugin.path].filter(Boolean).join(' · ')}</small></span>
              <em>loaded</em>
            </div>
          ))}
          {plugins.length === 0 && <p className="cc-control-empty">No plugins are loaded in this session.</p>}
          {pluginErrors > 0 && <p className="cc-control-error">{pluginErrors} plugin load {pluginErrors === 1 ? 'error' : 'errors'} reported.</p>}
          <button type="button" className="cc-control-refresh" onClick={() => void loadPlugins()}>reload plugins</button>
        </div>
      )}
    </section>
  )
}
