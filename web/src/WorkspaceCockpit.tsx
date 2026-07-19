import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentTerminal } from './AgentTerminal'
import { Agent, Card, Snapshot } from './api'
import { ProviderBadge } from './ProviderBadge'
import {
  ContextItem,
  DriverCapability,
  EvidenceBundle,
  OsEvent,
  osApi,
  Policy,
  TaskContract,
  Workspace,
  WorkspaceConflict,
  WorkspaceProcess,
} from './osApi'
import { OsIcon, OsIconName } from './OsIcon'
import { ProcessTerminal, ProcessTerminalHandle } from './ProcessTerminal'
import { useModalFocusTrap } from './useModalFocusTrap'
import {
  ChangesPane,
  ContextPane,
  ConversationPane,
  EvidencePane,
  PaneFrame,
  PaneSkeleton,
  PolicyPane,
  ProcessesPane,
  resource,
  Resource,
} from './WorkspacePanes'

type PaneId = 'terminal' | 'agent' | 'changes' | 'evidence' | 'processes' | 'context' | 'policy'

const panes: Array<{ id: PaneId; label: string; icon: OsIconName }> = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'agent', label: 'Agent', icon: 'message' },
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'evidence', label: 'Evidence', icon: 'evidence' },
  { id: 'processes', label: 'Processes', icon: 'process' },
  { id: 'context', label: 'Context', icon: 'context' },
  { id: 'policy', label: 'Policy', icon: 'policy' },
]

const detailPanes = panes.filter((pane) => !['terminal', 'agent'].includes(pane.id))

const useMedia = (query: string) => {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

const timeLabel = (value: string | null | undefined) => {
  if (!value) return 'never'
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function WorkspaceCockpit({ snaps, onChange }: { snaps: Snapshot[]; onChange: () => void }) {
  const mobile = useMedia('(max-width: 820px)')
  const snapsRef = useRef(snaps)
  snapsRef.current = snaps
  const boardKey = snaps.map((snapshot) => snapshot.board.id).join(',')

  const [workspaces, setWorkspaces] = useState<Resource<Workspace[]>>(resource([]))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeProcessId, setActiveProcessId] = useState<string | null>(null)
  const [centerPane, setCenterPane] = useState<'terminal' | 'agent'>('terminal')
  const [sidePane, setSidePane] = useState<Exclude<PaneId, 'terminal' | 'agent'>>('changes')
  const [mobilePane, setMobilePane] = useState<PaneId>('terminal')
  const [reloadTick, setReloadTick] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [createCard, setCreateCard] = useState<Card | null>(null)
  const [liveAgent, setLiveAgent] = useState<Agent | null>(null)
  const [headerError, setHeaderError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [processes, setProcesses] = useState<Resource<WorkspaceProcess[]>>(resource([]))
  const [events, setEvents] = useState<Resource<OsEvent[]>>(resource([]))
  const [evidence, setEvidence] = useState<Resource<EvidenceBundle | null>>(resource(null))
  const [context, setContext] = useState<Resource<ContextItem[]>>(resource([]))
  const [policies, setPolicies] = useState<Resource<Policy[]>>(resource([]))
  const [contract, setContract] = useState<Resource<TaskContract | null>>(resource(null))
  const [conflicts, setConflicts] = useState<Resource<WorkspaceConflict[]>>(resource([]))
  const [drivers, setDrivers] = useState<Resource<DriverCapability[]>>(resource([]))

  const terminalRef = useRef<ProcessTerminalHandle>(null)
  const commandRef = useRef<HTMLInputElement>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  const loadGenerationRef = useRef(0)
  const resourceWorkspaceRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  const selectWorkspace = useCallback((workspace: Workspace) => {
    const id = String(workspace.id)
    selectedIdRef.current = id
    loadGenerationRef.current++
    setActiveProcessId(null)
    setProcesses({ status: 'loading', data: [], error: null })
    setSelectedId(id)
    localStorage.setItem('orchestra-os-workspace', id)
  }, [])

  const loadWorkspaces = useCallback(async (quiet = false) => {
    const currentSnaps = snapsRef.current
    if (!quiet) setWorkspaces((current) => ({ ...current, status: 'loading', error: null }))
    try {
      const groups = await Promise.all(currentSnaps.map((snapshot) => osApi.listWorkspaces(snapshot.board.id)))
      const next = groups.flat().filter((workspace) => workspace.status !== 'archived')
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      setWorkspaces({ status: 'ready', data: next, error: null })
      setSelectedId((current) => {
        const requested = localStorage.getItem('orchestra-os-workspace')
        const wanted = [requested, current].find((candidate) => candidate && next.some((workspace) => String(workspace.id) === candidate))
        const fallback = wanted ?? (next[0] ? String(next[0].id) : null)
        if (fallback) localStorage.setItem('orchestra-os-workspace', fallback)
        selectedIdRef.current = fallback
        return fallback
      })
    } catch (error) {
      setWorkspaces((current) => ({ ...current, status: 'error', error: errorMessage(error, 'Workspaces could not be loaded.') }))
    }
  }, [boardKey])

  useEffect(() => {
    loadWorkspaces()
    const timer = window.setInterval(() => loadWorkspaces(true), 20_000)
    return () => window.clearInterval(timer)
  }, [loadWorkspaces])

  const selected = workspaces.data.find((workspace) => String(workspace.id) === selectedId) ?? null
  const boardSnapshot = selected ? snaps.find((snapshot) => snapshot.board.id === selected.board_id) : undefined
  const card = selected?.card_id === null || selected?.card_id === undefined
    ? undefined : boardSnapshot?.cards.find((candidate) => candidate.id === selected.card_id)
  const owner = card?.owner ? boardSnapshot?.agents.find((agent) => agent.name === card.owner && agent.status !== 'gone') ?? null : null

  const refreshProcesses = useCallback(async (quiet = true) => {
    if (!selected) return
    const workspaceId = String(selected.id)
    if (!quiet) setProcesses((current) => ({ ...current, status: 'loading', error: null }))
    try {
      const data = await osApi.listProcesses(workspaceId)
      if (selectedIdRef.current !== workspaceId) return
      setProcesses({ status: 'ready', data, error: null })
    } catch (error) {
      if (selectedIdRef.current !== workspaceId) return
      setProcesses((current) => ({ ...current, status: 'error', error: errorMessage(error, 'Processes could not be loaded.') }))
    }
  }, [selected?.id])

  useEffect(() => {
    if (!selected) {
      resourceWorkspaceRef.current = null
      loadGenerationRef.current++
      setProcesses({ status: 'ready', data: [], error: null })
      setEvents({ status: 'ready', data: [], error: null })
      setEvidence({ status: 'ready', data: null, error: null })
      setContext({ status: 'ready', data: [], error: null })
      setPolicies({ status: 'ready', data: [], error: null })
      setContract({ status: 'ready', data: null, error: null })
      setConflicts({ status: 'ready', data: [], error: null })
      return
    }
    const workspaceId = String(selected.id)
    const generation = ++loadGenerationRef.current
    const switched = resourceWorkspaceRef.current !== workspaceId
    resourceWorkspaceRef.current = workspaceId
    let alive = true
    if (switched) {
      setActiveProcessId(null)
      setProcesses({ status: 'loading', data: [], error: null })
      setEvents({ status: 'loading', data: [], error: null })
      setContext({ status: 'loading', data: [], error: null })
      setPolicies({ status: 'loading', data: [], error: null })
      setConflicts({ status: 'loading', data: [], error: null })
    }
    if (selected.card_id !== null && switched) {
      setContract({ status: 'loading', data: null, error: null })
      setEvidence({ status: 'loading', data: null, error: null })
    }
    else {
      if (selected.card_id === null) {
        setContract({ status: 'ready', data: null, error: null })
        setEvidence({ status: 'ready', data: null, error: null })
      }
    }

    const settle = <T,>(promise: Promise<T>, setter: React.Dispatch<React.SetStateAction<Resource<T>>>, label: string) => {
      const current = () => alive && loadGenerationRef.current === generation && selectedIdRef.current === workspaceId
      promise.then((data) => { if (current()) setter({ status: 'ready', data, error: null }) })
        .catch((error) => { if (current()) setter((value) => ({ ...value, status: 'error', error: errorMessage(error, `${label} could not be loaded.`) })) })
    }
    settle(osApi.listProcesses(selected.id), setProcesses, 'Processes')
    settle(osApi.listEvents(selected.board_id), setEvents, 'Events')
    settle(osApi.getContext(selected.id), setContext, 'Context')
    settle(osApi.listPolicies(selected.board_id), setPolicies, 'Policies')
    settle(osApi.listConflicts(selected.board_id), setConflicts, 'Conflicts')
    if (selected.card_id !== null) {
      settle<TaskContract | null>(osApi.getContract(selected.card_id), setContract, 'Task contract')
      settle<EvidenceBundle | null>(osApi.getEvidence(selected.card_id), setEvidence, 'Evidence')
    }
    return () => { alive = false }
  }, [selected?.id, selected?.board_id, selected?.card_id, reloadTick])

  useEffect(() => {
    if (!selected) return
    const timer = window.setInterval(() => setReloadTick((tick) => tick + 1), 8_000)
    return () => window.clearInterval(timer)
  }, [selected?.id])

  useEffect(() => {
    let alive = true
    setDrivers((current) => ({ ...current, status: 'loading', error: null }))
    osApi.listDrivers().then((data) => { if (alive) setDrivers({ status: 'ready', data, error: null }) })
      .catch((error) => { if (alive) setDrivers({ status: 'error', data: [], error: errorMessage(error, 'Drivers unavailable.') }) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!selected) return
    const timer = window.setInterval(() => refreshProcesses(true), 3_500)
    return () => window.clearInterval(timer)
  }, [selected?.id, refreshProcesses])

  const scopedProcessData = useMemo(() => processes.data.filter((process) =>
    String(process.workspace_id) === String(selected?.id ?? '')), [processes.data, selected?.id])
  const scopedProcesses = useMemo<Resource<WorkspaceProcess[]>>(() => ({ ...processes, data: scopedProcessData }),
    [processes.status, processes.error, scopedProcessData])

  useEffect(() => {
    if (processes.status !== 'ready') return
    setActiveProcessId((current) => {
      if (current && scopedProcessData.some((process) => String(process.id) === current)) return current
      const running = scopedProcessData.find((process) => ['running', 'starting', 'stopping'].includes(process.status))
      return running ? String(running.id) : scopedProcessData[0] ? String(scopedProcessData[0].id) : null
    })
  }, [processes.status, scopedProcessData])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]')
      if ((event.metaKey || event.ctrlKey) && event.key === '`') {
        event.preventDefault()
        setCenterPane('terminal'); setMobilePane('terminal')
        window.requestAnimationFrame(() => terminalRef.current?.focus())
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCenterPane('terminal'); setMobilePane('terminal')
        window.requestAnimationFrame(() => commandRef.current?.focus())
        return
      }
      if (typing || !(event.metaKey || event.ctrlKey)) return
      const index = Number(event.key) - 1
      if (index >= 0 && panes[index]) {
        event.preventDefault()
        const pane = panes[index].id
        setMobilePane(pane)
        if (pane === 'terminal' || pane === 'agent') setCenterPane(pane)
        else setSidePane(pane)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const activeProcess = scopedProcessData.find((process) => String(process.id) === activeProcessId) ?? null
  const workspaceConflicts = conflicts.data.filter((conflict) =>
    String(conflict.workspace_id ?? '') === String(selected?.id ?? '') || String(conflict.other_workspace_id ?? '') === String(selected?.id ?? '') ||
    conflict.workspace_ids?.some((id) => String(id) === String(selected?.id ?? '')))
  const availableDrivers = drivers.data.filter((driver) => driver.available !== false)

  const attachProcess = (process: WorkspaceProcess) => {
    if (!selected || String(process.workspace_id) !== String(selected.id)) return
    setActiveProcessId(String(process.id))
    setCenterPane('terminal'); setMobilePane('terminal')
    window.requestAnimationFrame(() => terminalRef.current?.focus())
  }

  const signalProcess = async (process: WorkspaceProcess, signal: string) => {
    try {
      await osApi.signalProcess(process.id, signal)
      setHeaderError(null)
      window.setTimeout(() => refreshProcesses(true), 250)
    } catch (error) { setHeaderError(errorMessage(error, `Could not send ${signal}.`)) }
  }

  const restartProcess = async (process: WorkspaceProcess) => {
    if (!selected || String(process.workspace_id) !== String(selected.id)) return
    try {
      const created = await osApi.restartProcess(process.id)
      await refreshProcesses(true)
      attachProcess(created)
      setHeaderError(null)
    } catch (error) { setHeaderError(errorMessage(error, 'The restart recipe could not run.')) }
  }

  const toggleContextPin = async (item: ContextItem) => {
    if (!selected) return
    const before = context
    const updated = context.data.map((candidate) => String(candidate.id) === String(item.id)
      ? { ...candidate, pinned: !Boolean(candidate.pinned) } : candidate)
    setContext({ status: 'ready', data: updated, error: null })
    try {
      const data = await osApi.updateContext(selected.id, { items: updated })
      setContext({ status: 'ready', data, error: null })
    } catch (error) {
      setContext({ ...before, status: 'error', error: errorMessage(error, 'Context could not be updated.') })
    }
  }

  const copyPath = async () => {
    if (!selected) return
    const path = selected.worktree_path ?? selected.root_path
    try {
      const command = activeProcess ? `orchestra process attach ${JSON.stringify(String(activeProcess.id))}` : `cd ${JSON.stringify(path)}`
      await navigator.clipboard.writeText(command)
      setCopied(true); setHeaderError(null)
      window.setTimeout(() => setCopied(false), 1_800)
    } catch (error) { setHeaderError(errorMessage(error, 'The workspace path could not be copied.')) }
  }

  const archive = async () => {
    if (!selected || !window.confirm(`Archive ${selected.name}? Dirty files and artifacts will be preserved.`)) return
    try {
      await osApi.archiveWorkspace(selected.id)
      localStorage.removeItem('orchestra-os-workspace')
      selectedIdRef.current = null
      setSelectedId(null)
      await loadWorkspaces()
      onChange()
    } catch (error) { setHeaderError(errorMessage(error, 'The workspace could not be archived.')) }
  }

  const openCreate = (task: Card | null = null) => { setCreateCard(task); setCreateOpen(true) }
  const closeCreate = useCallback(() => { setCreateOpen(false); setCreateCard(null) }, [])
  const currentBoard = selected?.board_id ?? snaps[0]?.board.id

  const renderPane = (pane: PaneId) => {
    if (!selected) return null
    if (pane === 'terminal') return (
      <TerminalPane workspace={selected} processes={scopedProcesses} activeProcess={activeProcess}
        terminalRef={terminalRef} commandRef={commandRef} onAttach={attachProcess}
        onProcessesChanged={refreshProcesses} onError={setHeaderError}
        onSignal={signalProcess} onRestart={restartProcess} />
    )
    if (pane === 'agent') return (
      <ConversationPane events={events} workspace={selected} snapshot={boardSnapshot} agent={owner}
        onOpenAgent={setLiveAgent} />
    )
    if (pane === 'changes') return <ChangesPane evidence={evidence} />
    if (pane === 'evidence') return <EvidencePane evidence={evidence} contract={contract} card={card} />
    if (pane === 'processes') return (
      <ProcessesPane processes={scopedProcesses} activeId={activeProcessId} onAttach={attachProcess}
        onSignal={signalProcess} onRestart={restartProcess} />
    )
    if (pane === 'context') return <ContextPane context={context} onTogglePin={toggleContextPin} />
    return <PolicyPane policies={policies} contract={contract} />
  }

  return (
    <div className="os-cockpit">
      <WorkspaceRail snaps={snaps} workspaces={workspaces} selectedId={selectedId}
        onSelect={selectWorkspace} onCreate={openCreate} />

      <main className="os-workspace-stage">
        {workspaces.status === 'loading' && workspaces.data.length === 0 && <WorkspaceStageSkeleton />}
        {workspaces.status === 'error' && workspaces.data.length === 0 && (
          <div className="os-stage-message">
            <span className="os-empty-icon"><OsIcon name="attention" size={22} /></span>
            <h2>Workspace runtime unavailable</h2>
            <p>{workspaces.error}</p>
            <button className="os-primary-button" onClick={() => loadWorkspaces()}>Retry connection</button>
          </div>
        )}
        {workspaces.status === 'ready' && !selected && (
          <div className="os-stage-message">
            <span className="os-empty-icon"><OsIcon name="workspace" size={22} /></span>
            <p className="os-eyebrow">Workspace Runtime</p>
            <h2>Give the task somewhere durable to run</h2>
            <p>A workspace binds its checkout, task, processes, agent session, context, evidence, and policy into one recoverable unit.</p>
            <button className="os-primary-button" onClick={() => openCreate()}><OsIcon name="plus" /> Create workspace</button>
            <small>Every workspace remains attachable from a normal terminal.</small>
          </div>
        )}

        {selected && (
          <>
            <header className="os-workspace-head">
              <div className="os-workspace-title">
                <div className="os-workspace-kicker">
                  <span className={`os-status-pill ${selected.status}`}>{selected.status}</span>
                  <span>{selected.kind}</span>
                  {card && <span>Task {card.id}</span>}
                  {owner && <ProviderBadge provider={owner.provider} compact />}
                </div>
                <h2>{selected.name}</h2>
                <div className="os-workspace-paths">
                  {selected.branch && <span><OsIcon name="branch" size={13} /> <code>{selected.branch}</code></span>}
                  <span title={selected.worktree_path ?? selected.root_path}><OsIcon name="folder" size={13} /> <code>{selected.worktree_path ?? selected.root_path}</code></span>
                </div>
              </div>
              <div className="os-workspace-head-actions">
                <div className="os-driver-strip" title="Available provider drivers">
                  {drivers.status === 'loading' ? <span>Loading drivers</span>
                    : availableDrivers.length > 0 ? availableDrivers.map((driver) => <span key={driver.id}>{driver.name ?? driver.id}</span>)
                      : <span>Driver status unavailable</span>}
                </div>
                <button className="os-secondary-button" onClick={copyPath}><OsIcon name="command" /> {copied ? 'Copied' : 'Terminal attach'}</button>
                <button className="os-icon-button" onClick={() => setReloadTick((tick) => tick + 1)} aria-label="Refresh workspace data" title="Refresh workspace data"><OsIcon name="refresh" /></button>
                <button className="os-text-button os-archive-button" onClick={archive}><OsIcon name="archive" /> Archive</button>
              </div>
              {workspaceConflicts.length > 0 && (
                <div className="os-conflict-banner"><OsIcon name="attention" /><b>{workspaceConflicts.length} scope conflict{workspaceConflicts.length === 1 ? '' : 's'}</b><span>Review overlapping paths before merging.</span></div>
              )}
              {headerError && <div className="os-inline-error os-head-error" role="alert">{headerError}<button onClick={() => setHeaderError(null)} aria-label="Dismiss error"><OsIcon name="close" size={13} /></button></div>}
            </header>

            {mobile ? (
              <div className="os-mobile-workspace">
                <nav className="os-mobile-tabs" aria-label="Workspace panes">
                  {panes.map((pane, index) => (
                    <button key={pane.id} className={mobilePane === pane.id ? 'active' : ''} onClick={() => setMobilePane(pane.id)}
                      aria-current={mobilePane === pane.id ? 'page' : undefined} title={`Command/Control + ${index + 1}`}>
                      <OsIcon name={pane.icon} /><span>{pane.label}</span>
                    </button>
                  ))}
                </nav>
                <div className="os-mobile-pane">{renderPane(mobilePane)}</div>
              </div>
            ) : (
              <div className="os-desktop-workspace">
                <section className="os-primary-column">
                  <nav className="os-pane-tabs" aria-label="Primary workspace panes">
                    <button className={centerPane === 'terminal' ? 'active' : ''} onClick={() => setCenterPane('terminal')}><OsIcon name="terminal" /> Terminal <kbd>⌘`</kbd></button>
                    <button className={centerPane === 'agent' ? 'active' : ''} onClick={() => setCenterPane('agent')}><OsIcon name="message" /> Agent</button>
                  </nav>
                  <div className="os-primary-pane">{renderPane(centerPane)}</div>
                </section>
                <aside className="os-inspector-column">
                  <nav className="os-pane-tabs inspector" aria-label="Workspace inspector panes">
                    {detailPanes.map((pane, index) => (
                      <button key={pane.id} className={sidePane === pane.id ? 'active' : ''}
                        onClick={() => setSidePane(pane.id as typeof sidePane)} title={`Command/Control + ${index + 3}`}>
                        <OsIcon name={pane.icon} /><span>{pane.label}</span>
                      </button>
                    ))}
                  </nav>
                  <div className="os-inspector-pane">{renderPane(sidePane)}</div>
                </aside>
              </div>
            )}
          </>
        )}
      </main>

      {createOpen && currentBoard && (
        <CreateWorkspaceDialog snaps={snaps} initialBoardId={currentBoard} initialCard={createCard}
          onClose={closeCreate} onCreated={async (workspace) => {
            setCreateOpen(false); setCreateCard(null)
            await loadWorkspaces()
            selectWorkspace(workspace)
            onChange()
          }} />
      )}

      {liveAgent && boardSnapshot && (
        <AgentTerminal agent={liveAgent} boardId={boardSnapshot.board.id} threads={boardSnapshot.threads}
          cards={boardSnapshot.cards} onClose={() => setLiveAgent(null)} onChange={() => { onChange(); setReloadTick((tick) => tick + 1) }} />
      )}
    </div>
  )
}

function TerminalPane({ workspace, processes, activeProcess, terminalRef, commandRef, onAttach,
  onProcessesChanged, onError, onSignal, onRestart }: {
  workspace: Workspace
  processes: Resource<WorkspaceProcess[]>
  activeProcess: WorkspaceProcess | null
  terminalRef: React.RefObject<ProcessTerminalHandle>
  commandRef: React.RefObject<HTMLInputElement>
  onAttach: (process: WorkspaceProcess) => void
  onProcessesChanged: () => void
  onError: (message: string | null) => void
  onSignal: (process: WorkspaceProcess, signal: string) => Promise<void>
  onRestart: (process: WorkspaceProcess) => Promise<void>
}) {
  const [command, setCommand] = useState('')
  const [starting, setStarting] = useState(false)

  const run = async (event: React.FormEvent) => {
    event.preventDefault()
    const value = command.trim()
    if (!value) return
    setStarting(true)
    try {
      const created = await osApi.createProcess(workspace.id, {
        name: value.split(/\s+/)[0] || 'shell', command: value,
        cwd: workspace.worktree_path ?? workspace.root_path,
        cols: 100, rows: 30, restartable: true,
      })
      setCommand('')
      await onProcessesChanged()
      onAttach(created)
      onError(null)
      window.requestAnimationFrame(() => terminalRef.current?.focus())
    } catch (error) { onError(errorMessage(error, 'The command could not start.')) }
    finally { setStarting(false) }
  }

  return (
    <section className="os-terminal-pane">
      <header className="os-process-toolbar">
        <div className="os-process-tabs" role="tablist" aria-label="Workspace processes">
          {processes.status === 'loading' && processes.data.length === 0 && <span className="os-toolbar-muted">Loading processes</span>}
          {processes.data.map((process) => (
            <button role="tab" aria-selected={activeProcess?.id === process.id} key={String(process.id)}
              className={activeProcess?.id === process.id ? 'active' : ''} onClick={() => onAttach(process)}>
              <span className={`os-process-dot ${process.status}`} />
              {process.name}
            </button>
          ))}
        </div>
        {activeProcess && (
          <div className="os-process-actions">
            <span className="os-process-facts">PID {activeProcess.pid ?? '—'} · exit {activeProcess.exit_code ?? '—'}</span>
            {['running', 'starting', 'stopping'].includes(activeProcess.status) ? (
              <><button onClick={() => onSignal(activeProcess, 'SIGINT')}>Interrupt</button><button onClick={() => onSignal(activeProcess, 'SIGTERM')}>Stop</button></>
            ) : activeProcess.restartable ? <button onClick={() => onRestart(activeProcess)}>Restart</button> : null}
          </div>
        )}
      </header>
      {processes.status === 'error' && <div className="os-inline-error" role="alert">{processes.error}</div>}
      <ProcessTerminal ref={terminalRef} process={activeProcess} onProcessChanged={onProcessesChanged} />
      <form className="os-command-bar" onSubmit={run}>
        <label htmlFor="os-run-command">Run in a new PTY</label>
        <div>
          <span aria-hidden="true">$</span>
          <input ref={commandRef} id="os-run-command" value={command} onChange={(event) => setCommand(event.target.value)}
            placeholder="npm run dev" autoComplete="off" spellCheck={false} />
          <kbd>⌘K</kbd>
          <button type="submit" disabled={!command.trim() || starting}><OsIcon name="send" /> {starting ? 'Starting' : 'Run'}</button>
        </div>
        <small>Direct PTY · raw input/output · no agent mediation</small>
      </form>
    </section>
  )
}

function WorkspaceRail({ snaps, workspaces, selectedId, onSelect, onCreate }: {
  snaps: Snapshot[]
  workspaces: Resource<Workspace[]>
  selectedId: string | null
  onSelect: (workspace: Workspace) => void
  onCreate: (card?: Card | null) => void
}) {
  const [filter, setFilter] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)
  const openInfo = useCallback(() => setInfoOpen(true), [])
  const closeInfo = useCallback(() => setInfoOpen(false), [])
  const query = filter.trim().toLowerCase()
  const visible = workspaces.data.filter((workspace) => {
    const card = snaps.find((snapshot) => snapshot.board.id === workspace.board_id)?.cards.find((item) => item.id === workspace.card_id)
    return !query || `${workspace.name} ${workspace.branch ?? ''} ${card?.title ?? ''}`.toLowerCase().includes(query)
  })
  const linkedCards = new Set(workspaces.data.map((workspace) => workspace.card_id).filter((id): id is number => id !== null))
  const unassigned = snaps.flatMap((snapshot) => snapshot.cards.map((card) => ({ card, board: snapshot.board })))
    .filter(({ card }) => !linkedCards.has(card.id) && !['done'].includes(card.column))
    .filter(({ card, board }) => !query || `${card.title} ${board.name}`.toLowerCase().includes(query))
    .slice(0, 12)

  return (
    <>
      <aside className="os-workspace-rail">
      <header>
        <div><p className="os-eyebrow">Runtime</p><h2>Workspaces</h2></div>
        <div className="os-rail-actions">
          <button type="button" className="os-icon-button os-info-button" onClick={openInfo}
            aria-label="Learn how workspaces work" title="How workspaces work" aria-haspopup="dialog"
            aria-expanded={infoOpen} aria-controls="workspace-info-dialog"><span aria-hidden="true">i</span></button>
          <button type="button" className="os-icon-button" onClick={() => onCreate()} aria-label="Create workspace" title="Create workspace"><OsIcon name="plus" /></button>
        </div>
      </header>
      <label className="os-rail-search">
        <OsIcon name="search" size={14} />
        <span className="sr-only">Filter workspaces and tasks</span>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter runtime" />
      </label>
      <div className="os-rail-scroll">
        <section className="os-rail-section">
          <div className="os-rail-label"><span>Attached</span><code>{visible.length}</code></div>
          {workspaces.status === 'loading' && workspaces.data.length === 0 && <RailSkeleton />}
          {workspaces.status === 'error' && <div className="os-rail-error">{workspaces.error}</div>}
          {workspaces.status === 'ready' && visible.length === 0 && <p className="os-rail-empty">No workspaces match this view.</p>}
          <div className="os-workspace-list">
            {visible.map((workspace) => {
              const snapshot = snaps.find((item) => item.board.id === workspace.board_id)
              const task = snapshot?.cards.find((card) => card.id === workspace.card_id)
              return (
                <button key={String(workspace.id)} className={String(workspace.id) === selectedId ? 'active' : ''}
                  onClick={() => onSelect(workspace)} aria-current={String(workspace.id) === selectedId ? 'page' : undefined}>
                  <span className={`os-rail-status ${workspace.status}`} />
                  <div><strong>{workspace.name}</strong><span>{task?.title ?? snapshot?.board.name ?? `Project ${workspace.board_id}`}</span></div>
                  <small>{workspace.branch ?? workspace.kind}</small>
                </button>
              )
            })}
          </div>
        </section>

        {unassigned.length > 0 && (
          <section className="os-rail-section os-task-rail">
            <div className="os-rail-label"><span>Tasks without runtime</span><code>{unassigned.length}</code></div>
            {unassigned.map(({ card, board }) => (
              <button key={`${board.id}-${card.id}`} onClick={() => onCreate(card)}>
                <span>Task {card.id}</span><strong>{card.title}</strong><small>{board.name}</small>
                <OsIcon name="plus" size={13} />
              </button>
            ))}
          </section>
        )}
      </div>
      <footer>
        <span><kbd>⌘1–7</kbd> panes</span><span><kbd>⌘`</kbd> terminal</span>
      </footer>
      </aside>
      {infoOpen && <WorkspaceInfoDialog onClose={closeInfo} />}
    </>
  )
}

function CreateWorkspaceDialog({ snaps, initialBoardId, initialCard, onClose, onCreated }: {
  snaps: Snapshot[]
  initialBoardId: number
  initialCard: Card | null
  onClose: () => void
  onCreated: (workspace: Workspace) => void
}) {
  const taskBoardId = initialCard
    ? snaps.find((item) => item.cards.some((card) => card.id === initialCard.id))?.board.id
    : undefined
  const [boardId, setBoardId] = useState(taskBoardId ?? initialBoardId)
  const [cardId, setCardId] = useState<number | ''>(initialCard?.id ?? '')
  const [name, setName] = useState(initialCard ? `${initialCard.title} workspace` : '')
  const [kind, setKind] = useState<'worktree' | 'shared'>('worktree')
  const [baseRef, setBaseRef] = useState('HEAD')
  const [rootPath, setRootPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)
  const snapshot = snaps.find((item) => item.board.id === boardId) ?? snaps[0]
  useModalFocusTrap(true, dialogRef, onClose, firstRef)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      const workspace = await osApi.createWorkspace(boardId, {
        name: name.trim(), kind, card_id: cardId === '' ? null : cardId,
        base_ref: baseRef.trim() || 'HEAD', root_path: rootPath.trim() || undefined,
      })
      onCreated(workspace)
    } catch (createError) { setError(errorMessage(createError, 'The workspace could not be created.')) }
    finally { setCreating(false) }
  }

  return (
    <div className="os-modal-layer">
      <button className="os-modal-scrim" onClick={onClose} aria-label="Close create workspace dialog" />
      <form ref={dialogRef} className="os-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title" onSubmit={submit} tabIndex={-1}>
        <header><div><p className="os-eyebrow">Runtime allocation</p><h2 id="create-workspace-title">Create workspace</h2></div>
          <button type="button" className="os-icon-button" onClick={onClose} aria-label="Close"><OsIcon name="close" /></button></header>
        <p className="os-dialog-intro">Bind a task to an isolated checkout and durable process namespace. You can still attach from any local terminal.</p>
        <div className="os-dialog-grid">
          <label className="os-field"><span>Name</span><input ref={firstRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="Release hardening" required /></label>
          <label className="os-field"><span>Project</span><select value={boardId} onChange={(event) => { setBoardId(Number(event.target.value)); setCardId('') }}>
            {snaps.map((item) => <option value={item.board.id} key={item.board.id}>{item.board.name}</option>)}</select></label>
          <label className="os-field"><span>Task</span><select value={cardId} onChange={(event) => setCardId(event.target.value ? Number(event.target.value) : '')}>
            <option value="">No task yet</option>{snapshot?.cards.map((card) => <option key={card.id} value={card.id}>{card.id} · {card.title}</option>)}</select></label>
          <label className="os-field"><span>Isolation</span><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="worktree">New worktree</option><option value="shared">Shared checkout</option></select></label>
          <label className="os-field"><span>Base ref</span><input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD" /></label>
          <label className="os-field"><span>Repository root <i>optional</i></span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="Use project root" /></label>
        </div>
        {error && <div className="os-inline-error" role="alert">{error}</div>}
        <footer><button type="button" className="os-secondary-button" onClick={onClose}>Cancel</button>
          <button className="os-primary-button" disabled={!name.trim() || creating}><OsIcon name="workspace" /> {creating ? 'Creating' : 'Create workspace'}</button></footer>
      </form>
    </div>
  )
}

function RailSkeleton() {
  return <div className="os-rail-skeleton" aria-label="Loading workspaces">{[0, 1, 2].map((item) => <div key={item}><i /><span /></div>)}</div>
}

function WorkspaceStageSkeleton() {
  return <div className="os-stage-skeleton"><header><i /><b /><span /></header><div><PaneSkeleton /><PaneSkeleton /></div></div>
}

function WorkspaceInfoDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useModalFocusTrap(true, dialogRef, onClose, closeRef)

  return (
    <div className="os-modal-layer">
      <button className="os-modal-scrim" onClick={onClose} aria-label="Close workspace guide" />
      <section ref={dialogRef} id="workspace-info-dialog" className="os-info-dialog" role="dialog" aria-modal="true"
        aria-labelledby="workspace-info-title" aria-describedby="workspace-info-intro" tabIndex={-1}>
        <header>
          <div><p className="os-eyebrow">Workspace guide</p><h2 id="workspace-info-title">A durable place for one stream of work</h2></div>
          <button ref={closeRef} type="button" className="os-icon-button" onClick={onClose} aria-label="Close workspace guide"><OsIcon name="close" /></button>
        </header>
        <p className="os-dialog-intro" id="workspace-info-intro">
          A workspace connects a task to its checkout, terminal processes, agent session, context, safeguards, and proof of work so you can leave and return without losing the thread.
        </p>

        <ol className="os-info-flow" aria-label="Workspace lifecycle">
          <li><span>01</span><div><strong>Create</strong><p>Choose an isolated worktree or an intentional shared checkout.</p></div></li>
          <li><span>02</span><div><strong>Run</strong><p>Start a raw terminal process, a model-backed job, or attach an agent.</p></div></li>
          <li><span>03</span><div><strong>Inspect</strong><p>Follow output, changes, context, policy decisions, and evidence.</p></div></li>
          <li><span>04</span><div><strong>Resume</strong><p>Reattach later, restart saved processes, review, then archive safely.</p></div></li>
        </ol>

        <div className="os-info-details">
          <section>
            <h3>What it keeps together</h3>
            <ul>
              <li><strong>Execution root</strong><span>Branch, worktree, environment, and listening ports.</span></li>
              <li><strong>Task runtime</strong><span>Terminal processes, agent conversation, status, and restart recipes.</span></li>
              <li><strong>Review record</strong><span>Exact diffs, test exits, events, checkpoints, and evidence.</span></li>
            </ul>
          </section>
          <section>
            <h3>How it helps</h3>
            <ul>
              <li><strong>Prevents overlap</strong><span>Worktree isolation lets parallel agents edit without sharing a checkout.</span></li>
              <li><strong>Makes work recoverable</strong><span>The daemon preserves state even when the browser closes.</span></li>
              <li><strong>Keeps review honest</strong><span>You see raw terminal output and recorded evidence, not only an agent summary.</span></li>
            </ul>
          </section>
        </div>

        <aside className="os-info-token-note">
          <span aria-hidden="true">i</span>
          <p><strong>A workspace is not an agent.</strong> Creating or opening one does not call a model. Tokens are used only when a model-backed agent or job runs; ordinary shell processes use no model tokens.</p>
        </aside>

        <footer>
          <p>Use a worktree for parallel work. Use the shared checkout only when sharing it is deliberate.</p>
          <button type="button" className="os-primary-button" onClick={onClose}>Got it</button>
        </footer>
      </section>
    </div>
  )
}
