import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { OsIcon } from './OsIcon'
import {
  COMMAND_CENTER_SECTIONS,
  DEFAULT_COMMAND_CENTER_VIEWS,
  commandCenterDeepLink,
  parseSavedCommandCenterViews,
  readCommandCenterPreferences,
  searchCommandCenter,
  type CanonicalStatus,
  type CommandCenterPreferences,
  type CommandCenterSearchRecord,
  type CommandCenterSection,
  type SavedCommandCenterView,
} from './commandCenterModel'
import { useModalFocusTrap } from './useModalFocusTrap'
import './commandCenter.css'

const PREFERENCES_KEY = 'orchestra-command-center-preferences'
const SAVED_VIEWS_KEY = 'orchestra-command-center-saved-views'
const ONBOARDING_KEY = 'orchestra-command-center-onboarding'

const sectionLabel = (section: CommandCenterSection) =>
  COMMAND_CENTER_SECTIONS.find((item) => item.id === section)?.label ?? section

const savedViewsFromBrowser = () => typeof window === 'undefined'
  ? []
  : parseSavedCommandCenterViews(window.localStorage.getItem(SAVED_VIEWS_KEY))

const preferencesFromBrowser = () => typeof window === 'undefined'
  ? readCommandCenterPreferences(null)
  : readCommandCenterPreferences(window.localStorage.getItem(PREFERENCES_KEY))

export type CommandCenterProps = {
  projectName: string
  projectId: number | null
  section: CommandCenterSection
  counts?: Partial<Record<CommandCenterSection, number>>
  searchRecords: readonly CommandCenterSearchRecord[]
  currentFilters?: Record<string, string>
  children: React.ReactNode
  attentionControl?: React.ReactNode
  connectionState?: 'live' | 'stale' | 'offline'
  onNavigate: (section: CommandCenterSection) => void
  onOpenHref?: (href: string) => void
  onApplySavedView?: (view: SavedCommandCenterView) => void
}

export function CommandCenter({
  projectName,
  projectId,
  section,
  counts = {},
  searchRecords,
  currentFilters = {},
  children,
  attentionControl,
  connectionState = 'live',
  onNavigate,
  onOpenHref,
  onApplySavedView,
}: CommandCenterProps) {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeResult, setActiveResult] = useState(0)
  const [preferences, setPreferences] = useState<CommandCenterPreferences>(preferencesFromBrowser)
  const [savedViews, setSavedViews] = useState<SavedCommandCenterView[]>(savedViewsFromBrowser)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const navRefs = useRef<Array<HTMLButtonElement | null>>([])
  const results = useMemo(() => searchCommandCenter(searchRecords, query), [query, searchRecords])

  useEffect(() => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
  }, [preferences])

  useEffect(() => {
    window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(savedViews))
  }, [savedViews])

  useEffect(() => {
    if (window.localStorage.getItem(ONBOARDING_KEY) !== 'complete') setOnboardingOpen(true)
  }, [])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editing = target?.matches('input, textarea, select, [contenteditable="true"]')
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
        window.requestAnimationFrame(() => searchRef.current?.focus())
      } else if (event.key === '/' && !editing) {
        event.preventDefault()
        setSearchOpen(true)
        window.requestAnimationFrame(() => searchRef.current?.focus())
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [])

  useEffect(() => { setActiveResult(0) }, [query])

  const openResult = (result: CommandCenterSearchRecord | undefined) => {
    if (!result || result.unavailableReason) return
    setSearchOpen(false)
    setQuery('')
    if (onOpenHref) onOpenHref(result.href)
    else window.location.assign(result.href)
  }

  const saveCurrentView = () => {
    const key = JSON.stringify({ section, query, currentFilters })
    if (savedViews.some((item) => JSON.stringify({
      section: item.section,
      query: item.query,
      currentFilters: item.filters,
    }) === key)) return
    const suffix = query.trim() || Object.values(currentFilters).filter(Boolean).join(', ') || 'All'
    const next: SavedCommandCenterView = {
      id: `view-${Date.now().toString(36)}`,
      name: `${sectionLabel(section)} · ${suffix}`,
      section,
      query: query.trim(),
      filters: currentFilters,
      createdAt: new Date().toISOString(),
    }
    setSavedViews((current) => [next, ...current].slice(0, 12))
  }

  const applySavedView = (view: SavedCommandCenterView) => {
    setQuery(view.query)
    onNavigate(view.section)
    onApplySavedView?.(view)
    const href = commandCenterDeepLink(location.search, {
      section: view.section,
      boardId: projectId,
    }, { pathname: location.pathname, hash: location.hash })
    history.replaceState(history.state, '', href)
  }

  const moveNavFocus = (event: React.KeyboardEvent, index: number) => {
    const last = COMMAND_CENTER_SECTIONS.length - 1
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? index === last ? 0 : index + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? index === 0 ? last : index - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : null
    if (next === null) return
    event.preventDefault()
    navRefs.current[next]?.focus()
    onNavigate(COMMAND_CENTER_SECTIONS[next].id)
  }

  const searchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setSearchOpen(false)
      setQuery('')
      return
    }
    if (results.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveResult((current) => (current + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveResult((current) => current === 0 ? results.length - 1 : current - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      openResult(results[activeResult])
    }
  }

  const openOnboarding = () => setOnboardingOpen(true)
  const closeOnboarding = useCallback(() => setOnboardingOpen(false), [])

  return (
    <div className="cc-shell" data-density={preferences.density} data-layout={preferences.layout}
      data-connection={connectionState}>
      <a className="cc-skip-link" href="#command-center-content">Skip to project content</a>
      <header className="cc-project-header">
        <div className="cc-project-heading">
          <p>Project command center</p>
          <h1>{projectName}</h1>
          <span className={`cc-connection cc-connection-${connectionState}`} role="status">
            {connectionState === 'live' ? 'Live' : connectionState === 'stale' ? 'Showing saved state' : 'Offline · read only'}
          </span>
        </div>

        <div className="cc-project-actions">
          <div className="cc-search" role="search">
            <OsIcon name="search" />
            <input ref={searchRef} type="search" value={query}
              placeholder="Search agents, work, discussions, knowledge, deliveries"
              aria-label="Search the project command center"
              aria-controls="command-center-search-results"
              aria-expanded={searchOpen && query.trim().length > 0}
              aria-activedescendant={results[activeResult] ? `cc-search-${results[activeResult].id.replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined}
              role="combobox" autoComplete="off"
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => { setQuery(event.target.value); setSearchOpen(true) }}
              onKeyDown={searchKeyDown} />
            <kbd aria-hidden="true">⌘ K</kbd>
            {searchOpen && query.trim() && (
              <SearchResults results={results} activeIndex={activeResult} onHover={setActiveResult}
                onOpen={openResult} />
            )}
          </div>
          <div className="cc-attention-control" aria-disabled={connectionState === 'offline'}
            {...(connectionState === 'offline' ? { inert: '' } : {})}>
            {attentionControl}
          </div>
          <button className="cc-icon-button" type="button" onClick={openOnboarding}
            aria-label="Open command center walkthrough" title="Create, run, inspect, and review">
            <span aria-hidden="true">i</span>
          </button>
          <details className="cc-preferences">
            <summary aria-label="Command center display preferences"><OsIcon name="workspace" /></summary>
            <div>
              <fieldset>
                <legend>Density</legend>
                <label><input type="radio" name="cc-density" value="comfortable"
                  checked={preferences.density === 'comfortable'}
                  onChange={() => setPreferences((current) => ({ ...current, density: 'comfortable' }))} /> Comfortable</label>
                <label><input type="radio" name="cc-density" value="compact"
                  checked={preferences.density === 'compact'}
                  onChange={() => setPreferences((current) => ({ ...current, density: 'compact' }))} /> Compact</label>
              </fieldset>
              <fieldset>
                <legend>Panel layout</legend>
                <label><input type="radio" name="cc-layout" value="balanced"
                  checked={preferences.layout === 'balanced'}
                  onChange={() => setPreferences((current) => ({ ...current, layout: 'balanced' }))} /> Balanced</label>
                <label><input type="radio" name="cc-layout" value="focus"
                  checked={preferences.layout === 'focus'}
                  onChange={() => setPreferences((current) => ({ ...current, layout: 'focus' }))} /> Focus</label>
                <label><input type="radio" name="cc-layout" value="wide-terminal"
                  checked={preferences.layout === 'wide-terminal'}
                  onChange={() => setPreferences((current) => ({ ...current, layout: 'wide-terminal' }))} /> Wide terminal</label>
              </fieldset>
              <label className="cc-preference-check"><input type="checkbox"
                checked={preferences.terminalTouchBar}
                onChange={(event) => setPreferences((current) => ({ ...current, terminalTouchBar: event.target.checked }))} />
                Show terminal touch controls</label>
              <p>These settings change presentation only. Runtime records remain canonical.</p>
            </div>
          </details>
        </div>

        <nav className="cc-project-nav" aria-label="Project command center" role="tablist">
          {COMMAND_CENTER_SECTIONS.map((item, index) => (
            <button key={item.id} ref={(element) => { navRefs.current[index] = element }}
              id={`cc-section-tab-${item.id}`} type="button" role="tab"
              aria-selected={section === item.id} aria-controls="command-center-content"
              tabIndex={section === item.id ? 0 : -1}
              className={section === item.id ? 'active' : ''}
              title={item.description} onClick={() => onNavigate(item.id)}
              onKeyDown={(event) => moveNavFocus(event, index)}>
              <span>{item.label}</span>
              {typeof counts[item.id] === 'number' && <b>{counts[item.id]}</b>}
            </button>
          ))}
        </nav>

        <div className="cc-saved-views" aria-label="Saved project views">
          <span>Views</span>
          {[...DEFAULT_COMMAND_CENTER_VIEWS, ...savedViews].slice(0, 10).map((view) => (
            <button key={view.id} type="button" onClick={() => applySavedView(view)}>{view.name}</button>
          ))}
          <button className="cc-save-view" type="button" onClick={saveCurrentView}>
            <OsIcon name="plus" size={13} /> Save current
          </button>
        </div>
      </header>

      {connectionState === 'offline' && (
        <div className="cc-offline-banner" role="alert">
          <OsIcon name="attention" />
          <div><strong>Orchestra is offline</strong><span>Saved state remains visible. Mutating controls are disabled until the daemon reconnects.</span></div>
        </div>
      )}
      <main id="command-center-content" className="cc-content" role="tabpanel"
        aria-labelledby={`cc-section-tab-${section}`} tabIndex={-1}
        aria-disabled={connectionState === 'offline'}
        {...(connectionState === 'offline' ? { inert: '' } : {})}>
        {children}
      </main>

      <CommandCenterWalkthrough open={onboardingOpen} onClose={closeOnboarding} />
    </div>
  )
}

function SearchResults({
  results,
  activeIndex,
  onHover,
  onOpen,
}: {
  results: CommandCenterSearchRecord[]
  activeIndex: number
  onHover: (index: number) => void
  onOpen: (result: CommandCenterSearchRecord) => void
}) {
  return (
    <div className="cc-search-results" id="command-center-search-results" role="listbox"
      aria-label="Project search results">
      {results.length === 0 ? (
        <div className="cc-search-empty" role="status">
          <strong>No matching canonical records</strong>
          <span>Search names, paths, providers, statuses, or delivery evidence.</span>
        </div>
      ) : results.map((result, index) => {
        const unavailable = Boolean(result.unavailableReason)
        return (
          <button key={result.id} id={`cc-search-${result.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
            type="button" role="option" aria-selected={activeIndex === index}
            className={activeIndex === index ? 'active' : ''} disabled={unavailable}
            onMouseEnter={() => onHover(index)} onClick={() => onOpen(result)}>
            <span className={`cc-search-kind cc-search-kind-${result.kind}`}>{result.kind}</span>
            <span><strong>{result.title}</strong><small>{result.unavailableReason ?? result.description}</small></span>
            {result.status && <em>{result.status}</em>}
          </button>
        )
      })}
      <footer><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open <kbd>Esc</kbd> close</footer>
    </div>
  )
}

export function CommandCenterStatus({ value, compact = false }: { value: CanonicalStatus; compact?: boolean }) {
  return (
    <span className={`cc-status cc-status-${value.tone}${compact ? ' compact' : ''}`}
      title={value.description} data-known={value.known}>
      <span aria-hidden="true" />{value.label}<span className="sr-only">. {value.description}</span>
    </span>
  )
}

export function CommandCenterWalkthrough({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [step, setStep] = useState(0)
  useModalFocusTrap(open, dialogRef, onClose, closeRef)
  useEffect(() => { if (open) setStep(0) }, [open])
  if (!open) return null
  const steps = [
    { label: 'Create', title: 'Define the work', text: 'Publish a contract with stable deliverables, criteria, dependencies, access needs, and budgets. Creating or inspecting a workspace does not start a model.' },
    { label: 'Run', title: 'Start one canonical job', text: 'The scheduler binds one durable agent, provider session, worktree, and job. Provider differences stay visible and unsupported actions fail closed.' },
    { label: 'Inspect', title: 'Watch the exact runtime', text: 'Agent Home keeps durable conversation beside raw PTY bytes. Claims never replace process exits, diffs, tests, reviews, or artifacts.' },
    { label: 'Review', title: 'Verify the delivery', text: 'Job Detail compares the frozen request with delivered results, criterion evidence, gaps, overrides, and revision history before acceptance.' },
  ]
  const item = steps[step]
  const finish = () => {
    window.localStorage.setItem(ONBOARDING_KEY, 'complete')
    onClose()
  }
  return (
    <div className="cc-dialog-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div ref={dialogRef} className="cc-walkthrough" role="dialog" aria-modal="true"
        aria-labelledby="cc-walkthrough-title" tabIndex={-1}>
        <header>
          <div><p>Orchestra operating loop</p><h2 id="cc-walkthrough-title">{item.title}</h2></div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close walkthrough"><OsIcon name="close" /></button>
        </header>
        <ol className="cc-walkthrough-steps" aria-label="Walkthrough progress">
          {steps.map((candidate, index) => (
            <li key={candidate.label} data-state={index === step ? 'current' : index < step ? 'complete' : 'upcoming'}>
              <button type="button" aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}>
                <span>{index + 1}</span>{candidate.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="cc-walkthrough-copy" aria-live="polite">
          <span>{String(step + 1).padStart(2, '0')}</span><p>{item.text}</p>
        </div>
        <footer>
          <button type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}>Back</button>
          {step < steps.length - 1
            ? <button className="primary" type="button" onClick={() => setStep((current) => current + 1)}>Continue</button>
            : <button className="primary" type="button" onClick={finish}>Open command center</button>}
        </footer>
      </div>
    </div>
  )
}

export function TerminalTouchControls({
  processStatus,
  readOnly,
  onInterrupt,
  onStop,
  onNewShell,
}: {
  processStatus: CanonicalStatus
  readOnly: boolean
  onInterrupt?: () => void
  onStop?: () => void
  onNewShell?: () => void
}) {
  return (
    <div className="cc-terminal-touch" aria-label="Terminal controls" data-read-only={readOnly}>
      <CommandCenterStatus value={processStatus} compact />
      {readOnly ? <span className="cc-terminal-read-only"><OsIcon name="policy" /> View only</span> : <>
        <button type="button" onClick={onInterrupt} disabled={!onInterrupt}>Interrupt</button>
        <button type="button" onClick={onStop} disabled={!onStop}>Stop</button>
        <button type="button" onClick={onNewShell} disabled={!onNewShell}><OsIcon name="plus" /> New shell</button>
      </>}
    </div>
  )
}
