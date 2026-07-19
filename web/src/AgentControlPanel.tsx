import React, { useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { AgentControlPanelName } from './agentTerminalControls'
import './agentTerminalControls.css'

export type SessionModel = {
  model: string
  resolvedModel?: string
  displayName?: string
  description?: string
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
  model: { title: 'Select model', hint: 'Switch between Claude models for this session.' },
  mcp: { title: 'Manage MCP servers', hint: 'Live connections for this Claude session.' },
  plugin: { title: 'Plugins', hint: 'Installed plugins reported by this session.' },
}

export function AgentControlPanel({ agentId, panel, models, currentModel, currentEffort, working, onClose, onChange }: {
  agentId: number
  panel: AgentControlPanelName
  models: SessionModel[]
  currentModel: string | null
  currentEffort: string | null
  working: boolean
  onClose: () => void
  onChange: () => void
}) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([])
  const [pluginErrors, setPluginErrors] = useState(0)
  const [pluginQuery, setPluginQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(panel !== 'model')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

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
    const currentModelIndex = models.findIndex((model) => model.model === currentModel || model.resolvedModel === currentModel)
    setCursor(panel === 'model' ? Math.max(0, currentModelIndex) : 0)
    setPluginQuery('')
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
    const selected = model.model === currentModel || model.resolvedModel === currentModel
    if (selected || busy) return
    setBusy(`model:${model.model}`); setError(null)
    try {
      await api('POST', `/agents/${agentId}/model`, { model: model.model })
      onChange(); onClose()
    } catch (cause) { setError(readableError(cause)); setBusy(null) }
  }

  const selectedModel = models.find((model) => model.model === currentModel || model.resolvedModel === currentModel)
  const effortLevels = selectedModel?.supportedEffortLevels ?? []
  const changeEffort = async (level: string) => {
    if (working || busy || level === currentEffort) return
    setBusy(`effort:${level}`); setError(null)
    try {
      await api('POST', `/agents/${agentId}/effort`, { level })
      onChange()
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(null) }
  }

  const visiblePlugins = pluginQuery
    ? plugins.filter((plugin) => [plugin.name, plugin.source, plugin.path].some((value) => value?.toLowerCase().includes(pluginQuery.toLowerCase())))
    : plugins
  const rowCount = panel === 'model' ? models.length : panel === 'mcp' ? servers.length : visiblePlugins.length
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
    if (event.target instanceof HTMLInputElement) {
      if (event.key === 'ArrowDown') {
        event.preventDefault(); panelRef.current?.focus(); setCursor(0)
      }
      return
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveCursor(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveCursor(-1); return }

    if (panel === 'model') {
      if (/^[1-9]$/.test(event.key)) {
        const model = models[Number(event.key) - 1]
        if (model) { event.preventDefault(); void selectModel(model) }
        return
      }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && effortLevels.length > 0) {
        event.preventDefault()
        const current = Math.max(0, effortLevels.indexOf(currentEffort ?? ''))
        const direction = event.key === 'ArrowRight' ? 1 : -1
        const level = effortLevels[(current + direction + effortLevels.length) % effortLevels.length]
        void changeEffort(level)
        return
      }
      if (event.key === 'Enter' && models[cursor]) { event.preventDefault(); void selectModel(models[cursor]); return }
    }

    if (panel === 'mcp' && servers[cursor]) {
      if (event.key === 'Enter') { event.preventDefault(); void changeMcp(servers[cursor], 'reconnect'); return }
      if (event.key === ' ') { event.preventDefault(); void changeMcp(servers[cursor], 'toggle'); return }
    }

    if (panel === 'plugin' && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      setPluginQuery((query) => query + event.key)
      searchRef.current?.focus()
    }
  }

  const meta = titles[panel]
  return (
    <section ref={panelRef} tabIndex={-1} className={`cc-control-panel cc-control-${panel}`}
      aria-label={meta.title} onKeyDown={handlePanelKeys}>
      <header className="cc-control-head">
        <div><strong>{meta.title}</strong><span>{meta.hint}</span></div>
        <button type="button" onClick={onClose} aria-label={`Close ${meta.title}`}>Esc</button>
      </header>

      {panel === 'plugin' && (
        <>
          <nav className="cc-plugin-tabs" aria-label="Plugin sections">
            <strong>Plugins</strong><span>Installed</span><span>Errors ({pluginErrors})</span>
          </nav>
          <label className="cc-plugin-search">
            <span aria-hidden="true">⌕</span>
            <input ref={searchRef} value={pluginQuery} placeholder="Search…" aria-label="Search installed plugins"
              onChange={(event) => { setPluginQuery(event.target.value); setCursor(0) }} />
          </label>
        </>
      )}

      {error && <p className="cc-control-error" role="alert">{error}</p>}
      {loading && <p className="cc-control-empty"><span className="cc-control-spinner" aria-hidden="true">✻</span> Loading…</p>}

      {!loading && panel === 'model' && (
        <>
          <div className="cc-control-list" role="listbox" aria-label="Available models">
            {models.map((model, index) => {
              const selected = model.model === currentModel || model.resolvedModel === currentModel
              const active = index === cursor
              return (
                <button type="button" role="option" aria-selected={selected} key={model.model}
                  className={`cc-control-row${selected ? ' selected' : ''}${active ? ' active' : ''}`}
                  onMouseEnter={() => setCursor(index)} onClick={() => void selectModel(model)}>
                  <span className="cc-control-marker" aria-hidden="true">{active ? '❯' : ''}</span>
                  <span className="cc-control-number">{index + 1}.</span>
                  <span className="cc-control-copy"><b>{model.displayName ?? model.model}</b>{model.description && <small>{model.description}</small>}</span>
                  <em>{busy === `model:${model.model}` ? 'switching…' : selected ? '✔' : ''}</em>
                </button>
              )
            })}
            {models.length === 0 && <p className="cc-control-empty">Claude has not reported any models for this session yet.</p>}
          </div>
          {effortLevels.length > 0 && (
            <div className="cc-control-effort" aria-label="Reasoning effort">
              <span><i aria-hidden="true">●</i> {currentEffort ?? 'default'} effort</span>
              <div role="group">
                {effortLevels.map((level) => <button type="button" key={level} disabled={working || busy !== null}
                  className={level === currentEffort ? 'active' : ''} onClick={() => void changeEffort(level)}>{level}</button>)}
              </div>
            </div>
          )}
        </>
      )}

      {!loading && panel === 'mcp' && (
        <>
          <p className="cc-control-section">{servers.length} {servers.length === 1 ? 'server' : 'servers'}</p>
          <div className="cc-control-list" role="listbox" aria-label="MCP servers">
            {servers.map((server, index) => (
              <div className={`cc-control-row${index === cursor ? ' active' : ''}`} key={server.name}
                role="option" aria-selected={index === cursor} onMouseEnter={() => setCursor(index)}>
                <span className="cc-control-marker" aria-hidden="true">{index === cursor ? '❯' : ''}</span>
                <span className="cc-control-copy">
                  <b>{server.name} <i className={`cc-control-status ${server.status}`} /></b>
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
          </div>
          <button type="button" className="cc-control-refresh" onClick={() => void loadMcp()}>refresh status</button>
        </>
      )}

      {!loading && panel === 'plugin' && (
        <>
          <p className="cc-control-section">Installed plugins ({visiblePlugins.length}/{plugins.length})</p>
          <div className="cc-control-list" role="listbox" aria-label="Installed plugins">
            {visiblePlugins.map((plugin, index) => (
              <div className={`cc-control-row${index === cursor ? ' active' : ''}`} key={`${plugin.name}:${plugin.path ?? ''}`}
                role="option" aria-selected={index === cursor} onMouseEnter={() => setCursor(index)}>
                <span className="cc-control-marker" aria-hidden="true">{index === cursor ? '❯' : ''}</span>
                <span className="cc-control-glyph" aria-hidden="true">◉</span>
                <span className="cc-control-copy"><b>{plugin.name}</b><small>{[plugin.source, plugin.path].filter(Boolean).join(' · ')}</small></span>
                <em>loaded</em>
              </div>
            ))}
            {visiblePlugins.length === 0 && <p className="cc-control-empty">{plugins.length === 0 ? 'No plugins are loaded in this session.' : 'No installed plugins match that search.'}</p>}
            {pluginErrors > 0 && <p className="cc-control-error">{pluginErrors} plugin load {pluginErrors === 1 ? 'error' : 'errors'} reported.</p>}
          </div>
          <button type="button" className="cc-control-refresh" onClick={() => void loadPlugins()}>reload plugins</button>
        </>
      )}

      <footer className="cc-control-footer">
        {panel === 'model' && '↑/↓ to navigate · Enter to use · ←/→ effort · Esc to cancel'}
        {panel === 'mcp' && '↑/↓ to navigate · Enter to reconnect · Space to toggle · Esc to cancel'}
        {panel === 'plugin' && 'Type to search · ↑/↓ to navigate · Esc to go back'}
      </footer>
    </section>
  )
}
