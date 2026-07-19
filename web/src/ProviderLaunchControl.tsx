import React, { useState } from 'react'
import type { AgentProviderCatalog } from './osApi'
import { providerLaunchBody } from './agentProviderUi'

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
  onLaunch: (body: { provider?: string }) => Promise<void>
}) {
  const available = providers.filter((provider) => provider.available)
  const [provider, setProvider] = useState('')
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const launch = async (event: React.MouseEvent) => {
    if (stopPropagation) event.stopPropagation()
    if (launching) return
    setLaunching(true)
    setError(null)
    try {
      await onLaunch(providerLaunchBody(provider))
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : 'Launch failed')
    } finally {
      setLaunching(false)
    }
  }

  return (
    <span className={`provider-launch provider-launch-${variant}`} title={error ?? title}
      onClick={(event) => { if (stopPropagation) event.stopPropagation() }}
      onKeyDown={(event) => { if (stopPropagation) event.stopPropagation() }}>
      <button type="button" className={variant === 'hire' ? 'hire-btn' : 'thread-reply'}
        disabled={launching} onClick={launch}>
        {launching ? 'Starting…' : label}
      </button>
      {available.length > 1 && (
        <label className="provider-launch-override">
          <span className="sr-only">Provider override</span>
          <select value={provider} aria-label={`${label} provider override`} title="Optional provider override"
            onChange={(event) => setProvider(event.target.value)}>
            <option value="">Default</option>
            {available.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
      )}
      {error && <span className="sr-only" role="alert">{error}</span>}
    </span>
  )
}
