import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, Snapshot } from './api'
import { osApi, Workspace, WorkspaceGit, WorkspaceProcess } from './osApi'
import { ProcessTerminal, ProcessTerminalHandle } from './ProcessTerminal'
import { OsIcon } from './OsIcon'

// The board's Workspace tab is a terminal and nothing else (#159). Every other
// runtime surface — diffs, evidence, deliveries, policies — stays in the full
// cockpit on the Advanced view (WorkspaceCockpit).
const LIVE = ['running', 'starting', 'stopping']
const isLive = (process: WorkspaceProcess) => LIVE.includes(process.status)

const STORAGE_KEY = 'orchestra-terminal-workspace'
// a daemon older than the delete route answers 404: hide the dead shells anyway and
// stop retrying the sweep for the rest of the session instead of spamming the console
let pruneSupported = true
const prune = async (process: WorkspaceProcess) => {
  if (!pruneSupported) return
  try { await osApi.deleteProcess(process.id) } catch (error) {
    if (error instanceof ApiError && error.status === 404) pruneSupported = false
  }
}
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export function WorkspaceTerminal({ snaps }: { snaps: Snapshot[] }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY))
  const [shells, setShells] = useState<WorkspaceProcess[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)

  const terminalRef = useRef<ProcessTerminalHandle>(null)
  const openingRef = useRef(false)
  const selectedRef = useRef<string | null>(selectedId)
  selectedRef.current = selectedId
  const boardKey = snaps.map((snapshot) => snapshot.board.id).join(',')

  const selected = workspaces.find((workspace) => String(workspace.id) === selectedId) ?? null
  const active = shells.find((shell) => String(shell.id) === activeId) ?? null

  // one terminal workspace per project: reuse the newest active one, and create a
  // plain shared workspace rooted at the project when the board has none
  const loadWorkspaces = useCallback(async () => {
    try {
      const groups = await Promise.all(snaps.map((snapshot) => osApi.listWorkspaces(snapshot.board.id)))
      let list = groups.flat().filter((workspace) => workspace.status !== 'archived')
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      if (list.length === 0 && snaps[0]) {
        const board = snaps[0].board
        const created = await osApi.createWorkspace(board.id, {
          name: board.name, kind: 'shared',
          idempotency_key: `terminal-workspace-${board.id}`,
        })
        list = [created]
      }
      setWorkspaces(list)
      setSelectedId((current) => {
        const wanted = [current, localStorage.getItem(STORAGE_KEY)]
          .find((candidate) => candidate && list.some((workspace) => String(workspace.id) === candidate))
        const next = wanted ?? (list[0] ? String(list[0].id) : null)
        if (next) localStorage.setItem(STORAGE_KEY, next)
        selectedRef.current = next
        return next
      })
      setError(null)
    } catch (loadError) {
      setError(message(loadError, 'The terminal workspace could not be loaded.'))
    } finally { setReady(true) }
  }, [boardKey])

  useEffect(() => { void loadWorkspaces() }, [loadWorkspaces])

  // dead shells used to pile up in the tab strip forever — every exited or lost
  // record is dropped on load, so the strip only ever shows live shells
  const refreshShells = useCallback(async (workspaceId: string) => {
    const list = await osApi.listProcesses(workspaceId)
    const dead = list.filter((process) => !isLive(process))
    if (dead.length) await Promise.all(dead.map(prune))
    const live = list.filter(isLive)
    if (selectedRef.current !== workspaceId) return live
    setShells(live)
    setActiveId((current) => (current && live.some((shell) => String(shell.id) === current)
      ? current
      : live[0] ? String(live[0].id) : null))
    return live
  }, [])

  const openShell = useCallback(async (workspace: Workspace) => {
    if (openingRef.current) return
    openingRef.current = true
    setBusy(true)
    try {
      const created = await osApi.createProcess(workspace.id, {
        name: 'shell', interactive: true,
        cwd: workspace.worktree_path ?? workspace.root_path,
        cols: 100, rows: 30, restartable: true,
      })
      setShells((current) => [...current.filter((shell) => String(shell.id) !== String(created.id)), created])
      setActiveId(String(created.id))
      setError(null)
      window.requestAnimationFrame(() => terminalRef.current?.focus())
    } catch (openError) {
      setError(message(openError, 'The shell could not start.'))
    } finally {
      openingRef.current = false
      setBusy(false)
    }
  }, [])

  // exactly one shell is opened automatically, and only when none is alive
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    void (async () => {
      try {
        const live = await refreshShells(String(selected.id))
        if (cancelled || live.length > 0) return
        await openShell(selected)
      } catch (shellError) {
        if (!cancelled) setError(message(shellError, 'The workspace shells could not be read.'))
      }
    })()
    return () => { cancelled = true }
  }, [selected?.id, openShell, refreshShells])

  const closeShell = async (shell: WorkspaceProcess) => {
    setBusy(true)
    try {
      await osApi.stopProcess(shell.id)
      await prune(shell)
      setShells((current) => current.filter((entry) => String(entry.id) !== String(shell.id)))
      setActiveId((current) => (current === String(shell.id) ? null : current))
    } catch (closeError) { setError(message(closeError, 'The shell could not be closed.')) }
    finally { setBusy(false) }
  }

  // xterm measures itself when the pane is still laid out at its pre-tab size, so the
  // grid keeps the old column count; re-fit once the attached shell is on screen
  useEffect(() => {
    if (!activeId) return
    const fit = () => terminalRef.current?.fit()
    const frame = window.requestAnimationFrame(fit)
    const settle = window.setTimeout(fit, 180)
    window.addEventListener('resize', fit)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settle)
      window.removeEventListener('resize', fit)
    }
  }, [activeId])

  const cwd = useMemo(() => selected?.worktree_path ?? selected?.root_path ?? '', [selected])

  // the git rail beside the terminal (#179): worktrees + branches, polled gently
  const [git, setGit] = useState<WorkspaceGit | null>(null)
  const loadGit = useCallback(async (workspaceId: string) => {
    try {
      const surface = await osApi.readWorkspaceGit(workspaceId)
      if (selectedRef.current === workspaceId) setGit(surface)
    } catch { /* a pre-#179 daemon has no git surface: the rail just stays empty */ }
  }, [])
  useEffect(() => {
    setGit(null)
    if (!selected) return
    const workspaceId = String(selected.id)
    void loadGit(workspaceId)
    const poll = window.setInterval(() => void loadGit(workspaceId), 20_000)
    return () => window.clearInterval(poll)
  }, [selected?.id, loadGit])

  return (
    <div className="ws-terminal">
      <header className="ws-terminal-bar">
        {workspaces.length > 1 ? (
          <select aria-label="Terminal workspace" value={selectedId ?? ''}
            onChange={(event) => {
              setSelectedId(event.target.value)
              localStorage.setItem(STORAGE_KEY, event.target.value)
              setShells([]); setActiveId(null)
            }}>
            {workspaces.map((workspace) => (
              <option key={String(workspace.id)} value={String(workspace.id)}>{workspace.name}</option>
            ))}
          </select>
        ) : <strong>Terminal</strong>}
        <code title={cwd}>{cwd || '—'}</code>
        {shells.length > 1 && (
          <div className="ws-terminal-tabs" role="tablist" aria-label="Open shells">
            {shells.map((shell, index) => (
              <button key={String(shell.id)} role="tab" aria-selected={String(shell.id) === activeId}
                className={String(shell.id) === activeId ? 'active' : ''}
                onClick={() => setActiveId(String(shell.id))}>shell {index + 1}</button>
            ))}
          </div>
        )}
        <div className="ws-terminal-actions">
          <button type="button" disabled={!selected || busy} onClick={() => selected && void openShell(selected)}>
            <OsIcon name="terminal" size={12} /> New shell
          </button>
          {active && (
            <button type="button" disabled={busy} onClick={() => void closeShell(active)}>Close</button>
          )}
        </div>
      </header>
      {error && <div className="os-inline-error" role="alert">{error}</div>}
      {ready && !selected
        ? <p className="ws-terminal-empty">No project is available for a terminal yet.</p>
        : (
          <div className="ws-terminal-body">
            <ProcessTerminal ref={terminalRef} process={active} />
            <GitRail git={git} onRefresh={() => selected && void loadGit(String(selected.id))} />
          </div>
        )}
    </div>
  )
}

const basename = (value: string) => value.split('/').filter(Boolean).pop() ?? value

function GitRail({ git, onRefresh }: { git: WorkspaceGit | null; onRefresh: () => void }) {
  return (
    <aside className="ws-git-rail" aria-label="Worktrees and branches">
      <header className="ws-git-rail-head">
        <strong>Repository</strong>
        <button type="button" onClick={onRefresh} title="Refresh worktrees and branches">
          <OsIcon name="refresh" size={12} />
        </button>
      </header>
      {git === null ? (
        <p className="ws-git-rail-empty">Reading the repository…</p>
      ) : !git.is_repository ? (
        <p className="ws-git-rail-empty">This workspace is not a git repository.</p>
      ) : (
        <>
          <section className="ws-git-section">
            <h4>Worktrees <span>{git.worktrees.length}</span></h4>
            <ul>
              {git.worktrees.map((worktree) => (
                <li key={worktree.path} className={worktree.is_current ? 'current' : ''} title={worktree.path}>
                  <span className="ws-git-name">{basename(worktree.path)}</span>
                  <span className="ws-git-meta">
                    {worktree.branch ?? (worktree.head ? `detached @ ${worktree.head}` : 'detached')}
                    {worktree.locked ? ' · locked' : ''}
                    {worktree.prunable ? ' · prunable' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="ws-git-section">
            <h4>Branches <span>{git.branches.length}</span></h4>
            <ul>
              {git.branches.map((branch) => (
                <li key={branch.name} className={branch.is_current ? 'current' : ''}
                  title={branch.worktree_path ? `checked out at ${branch.worktree_path}` : branch.name}>
                  <span className="ws-git-name">{branch.name}</span>
                  <span className="ws-git-meta">{branch.head}{branch.worktree_path && !branch.is_current ? ' •' : ''}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </aside>
  )
}
