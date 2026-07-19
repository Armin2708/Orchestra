import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AGENT_EFFORT_LEVELS,
  AgentDefaultProfile,
  AgentDefaults,
  AgentEffort,
  osApi,
} from './osApi'
import './settings.css'

type AgentType = keyof AgentDefaults

const emptyDefaults = (): AgentDefaults => ({
  worker: { model: null, effort: null },
  specialist: { model: null, effort: null },
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

function AgentProfileEditor({
  type,
  profile,
  disabled,
  onChange,
}: {
  type: AgentType
  profile: AgentDefaultProfile
  disabled: boolean
  onChange: (profile: AgentDefaultProfile) => void
}) {
  const details = profileDetails[type]
  const setEffort = (effort: AgentEffort | null) => onChange({ ...profile, effort })

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
        <label className="agent-model-field" htmlFor={`${type}-default-model`}>
          <span>Default model</span>
          <input
            id={`${type}-default-model`}
            type="text"
            value={profile.model ?? ''}
            disabled={disabled}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder="Provider default"
            onChange={(event) => onChange({ ...profile, model: event.target.value || null })}
          />
          <small>Use a provider alias or full model ID. Leave blank to inherit the provider default.</small>
        </label>

        <fieldset className="agent-effort-field" disabled={disabled}>
          <legend>Reasoning effort</legend>
          <div className="agent-effort-options">
            <button type="button" className={profile.effort === null ? 'active' : ''}
              aria-pressed={profile.effort === null} onClick={() => setEffort(null)}>Provider</button>
            {AGENT_EFFORT_LEVELS.map((effort) => (
              <button type="button" key={effort} className={profile.effort === effort ? 'active' : ''}
                aria-pressed={profile.effort === effort} onClick={() => setEffort(effort)}>
                {effort === 'xhigh' ? 'X-high' : effort[0].toUpperCase() + effort.slice(1)}
              </button>
            ))}
          </div>
          <small>Availability depends on the selected model. Unsupported values are rejected by the provider.</small>
        </fieldset>

        <button type="button" className="agent-profile-clear" disabled={disabled || (!profile.model && !profile.effort)}
          onClick={() => onChange({ model: null, effort: null })}>
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

export function SettingsView() {
  const [draft, setDraft] = useState<AgentDefaults | null>(null)
  const [persisted, setPersisted] = useState<AgentDefaults | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const defaults = await osApi.getAgentDefaults()
      setDraft(copyDefaults(defaults))
      setPersisted(copyDefaults(defaults))
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const dirty = useMemo(() => Boolean(draft && persisted && JSON.stringify(draft) !== JSON.stringify(persisted)), [draft, persisted])

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
            <p>Choose the model and reasoning effort Orchestra uses when it creates each type of agent.</p>
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
        ) : (
          <div className="agent-default-list">
            <AgentProfileEditor type="worker" profile={draft.worker} disabled={saving}
              onChange={(profile) => updateProfile('worker', profile)} />
            <AgentProfileEditor type="specialist" profile={draft.specialist} disabled={saving}
              onChange={(profile) => updateProfile('specialist', profile)} />
          </div>
        )}

        {draft && (
          <footer className="settings-actions">
            <div className="settings-state" aria-live="polite">
              {error ? <span className="error">{error}</span>
                : saved ? <span className="saved">Settings saved. Future agents will use these profiles.</span>
                  : dirty ? <span>Unsaved changes</span>
                    : <span>Defaults are up to date</span>}
            </div>
            <div>
              <button type="button" className="settings-clear-all" disabled={saving}
                onClick={() => { setDraft(emptyDefaults()); setSaved(false) }}>
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
    </main>
  )
}
