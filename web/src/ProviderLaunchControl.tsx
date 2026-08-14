import React, { useState } from 'react'
import type { AgentProviderCatalog } from './osApi'
import {
  ACCESS_PROFILES,
  hasAgentCapability,
  providerLaunchBody,
  type AccessProfile,
  type ProviderLaunchBody,
} from './agentProviderUi'

export function ProviderLaunchControl({
  providers,
  label,
  title,
  variant,
  stopPropagation = false,
  onLaunch,
}: {
  providers: AgentProviderCatalog[]
  label: string
  title: string
  variant: 'hire' | 'card'
  stopPropagation?: boolean
  onLaunch: (body: ProviderLaunchBody) => Promise<void>
}) {
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [accessProfile, setAccessProfile] = useState<AccessProfile | ''>('')
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedProvider = providers.find((candidate) => candidate.id === provider)
  const selectedModel = selectedProvider?.models.find((candidate) => candidate.value === model)
  const effortLevels = [...new Set(
    (selectedModel ? [selectedModel] : selectedProvider?.models ?? [])
      .flatMap((candidate) => candidate.supportedEffortLevels ?? []),
  )]
  const canSelectModel = !!selectedProvider?.available && hasAgentCapability(
    selectedProvider.capabilities, 'model', selectedProvider.id,
  ) && selectedProvider.models.length > 0
  const canSelectEffort = !!selectedProvider?.available && hasAgentCapability(
    selectedProvider.capabilities, 'effort', selectedProvider.id,
  ) && effortLevels.length > 0
  const canSelectAccess = !!selectedProvider?.available && hasAgentCapability(
    selectedProvider.capabilities, 'access_profile', selectedProvider.id,
  )

  const changeProvider = (nextProvider: string) => {
    setProvider(nextProvider)
    setModel('')
    setEffort('')
    setAccessProfile('')
  }

  const changeModel = (nextModel: string) => {
    setModel(nextModel)
    setEffort('')
  }

  const launch = async (event: React.MouseEvent) => {
    if (stopPropagation) event.stopPropagation()
    if (launching) return
    const body = {
      ...providerLaunchBody(provider, model, effort, accessProfile || null),
      idempotency_key: window.crypto.randomUUID(),
    }
    setLaunching(true)
    setError(null)
    try {
      await onLaunch(body)
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : 'Launch failed')
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className={`provider-launch provider-launch-${variant}`} title={error ?? title}
      onClick={(event) => { if (stopPropagation) event.stopPropagation() }}
      onKeyDown={(event) => { if (stopPropagation) event.stopPropagation() }}>
      <button type="button" className={variant === 'hire' ? 'hire-btn' : 'thread-reply'}
        disabled={launching} onClick={launch}>
        {launching ? 'Starting…' : label}
      </button>
      {providers.length > 0 && (
        <label className="provider-launch-override">
          <span className="sr-only">Provider override</span>
          <select value={provider} aria-label={`${label} provider override`} title="Optional provider override"
            onChange={(event) => changeProvider(event.target.value)}>
            <option value="">Default</option>
            {providers.map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={!candidate.available}>
                {candidate.name}{candidate.available ? '' : ' (unavailable)'}
              </option>
            ))}
          </select>
        </label>
      )}
      {selectedProvider && (canSelectModel || canSelectEffort || canSelectAccess) && (
        <details className="provider-launch-config">
          <summary aria-label={`${label} launch options`}>Options</summary>
          <span className="provider-launch-config-panel">
            <strong>{selectedProvider.name} launch</strong>
            {canSelectModel && (
              <label>
                <span>Model</span>
                <select value={model} aria-label={`${label} model override`}
                  onChange={(event) => changeModel(event.target.value)}>
                  <option value="">Provider default</option>
                  {selectedProvider.models.map((candidate) => (
                    <option key={candidate.value} value={candidate.value}>{candidate.displayName}</option>
                  ))}
                </select>
              </label>
            )}
            {canSelectEffort && (
              <label>
                <span>Reasoning effort</span>
                <select value={effort} aria-label={`${label} effort override`}
                  onChange={(event) => setEffort(event.target.value)}>
                  <option value="">Provider default</option>
                  {effortLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </label>
            )}
            {canSelectAccess && (
              <label>
                <span>Access</span>
                <select value={accessProfile} aria-label={`${label} access profile override`}
                  onChange={(event) => setAccessProfile(event.target.value as AccessProfile | '')}>
                  <option value="">Provider default</option>
                  {ACCESS_PROFILES.map((profile) => (
                    <option key={profile.value} value={profile.value}>{profile.label}</option>
                  ))}
                </select>
              </label>
            )}
          </span>
        </details>
      )}
      {error && <span className="provider-launch-error" role="alert">{error}</span>}
    </div>
  )
}
