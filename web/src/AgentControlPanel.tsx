import React, { useEffect, useState } from 'react'
import { api } from './api'
import type { AgentControlPanelName } from './agentTerminalControls'
import './agentTerminalControls.css'

export type SessionModel = {
  model: string
  resolvedModel?: string
  displayName?: string
  description?: string
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
  mcp: { title: 'MCP servers', hint: 'Live status and controls from this Claude session.' },
  plugin: { title: 'Loaded plugins', hint: 'Reloads plugin commands from disk without restarting the agent.' },
}

export function AgentControlPanel({ agentId, panel, models, currentModel, onClose, onChange }: {
  agentId: number
  panel: AgentControlPanelName
  models: SessionModel[]
  currentModel: string | null
  onClose: () => void
  onChange: () => void
}) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([])
  const [pluginErrors, setPluginErrors] = useState(0)
  const [loading, setLoading] = useState(panel !== 'model')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    if (panel === 'mcp') void loadMcp()
    if (panel === 'plugin') void loadPlugins()
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

  const meta = titles[panel]
  return (
    <section className="cc-control-panel" aria-label={meta.title}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault(); event.stopPropagation(); onClose()
      }}>
      <header className="cc-control-head">
        <div><strong>{meta.title}</strong><span>{meta.hint}</span></div>
        <button type="button" onClick={onClose} aria-label={`Close ${meta.title}`}>×</button>
      </header>

      {error && <p className="cc-control-error" role="alert">{error}</p>}
      {loading && <p className="cc-control-empty">Loading session controls…</p>}

      {!loading && panel === 'model' && (
        <div className="cc-control-list" role="listbox" aria-label="Available models">
          {models.map((model) => {
            const selected = model.model === currentModel || model.resolvedModel === currentModel
            return (
              <button type="button" role="option" aria-selected={selected} key={model.model}
                className={`cc-control-row${selected ? ' selected' : ''}`}
                onClick={async () => {
                  if (selected || busy) return
                  setBusy(model.model); setError(null)
                  try {
                    await api('POST', `/agents/${agentId}/model`, { model: model.model })
                    onChange(); onClose()
                  } catch (cause) { setError(readableError(cause)); setBusy(null) }
                }}>
                <span><b>{model.displayName ?? model.model}</b>{model.description && <small>{model.description}</small>}</span>
                <em>{busy === model.model ? 'switching…' : selected ? 'current' : model.model}</em>
              </button>
            )
          })}
          {models.length === 0 && <p className="cc-control-empty">Claude has not reported any models for this session yet.</p>}
        </div>
      )}

      {!loading && panel === 'mcp' && (
        <div className="cc-control-list">
          {servers.map((server) => (
            <div className="cc-control-row" key={server.name}>
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
          {plugins.map((plugin) => (
            <div className="cc-control-row" key={`${plugin.name}:${plugin.path ?? ''}`}>
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
