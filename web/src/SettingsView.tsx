import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AGENT_EFFORT_LEVELS,
  AgentDefaultProfile,
  AgentDefaults,
  AgentEffort,
  AgentProviderCatalog,
  AgentProviderModel,
  ProviderUpdateState,
  ProviderAuthStatus,
  osApi,
} from './osApi'
import { RemoteAccessCenter } from './RemoteAccessCenter'
import { SupportCasePanel } from './SupportCasePanel'
import './settings.css'

type AgentType = keyof AgentDefaults

const clearOverrides = (defaults: AgentDefaults): AgentDefaults => ({
  worker: { provider: defaults.worker.provider, model: null, effort: null },
  specialist: { provider: defaults.specialist.provider, model: null, effort: null },
})

const copyDefaults = (defaults: AgentDefaults): AgentDefaults => ({
  worker: { ...defaults.worker },
  specialist: { ...defaults.specialist },
})

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(message) as { error?: string }
    return parsed.error || message
  } catch {
    return message
  }
}

const profileDetails: Record<AgentType, { number: string; label: string; title: string; description: string; scope: string }> = {
  worker: {
    number: '01',
    label: 'Execution',
    title: 'Worker agents',
    description: 'The default profile for agents doing implementation work on the board.',
    scope: 'Board hires, card launches, and Agent OS task jobs',
  },
  specialist: {
    number: '02',
    label: 'Planning and review',
    title: 'Specialist agents',
    description: 'A separate profile for agents that research, plan, audit, or verify work.',
    scope: 'Roadmap strategist, ticket auditors, and delivery verifiers',
  },
}

const modelEffortLevels = (model?: AgentProviderModel): readonly AgentEffort[] => {
  if (!model) return AGENT_EFFORT_LEVELS
  if (model.supportsEffort === false) return []
  return model.supportedEffortLevels?.length ? model.supportedEffortLevels : AGENT_EFFORT_LEVELS
}

const effortLabel = (effort: AgentEffort): string =>
  effort === 'xhigh' ? 'X-high' : effort[0].toUpperCase() + effort.slice(1)

function AgentProfileEditor({
  type,
  profile,
  providers,
  disabled,
  refreshing,
  onChange,
  onRefresh,
}: {
  type: AgentType
  profile: AgentDefaultProfile
  providers: AgentProviderCatalog[]
  disabled: boolean
  refreshing: boolean
  onChange: (profile: AgentDefaultProfile) => void
  onRefresh: () => void
}) {
  const details = profileDetails[type]
  const availableProviders = providers.filter((provider) => provider.available)
  const selectedProvider = providers.find((provider) => provider.id === profile.provider)
  const models = selectedProvider?.models ?? []
  const selectedModel = models.find((model) => model.value === profile.model)
  const supportedEfforts = modelEffortLevels(selectedModel)
  const setEffort = (effort: AgentEffort | null) => onChange({ ...profile, effort })
  const setProvider = (provider: string) => onChange({ provider, model: null, effort: null })
  const setModel = (modelValue: string) => {
    const model = models.find((candidate) => candidate.value === modelValue)
    const levels = modelEffortLevels(model)
    onChange({
      ...profile,
      model: modelValue || null,
      effort: profile.effort && !levels.includes(profile.effort) ? null : profile.effort,
    })
  }
  const currentModelMissing = Boolean(profile.model && !selectedModel)
  const catalogLabel = selectedProvider?.source === 'live'
    ? `Live from ${selectedProvider.name}`
    : selectedProvider?.source === 'cache'
      ? `Last known ${selectedProvider.name} catalog`
      : 'Catalog not discovered yet'
  const modelHelper = selectedModel?.description
    || selectedProvider?.detail
    || (models.length
      ? 'Choose one of the models currently reported by the provider.'
      : `Start an agent with ${selectedProvider?.name ?? 'this provider'}, then refresh to discover models for this account.`)
  const effortHelper = selectedModel?.supportsEffort === false
    ? `${selectedModel.displayName} uses provider-managed reasoning and has no effort override.`
    : selectedModel?.supportedEffortLevels?.length
      ? `Available for ${selectedModel.displayName}: ${selectedModel.supportedEffortLevels.map(effortLabel).join(', ')}.`
      : 'Provider default keeps reasoning provider-managed; explicit levels apply when supported.'

  return (
    <section className="agent-default-row" aria-labelledby={`${type}-profile-title`}>
      <div className="agent-default-identity">
        <div className={`agent-default-glyph ${type}`} aria-hidden="true">
          <span /><span /><span />
        </div>
        <div>
          <p className="agent-default-index">{details.number} / {details.label}</p>
          <h2 id={`${type}-profile-title`}>{details.title}</h2>
          <p>{details.description}</p>
          <small>{details.scope}</small>
        </div>
      </div>

      <div className="agent-default-controls">
        <div className="agent-selection-fields">
          <label className="agent-provider-field" htmlFor={`${type}-default-provider`}>
            <span>Provider</span>
            <select id={`${type}-default-provider`} value={profile.provider} disabled={disabled}
              onChange={(event) => setProvider(event.target.value)}>
              {!availableProviders.some((provider) => provider.id === profile.provider) && (
                <option value={profile.provider} disabled>{profile.provider} (unavailable)</option>
              )}
              {availableProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
            <small>Only agent providers installed and available in this runtime appear here.</small>
          </label>

          <label className="agent-model-field" htmlFor={`${type}-default-model`}>
            <span>Default model</span>
            <select id={`${type}-default-model`} value={profile.model ?? ''}
              disabled={disabled || !selectedProvider} onChange={(event) => setModel(event.target.value)}>
              <option value="">Provider default</option>
              {currentModelMissing && <option value={profile.model ?? ''}>{profile.model} (not in catalog)</option>}
              {models.map((model) => (
                <option key={model.value} value={model.value}>{model.displayName}</option>
              ))}
            </select>
            <small>{modelHelper}</small>
          </label>
        </div>

        <div className="agent-catalog-meta" aria-live="polite">
          <span className={`agent-catalog-source ${selectedProvider?.source ?? 'unavailable'}`}>
            <i aria-hidden="true" />
            {catalogLabel}{models.length ? ` · ${models.length} model${models.length === 1 ? '' : 's'}` : ''}
          </span>
          <button type="button" disabled={disabled || refreshing} onClick={onRefresh}>
            {refreshing ? 'Refreshing…' : 'Refresh models'}
          </button>
        </div>

        <fieldset className="agent-effort-field" disabled={disabled}>
          <legend>Reasoning effort</legend>
          <div className="agent-effort-options">
            <button type="button" className={profile.effort === null ? 'active' : ''}
              aria-pressed={profile.effort === null} onClick={() => setEffort(null)}>Provider</button>
            {supportedEfforts.map((effort) => (
              <button type="button" key={effort} className={profile.effort === effort ? 'active' : ''}
                aria-pressed={profile.effort === effort} onClick={() => setEffort(effort)}>
                {effortLabel(effort)}
              </button>
            ))}
          </div>
          <small>{effortHelper}</small>
        </fieldset>

        <button type="button" className="agent-profile-clear" disabled={disabled || (!profile.model && !profile.effort)}
          onClick={() => onChange({ ...profile, model: null, effort: null })}>
          Use provider defaults for this type
        </button>
      </div>
    </section>
  )
}

function SettingsSkeleton() {
  return (
    <div className="settings-skeleton" aria-label="Loading agent settings">
      {[0, 1].map((row) => (
        <div key={row}><i /><span><b /><b /><b /></span></div>
      ))}
    </div>
  )
}

// A stale provider CLI silently pins a stale model catalog, so staleness is shown,
// never silently fixed: Orchestra hands over the documented command and the operator
// decides when to run it. Upgrading a CLI under a running agent would kill its work.
function ProviderUpdatesPanel({ updates, auth }: {
  updates: ProviderUpdateState[]
  auth: ProviderAuthStatus[]
}) {
  const [copied, setCopied] = useState<string | null>(null)
  // Only CLIs actually present on this machine — a provider you never installed is
  // not "unknown", it is simply not yours (same rule as the hire picker).
  const installed = updates.filter((update) => update.installed)
  if (!installed.length) return null
  const stale = installed.filter((update) => update.update_available)
  const authFor = (providerId: string) => auth.find((entry) => entry.provider_id === providerId)
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <section className="provider-updates">
      <header>
        <h2>Provider CLIs</h2>
        <small>
          {stale.length
            ? 'Agents run the newest CLI found, so updating one immediately surfaces its new models.'
            : 'Orchestra runs the newest CLI it finds on this machine.'}
        </small>
      </header>
      <ul>
        {installed.map((update) => {
          const signIn = authFor(update.provider_id)
          const signedOut = signIn?.status === 'signed_out'
          return (
            <li key={update.provider_id} className={update.update_available || signedOut ? 'stale' : ''}>
              <span className="provider-updates-name">{update.provider_id}</span>
              <span className="provider-updates-version">v{update.installed}</span>
              {/* Auth belongs to the CLI: show what it reports, never a credential. */}
              {signIn?.status === 'authenticated' && (
                <span className="provider-updates-auth" title={signIn.method ?? undefined}>
                  signed in{signIn.account ? ` · ${signIn.account}` : ''}
                </span>
              )}
              {signedOut && <span className="provider-updates-chip signedout">signed out</span>}
              {update.update_available ? (
                <span className="provider-updates-chip">update available → v{update.latest}</span>
              ) : update.unknown_reason ? (
                <span className="provider-updates-chip unknown" title={update.unknown_reason}>unknown</span>
              ) : (
                <span className="provider-updates-chip current">up to date</span>
              )}
              {signedOut && signIn?.login_command && (
                <button type="button" className="provider-updates-action"
                  onClick={() => copy(`login:${update.provider_id}`, signIn.login_command!)}>
                  {copied === `login:${update.provider_id}` ? 'Copied' : `Sign in: ${signIn.login_command}`}
                </button>
              )}
              {update.update_available && update.update_command && (
                <button type="button" className="provider-updates-action"
                  onClick={() => copy(update.provider_id, update.update_command!)}>
                  {copied === update.provider_id ? 'Copied' : `Copy: ${update.update_command}`}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {stale.length > 0 && (
        <small className="provider-updates-note">
          Run the command in a terminal, then restart the daemon when no agent is mid-task —
          Orchestra never upgrades or restarts anything on its own.
        </small>
      )}
    </section>
  )
}

export function SettingsView() {
  const [draft, setDraft] = useState<AgentDefaults | null>(null)
  const [persisted, setPersisted] = useState<AgentDefaults | null>(null)
  const [providers, setProviders] = useState<AgentProviderCatalog[]>([])
  const [providerUpdates, setProviderUpdates] = useState<ProviderUpdateState[]>([])
  const [providerAuth, setProviderAuth] = useState<ProviderAuthStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [defaults, availableProviders] = await Promise.all([
        osApi.getAgentDefaults(),
        osApi.listAgentProviders(),
      ])
      setDraft(copyDefaults(defaults))
      setPersisted(copyDefaults(defaults))
      setProviders(availableProviders)
      // update state is advisory — a registry outage must never block Settings
      osApi.listProviderUpdates().then(setProviderUpdates).catch(() => {})
      osApi.listProviderAuth().then(setProviderAuth).catch(() => {})
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const dirty = useMemo(() => Boolean(draft && persisted && JSON.stringify(draft) !== JSON.stringify(persisted)), [draft, persisted])
  const providerAvailable = useMemo(() => providers.some((provider) => provider.available), [providers])

  const refreshProviders = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      setProviders(await osApi.listAgentProviders())
    } catch (refreshError) {
      setError(errorMessage(refreshError))
    } finally {
      setRefreshing(false)
    }
  }, [])

  const updateProfile = (type: AgentType, profile: AgentDefaultProfile) => {
    setSaved(false)
    setDraft((current) => current ? { ...current, [type]: profile } : current)
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft || !dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const defaults = await osApi.saveAgentDefaults(draft)
      setDraft(copyDefaults(defaults))
      setPersisted(copyDefaults(defaults))
      setSaved(true)
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="settings-shell">
      <form className="settings-page" onSubmit={save}>
        <header className="settings-heading">
          <div>
            <p className="settings-kicker">Runtime policy</p>
            <h1>Agent defaults</h1>
            <p>Choose the provider, model, and reasoning effort Orchestra uses when it creates each type of agent.</p>
          </div>
          <div className="settings-freshness">
            <span aria-hidden="true" />
            New sessions only
            <small>Running and resumed agents keep their stored configuration.</small>
          </div>
        </header>

        {loading ? <SettingsSkeleton /> : !draft ? (
          <section className="settings-load-error" role="alert">
            <p>Agent defaults could not be loaded.</p>
            <small>{error}</small>
            <button type="button" onClick={() => void load()}>Try again</button>
          </section>
        ) : !providerAvailable ? (
          <section className="settings-provider-empty" aria-live="polite">
            <p>No agent provider is available.</p>
            <small>Run Orchestra through the daemon so installed agent providers can report their authentication state and available models.</small>
            <button type="button" disabled={refreshing} onClick={() => void refreshProviders()}>
              {refreshing ? 'Checking…' : 'Check again'}
            </button>
          </section>
        ) : (
          <div className="agent-default-list">
            <ProviderUpdatesPanel updates={providerUpdates} auth={providerAuth} />
            <AgentProfileEditor type="worker" profile={draft.worker} providers={providers}
              disabled={saving} refreshing={refreshing} onRefresh={() => void refreshProviders()}
              onChange={(profile) => updateProfile('worker', profile)} />
            <AgentProfileEditor type="specialist" profile={draft.specialist} providers={providers}
              disabled={saving} refreshing={refreshing} onRefresh={() => void refreshProviders()}
              onChange={(profile) => updateProfile('specialist', profile)} />
          </div>
        )}

        {draft && providerAvailable && (
          <footer className="settings-actions">
            <div className="settings-state" aria-live="polite">
              {error ? <span className="error">{error}</span>
                : saved ? <span className="saved">Settings saved. Future agents will use these profiles.</span>
                  : dirty ? <span>Unsaved changes</span>
                    : <span>Defaults are up to date</span>}
            </div>
            <div>
              <button type="button" className="settings-clear-all" disabled={saving}
                onClick={() => { setDraft(clearOverrides(draft)); setSaved(false) }}>
                Clear overrides
              </button>
              <button type="button" className="settings-discard" disabled={!dirty || saving}
                onClick={() => { if (persisted) setDraft(copyDefaults(persisted)); setError(null); setSaved(false) }}>
                Discard
              </button>
              <button type="submit" className="settings-save" disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save defaults'}
              </button>
            </div>
          </footer>
        )}
      </form>
      <SupportCasePanel />
      <RemoteAccessCenter />
    </main>
  )
}
