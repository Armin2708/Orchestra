import React from 'react'
import { normalizeProvider, providerLabel } from './agentProviderUi'

export function ProviderBadge({ provider, compact = false }: { provider?: string | null; compact?: boolean }) {
  const id = normalizeProvider(provider)
  return (
    <span className={`provider-badge${compact ? ' compact' : ''}`} data-provider={id}
      title={`${providerLabel(id)} agent provider`} aria-label={`${providerLabel(id)} provider`}>
      {providerLabel(id)}
    </span>
  )
}
