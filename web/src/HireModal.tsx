import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import type { AgentProviderCatalog } from './osApi'
import {
  ACCESS_PROFILES,
  hasAgentCapability,
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

  // model/effort/access selectors stay live at "Default provider" by falling back
  // to the default provider's catalog entry, so tuning never requires an override
  const effectiveProvider = providers.find((candidate) => candidate.id === (provider || 'claude'))
  const selectedModel = effectiveProvider?.models.find((candidate) => candidate.value === model)
  const effortLevels = [...new Set(
    (selectedModel ? [selectedModel] : effectiveProvider?.models ?? [])
      .flatMap((candidate) => candidate.supportedEffortLevels ?? []),
  )]
  const canSelectModel = !!effectiveProvider?.available && hasAgentCapability(
    effectiveProvider.capabilities, 'model', effectiveProvider.id,
  ) && effectiveProvider.models.length > 0
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
    if (body.access_profile === 'full_access' && !window.confirm(
      `Hire ${cleanName || 'this agent'} with full access? It can read and modify files outside the workspace and run unsandboxed commands.`,
    )) return
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
          {providers.length > 0 && (
            <label className="hire-field">
              <span>Provider</span>
              <select value={provider} onChange={(event) => changeProvider(event.target.value)}>
                <option value="">Default</option>
                {providers.map((candidate) => (
                  <option key={candidate.id} value={candidate.id} disabled={!candidate.available}>
                    {candidate.name}{candidate.available ? '' : ' (unavailable)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canSelectModel && (
            <label className="hire-field">
              <span>Model</span>
              <select value={model} onChange={(event) => { setModel(event.target.value); setEffort('') }}>
                <option value="">Provider default</option>
                {effectiveProvider!.models.map((candidate) => (
                  <option key={candidate.value} value={candidate.value}>{candidate.displayName}</option>
                ))}
              </select>
            </label>
          )}
          {canSelectEffort && (
            <label className="hire-field">
              <span>Reasoning effort</span>
              <select value={effort} onChange={(event) => setEffort(event.target.value)}>
                <option value="">Provider default</option>
                {effortLevels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          )}
          {canSelectAccess && (
            <label className="hire-field">
              <span>Access</span>
              <select value={accessProfile}
                onChange={(event) => setAccessProfile(event.target.value as AccessProfile | '')}>
                <option value="">Provider default</option>
                {ACCESS_PROFILES.map((profile) => (
                  <option key={profile.value} value={profile.value}>{profile.label}</option>
                ))}
              </select>
              <em className="hire-field-hint">
                {ACCESS_PROFILES.find((profile) => profile.value === accessProfile)?.hint ?? ''}
              </em>
            </label>
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
