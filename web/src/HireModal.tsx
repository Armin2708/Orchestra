import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import type { AgentProviderCatalog } from './osApi'
import {
  ACCESS_PROFILES,
  hasAgentCapability,
  modelDisplayLabel,
  orderEffortLevels,
  providerLaunchBody,
  type AccessProfile,
} from './agentProviderUi'

// Hire quick-card: every field is optional — a blank Create hires exactly like the
// old one-click button (server defaults), tweaks flow through to the /hire body.

const ROLES = [
  { value: '', label: 'Generalist', hint: 'picks up cards, builds and ships work end to end' },
  { value: 'strategist', label: 'Strategist', hint: 'brainstorms, researches and writes tickets — never edits files' },
  { value: 'auditor', label: 'Auditor', hint: 'audits one roadmap idea into an excellent ticket, then leaves' },
  { value: 'verifier', label: 'Verifier', hint: 'checks one delivered card against its acceptance criteria' },
] as const

const NAME_HINTS = ['amber-fox', 'cedar-owl', 'ivory-crane', 'copper-lynx', 'slate-wren']

export function HireControl({
  providers,
  boardId,
  takenNames,
  onHired,
}: {
  providers: AgentProviderCatalog[]
  boardId: number
  takenNames: string[]
  onHired: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="hire-btn" title="Hire an autonomous agent on this project"
        onClick={() => setOpen(true)}>+ Hire</button>
      {open && (
        <HireModal providers={providers} boardId={boardId} takenNames={takenNames}
          onClose={() => setOpen(false)}
          onHired={() => { setOpen(false); onHired() }} />
      )}
    </>
  )
}

function HireModal({
  providers,
  boardId,
  takenNames,
  onClose,
  onHired,
}: {
  providers: AgentProviderCatalog[]
  boardId: number
  takenNames: string[]
  onClose: () => void
  onHired: () => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<(typeof ROLES)[number]['value']>('')
  const [specialty, setSpecialty] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [accessProfile, setAccessProfile] = useState<AccessProfile | ''>('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const nameHint = useRef(NAME_HINTS[Math.floor(Math.random() * NAME_HINTS.length)])

  // only offer providers the operator actually has installed/authed — a missing
  // Codex CLI simply doesn't appear, so the picker reflects what's usable here
  const availableProviders = providers.filter((candidate) => candidate.available)
  // model/effort/access selectors are revealed by picking a provider button —
  // no selection means "server default", so nothing to tune below the buttons
  const effectiveProvider = providers.find((candidate) => candidate.id === provider)
  // the SDK catalog carries a synthetic "default" model — the picker names real
  // models only, and an untouched picker already falls through to the server default
  const selectableModels = (effectiveProvider?.models ?? [])
    .filter((candidate) => candidate.value.toLowerCase() !== 'default')
  const selectedModel = selectableModels.find((candidate) => candidate.value === model)
  const effortLevels = orderEffortLevels([...new Set(
    (selectedModel ? [selectedModel] : selectableModels)
      .flatMap((candidate) => candidate.supportedEffortLevels ?? []),
  )])
  const canSelectModel = !!effectiveProvider?.available && hasAgentCapability(
    effectiveProvider.capabilities, 'model', effectiveProvider.id,
  ) && selectableModels.length > 0
  const canSelectEffort = !!effectiveProvider?.available && hasAgentCapability(
    effectiveProvider.capabilities, 'effort', effectiveProvider.id,
  ) && effortLevels.length > 0
  const canSelectAccess = !!effectiveProvider?.available && hasAgentCapability(
    effectiveProvider.capabilities, 'access_profile', effectiveProvider.id,
  )
  const cleanName = name.trim()
  const nameTaken = !!cleanName && takenNames.includes(cleanName)
  const roleHint = ROLES.find((candidate) => candidate.value === role)?.hint ?? ''

  useEffect(() => { nameRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // with a single available provider there's no choice to make — preselect it so its
  // model/effort selectors show immediately instead of hiding behind a lone button
  useEffect(() => {
    if (!provider && availableProviders.length === 1) setProvider(availableProviders[0].id)
  }, [provider, availableProviders])

  const changeProvider = (nextProvider: string) => {
    setProvider(nextProvider)
    setModel('')
    setEffort('')
    setAccessProfile('')
  }

  const create = async () => {
    if (creating || nameTaken) return
    const body = {
      ...providerLaunchBody(provider, model, effort, accessProfile || null),
      ...(cleanName ? { name: cleanName } : {}),
      ...(role ? { role } : {}),
      idempotency_key: window.crypto.randomUUID(),
    }
    setCreating(true)
    setError(null)
    try {
      const agent = await api('POST', `/boards/${boardId}/hire`, body)
      const brief = specialty.trim()
      if (brief && agent?.name) {
        // the specialty rides in as the operator's first message — no server contract change
        await api('POST', '/messages', {
          board_id: boardId, to: agent.name,
          body: `Operator brief — your specialty on this board: ${brief}. Prioritize work that fits this focus.`,
        }).catch(() => {})
      }
      onHired()
    } catch (hireError) {
      setError(hireError instanceof Error ? hireError.message : 'Hire failed')
      setCreating(false)
    }
  }

  return createPortal(
    <>
      <div className="idea-scrim" onClick={onClose} />
      <div className="hire-modal" role="dialog" aria-modal="true" aria-label="Hire an agent"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
            event.preventDefault()
            void create()
          }
        }}>
        <span className="idea-modal-kicker">New hire</span>
        <h3>Tune your agent — or just hit Create</h3>
        <div className="hire-modal-grid">
          <label className="hire-field">
            <span>Name</span>
            <input ref={nameRef} type="text" value={name} maxLength={32}
              placeholder={`auto — e.g. ${nameHint.current}`}
              onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} />
            {nameTaken && <em className="hire-field-warn">already on this board — pick another</em>}
          </label>
          <label className="hire-field">
            <span>Role</span>
            <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
              {ROLES.map((candidate) => (
                <option key={candidate.value} value={candidate.value}>{candidate.label}</option>
              ))}
            </select>
            <em className="hire-field-hint">{roleHint}</em>
          </label>
          <label className="hire-field hire-field-wide">
            <span>Specialty <i>optional</i></span>
            <textarea rows={2} value={specialty}
              placeholder="e.g. frontend polish, flaky tests, API performance — sent as its first brief"
              onChange={(event) => setSpecialty(event.target.value)} />
          </label>
          {availableProviders.length > 0 && (
            <div className="hire-field hire-field-wide">
              <span>Provider</span>
              <div className="hire-seg" role="group" aria-label="Choose a provider">
                {availableProviders.map((candidate) => (
                  <button key={candidate.id} type="button"
                    className={`hire-seg-btn${provider === candidate.id ? ' selected' : ''}`}
                    aria-pressed={provider === candidate.id}
                    onClick={() => changeProvider(provider === candidate.id ? '' : candidate.id)}>
                    {candidate.name}
                  </button>
                ))}
              </div>
              <em className="hire-field-hint">
                {availableProviders.length > 1 && !provider
                  ? 'Pick a provider to tune its model and effort.'
                  : 'Pick a model and reasoning effort below.'}
              </em>
            </div>
          )}
          {canSelectModel && (
            <div className="hire-field hire-field-wide">
              <span>Model</span>
              <div className="hire-seg" role="group" aria-label="Choose a model">
                {selectableModels.map((candidate) => (
                  <button key={candidate.value} type="button"
                    className={`hire-seg-btn${model === candidate.value ? ' selected' : ''}`}
                    aria-pressed={model === candidate.value}
                    onClick={() => { setModel(candidate.value); setEffort('') }}>
                    {modelDisplayLabel(candidate)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {canSelectEffort && (
            <div className="hire-field hire-field-wide">
              <span>Reasoning effort</span>
              {effortLevels.length === 1 ? (
                <div className="hire-seg" role="group" aria-label="Reasoning effort">
                  <button type="button"
                    className={`hire-seg-btn${effort === effortLevels[0] ? ' selected' : ''}`}
                    aria-pressed={effort === effortLevels[0]}
                    onClick={() => setEffort(effortLevels[0])}>{effortLevels[0]}</button>
                </div>
              ) : (
                <div className="hire-slider">
                  <input type="range" min={0} max={effortLevels.length - 1} step={1}
                    aria-label="Reasoning effort"
                    value={effort ? effortLevels.indexOf(effort) : Math.floor((effortLevels.length - 1) / 2)}
                    onChange={(event) => setEffort(effortLevels[Number(event.target.value)])} />
                  <div className="hire-slider-ticks">
                    {effortLevels.map((level) => (
                      <button key={level} type="button"
                        className={`hire-slider-tick${effort === level ? ' selected' : ''}`}
                        onClick={() => setEffort(level)}>{level}</button>
                    ))}
                  </div>
                </div>
              )}
              <em className="hire-field-hint">
                {effort ? `Effort: ${effort}` : 'Untouched — uses the provider default.'}
              </em>
            </div>
          )}
          {canSelectAccess && (
            <div className="hire-field hire-field-wide">
              <span>Access</span>
              <div className="hire-seg" role="group" aria-label="Choose an access mode">
                {ACCESS_PROFILES.map((profile) => (
                  <button key={profile.value} type="button"
                    className={`hire-seg-btn${accessProfile === profile.value ? ' selected' : ''}`}
                    aria-pressed={accessProfile === profile.value}
                    onClick={() => setAccessProfile(profile.value)}>{profile.label}</button>
                ))}
              </div>
              <em className="hire-field-hint">
                {ACCESS_PROFILES.find((profile) => profile.value === accessProfile)?.hint ?? ''}
              </em>
            </div>
          )}
        </div>
        <div className="idea-modal-actions">
          {error && <span className="provider-launch-error hire-modal-error" role="alert">{error}</span>}
          <span className="idea-modal-spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn hire-create" disabled={creating || nameTaken}
            onClick={() => void create()}>
            {creating ? 'Hiring…' : 'Create'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
