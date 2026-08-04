import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentTerminal } from './AgentTerminal'
import {
  agentHomeApi,
  AgentHomeApiError,
  type AgentConversation,
  type AgentHomeAction,
  type AgentHomeCapabilities,
  type AgentHomeEventKind,
  type AgentHomeSnapshot,
  type AgentProfile,
  type AgentSessionRecord,
  type ConversationEvent,
} from './agentHomeApi'
import {
  agentHomeDeepLink,
  agentHomeSessionPresentation,
  chooseConversation,
  chooseProcess,
  chooseProfile,
  chooseSession,
  parseAgentHomeSelection,
} from './agentHomePresentation'
import {
  AgentConversationPanel,
  AgentHomeHeader,
  AgentHomeInlineState,
  AgentHomePanelSkeleton,
  AgentInspector,
  AgentTerminalPanel,
  type AgentHomeDetailTab,
  type AgentHomeMobilePane,
  type Loadable,
} from './AgentHomePanels'
import type { Agent, Snapshot } from './api'
import { OsIcon } from './OsIcon'
import {
  osApi,
  type AttentionItem,
  type ContextItem,
  type Job,
  type TaskContract,
  type Workspace,
  type WorkspaceProcess,
} from './osApi'
import { ProviderBadge } from './ProviderBadge'
import { useModalFocusTrap } from './useModalFocusTrap'
import { runRuntimeMutation } from './runtimeReadOnly'
import './agentHome.css'

const emptyProfiles = (): Loadable<AgentProfile[]> => ({
  status: 'loading',
  data: [],
  error: null,
})

const emptyHome = (): Loadable<AgentHomeSnapshot | null> => ({
  status: 'idle',
  data: null,
  error: null,
})

const emptyEvents = (): Loadable<ConversationEvent[]> => ({
  status: 'idle',
  data: [],
  error: null,
})

type RuntimeState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  workspace: Workspace | null
  job: Job | null
  contract: TaskContract | null
  processes: WorkspaceProcess[]
  attention: AttentionItem[]
  context: Loadable<ContextItem[]>
  error: string | null
}

const emptyRuntime = (): RuntimeState => ({
  status: 'idle',
  workspace: null,
  job: null,
  contract: null,
  processes: [],
  attention: [],
  context: { status: 'idle', data: [], error: null },
  error: null,
})

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

const messageFor = (error: unknown, fallback: string) => {
  if (error instanceof AgentHomeApiError && error.code === 'not_supported') return error.message
  return error instanceof Error ? error.message : fallback
}

export function AgentHome({ snaps, onChange, readOnly = false }: {
  snaps: Snapshot[]
  onChange: () => void
  readOnly?: boolean
}) {
  const initialSelection = useRef(parseAgentHomeSelection(location.search))
  const mobile = useMedia('(max-width: 820px)')
  const boardKey = snaps.map((snapshot) => snapshot.board.id).join(',')

  const [profiles, setProfiles] = useState<Loadable<AgentProfile[]>>(emptyProfiles)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(initialSelection.current.profileId)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialSelection.current.sessionId)
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(initialSelection.current.conversationId)
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(initialSelection.current.processId)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(initialSelection.current.eventId)
  const focusedEventRef = useRef<string | null>(null)
  const [home, setHome] = useState<Loadable<AgentHomeSnapshot | null>>(emptyHome)
  const [sessionCapabilities, setSessionCapabilities] = useState<AgentHomeCapabilities | null>(null)
  const [runtime, setRuntime] = useState<RuntimeState>(emptyRuntime)
  const [events, setEvents] = useState<Loadable<ConversationEvent[]>>(emptyEvents)
  const [eventCursor, setEventCursor] = useState(0)
  const eventCursorRef = useRef(0)
  const [hasMoreEvents, setHasMoreEvents] = useState(false)

  const [profileFilter, setProfileFilter] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [eventKind, setEventKind] = useState<AgentHomeEventKind | 'all'>('all')
  const [searching, setSearching] = useState(false)
  const [detailTab, setDetailTab] = useState<AgentHomeDetailTab>('work')
  const [mobilePane, setMobilePane] = useState<AgentHomeMobilePane>('conversation')
  const [busyAction, setBusyAction] = useState<AgentHomeAction | null>(null)
  const [headerError, setHeaderError] = useState<string | null>(null)
  const [openingShell, setOpeningShell] = useState(false)
  const [startingCommand, setStartingCommand] = useState(false)
  const [restartingProcessId, setRestartingProcessId] = useState<string | null>(null)
  const [exportBusy, setExportBusy] = useState<'human' | 'json' | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [liveAgent, setLiveAgent] = useState<Agent | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!readOnly) return
    setCreateOpen(false)
    setRenameOpen(false)
    setLiveAgent(null)
  }, [readOnly])

  const selectedProfile = useMemo(() =>
    profiles.data.find((profile) => profile.id === selectedProfileId) ?? null,
  [profiles.data, selectedProfileId])
  const selectedSession = useMemo(() =>
    chooseSession(home.data, selectedSessionId), [home.data, selectedSessionId])
  const selectedConversation = useMemo(() =>
    chooseConversation(home.data, selectedSession, selectedConversationId),
  [home.data, selectedConversationId, selectedSession])
  const selectedProcess = useMemo(() =>
    chooseProcess(runtime.processes, selectedProcessId), [runtime.processes, selectedProcessId])

  const legacyAgent = useMemo(() => {
    if (!selectedProfile?.legacy_agent_id) return null
    return snaps.flatMap((snapshot) => snapshot.agents)
      .find((agent) => agent.id === selectedProfile.legacy_agent_id && agent.status !== 'gone') ?? null
  }, [selectedProfile?.legacy_agent_id, snaps])
  const legacySnapshot = useMemo(() =>
    selectedProfile ? snaps.find((snapshot) => snapshot.board.id === selectedProfile.board_id) : undefined,
  [selectedProfile, snaps])

  const loadProfiles = useCallback(async (quiet = false) => {
    if (!quiet) setProfiles((current) => ({ ...current, status: 'loading', error: null }))
    try {
      const groups = await Promise.all(snaps.map((snapshot) => agentHomeApi.listProfiles(snapshot.board.id)))
      const next = groups.flat().sort((a, b) => a.name.localeCompare(b.name))
      setProfiles({ status: 'ready', data: next, error: null })
      setSelectedProfileId((current) => {
        const selected = chooseProfile(
          next,
          current ?? initialSelection.current.profileId,
          localStorage.getItem('orchestra-agent-home-profile'),
        )
        if (selected) localStorage.setItem('orchestra-agent-home-profile', selected.id)
        return selected?.id ?? null
      })
    } catch (error) {
      setProfiles((current) => ({
        status: 'error',
        data: current.data,
        error: messageFor(error, 'Agent identities could not be loaded.'),
      }))
    }
  }, [boardKey])

  useEffect(() => { void loadProfiles() }, [loadProfiles])

  const refreshHome = useCallback(async (quiet = true) => {
    if (!selectedProfileId) {
      setHome(emptyHome())
      return
    }
    if (!quiet) setHome((current) => ({ ...current, status: 'loading', error: null }))
    try {
      const next = await agentHomeApi.getHome(selectedProfileId)
      setHome({ status: 'ready', data: next, error: null })
      setSelectedSessionId((current) => chooseSession(
        next,
        current ?? initialSelection.current.sessionId,
      )?.id ?? null)
      const nextSession = chooseSession(next, selectedSessionId ?? initialSelection.current.sessionId)
      setSelectedConversationId((current) => chooseConversation(
        next,
        nextSession,
        current ?? initialSelection.current.conversationId,
      )?.id ?? null)
    } catch (error) {
      setHome((current) => ({
        status: 'error',
        data: current.data,
        error: messageFor(error, 'Agent Home could not be loaded.'),
      }))
    }
  }, [selectedProfileId, selectedSessionId])

  useEffect(() => {
    if (!selectedProfileId) return
    void refreshHome(false)
    const timer = window.setInterval(() => void refreshHome(true), 8_000)
    return () => window.clearInterval(timer)
  }, [selectedProfileId, refreshHome])

  useEffect(() => {
    if (!home.data) return
    const session = chooseSession(home.data, selectedSessionId)
    if (session && session.id !== selectedSessionId) setSelectedSessionId(session.id)
    const conversation = chooseConversation(home.data, session, selectedConversationId)
    if (conversation && conversation.id !== selectedConversationId) setSelectedConversationId(conversation.id)
  }, [home.data, selectedConversationId, selectedSessionId])

  useEffect(() => {
    if (!selectedSession) {
      setSessionCapabilities(null)
      return
    }
    setSessionCapabilities(null)
    let alive = true
    agentHomeApi.getSession(selectedSession.id)
      .then((details) => { if (alive) setSessionCapabilities(details.capabilities) })
      .catch(() => { if (alive) setSessionCapabilities(null) })
    return () => { alive = false }
  }, [selectedSession?.id, selectedSession?.updated_at])

  const loadRuntime = useCallback(async (quiet = true) => {
    if (!selectedProfile || !selectedSession) {
      setRuntime(emptyRuntime())
      return
    }
    const homeScopeMatches = String(home.data?.active_scope.workspace?.id ?? '') === selectedSession.workspace_id
    if (!quiet) {
      setRuntime((current) => ({
        status: 'loading',
        workspace: homeScopeMatches ? home.data?.active_scope.workspace ?? null : current.workspace,
        job: homeScopeMatches ? home.data?.active_scope.job ?? null : current.job,
        contract: current.contract,
        processes: homeScopeMatches ? home.data?.active_scope.processes ?? [] : current.processes,
        attention: homeScopeMatches ? home.data?.active_scope.attention ?? [] : current.attention,
        context: { ...current.context, status: 'loading', error: null },
        error: null,
      }))
    }

    const workspacePromise = osApi.getWorkspace(selectedSession.workspace_id)
    const processesPromise = osApi.listProcesses(selectedSession.workspace_id)
    const attentionPromise = osApi.listAttention(selectedProfile.board_id)
    const contextPromise = osApi.getContext(selectedSession.workspace_id)
    const lifecyclePromise = selectedSession.job_id
      ? osApi.getJobLifecycle(selectedSession.job_id)
      : Promise.resolve(null)
    const [workspaceResult, processesResult, attentionResult, contextResult, lifecycleResult] =
      await Promise.allSettled([
        workspacePromise,
        processesPromise,
        attentionPromise,
        contextPromise,
        lifecyclePromise,
      ])
    if (selectedSessionId !== selectedSession.id) return

    const workspace = workspaceResult.status === 'fulfilled'
      ? workspaceResult.value
      : homeScopeMatches ? home.data?.active_scope.workspace ?? null : null
    const processes = processesResult.status === 'fulfilled'
      ? processesResult.value
      : homeScopeMatches ? home.data?.active_scope.processes ?? [] : []
    const attention = (attentionResult.status === 'fulfilled'
      ? attentionResult.value
      : homeScopeMatches ? home.data?.active_scope.attention ?? [] : [])
      .filter((item) => item.workspace_id === null || String(item.workspace_id) === selectedSession.workspace_id)
    const job = lifecycleResult.status === 'fulfilled'
      ? lifecycleResult.value?.job ?? null
      : homeScopeMatches ? home.data?.active_scope.job ?? null : null
    const contract = lifecycleResult.status === 'fulfilled'
      ? lifecycleResult.value?.contract ?? null
      : null
    const failures = [
      workspaceResult.status === 'rejected' ? workspaceResult.reason : null,
      processesResult.status === 'rejected' ? processesResult.reason : null,
    ].filter(Boolean)
    setRuntime({
      status: failures.length ? 'error' : 'ready',
      workspace,
      job,
      contract,
      processes,
      attention,
      context: contextResult.status === 'fulfilled'
        ? { status: 'ready', data: contextResult.value, error: null }
        : {
            status: 'error',
            data: [],
            error: messageFor(contextResult.reason, 'Context could not be loaded.'),
          },
      error: failures.length
        ? messageFor(failures[0], 'Some workspace runtime data could not be loaded.')
        : null,
    })
  }, [
    home.data,
    selectedProfile?.id,
    selectedProfile?.board_id,
    selectedSession?.id,
    selectedSession?.workspace_id,
    selectedSession?.job_id,
    selectedSessionId,
  ])

  useEffect(() => {
    if (!selectedSession) {
      setRuntime(emptyRuntime())
      return
    }
    void loadRuntime(false)
    const timer = window.setInterval(() => void loadRuntime(true), 4_000)
    return () => window.clearInterval(timer)
  }, [selectedSession?.id, loadRuntime])

  useEffect(() => {
    const next = chooseProcess(runtime.processes, selectedProcessId ?? initialSelection.current.processId)
    if (next && String(next.id) !== selectedProcessId) setSelectedProcessId(String(next.id))
    if (!next && selectedProcessId) setSelectedProcessId(null)
  }, [runtime.processes, selectedProcessId])

  const requestEvents = useCallback(async (after: number) => {
    if (!selectedConversation) return { events: [], next_cursor: after, has_more: false }
    return agentHomeApi.searchConversation(selectedConversation.id, {
      query: searchQuery || undefined,
      after,
      limit: 500,
      kinds: eventKind === 'all' ? undefined : [eventKind],
      sessionId: selectedEventId ? undefined : selectedSession?.id,
    })
  }, [eventKind, searchQuery, selectedConversation?.id, selectedEventId, selectedSession?.id])

  useEffect(() => {
    if (!selectedConversation) {
      setEvents({ status: 'ready', data: [], error: null })
      eventCursorRef.current = 0
      setEventCursor(0)
      setHasMoreEvents(false)
      return
    }
    let alive = true
    setEvents({ status: 'loading', data: [], error: null })
    setSearching(true)
    eventCursorRef.current = 0
    const load = async () => {
      try {
        const exact = selectedEventId
          ? await agentHomeApi.getConversationEvent(selectedConversation.id, selectedEventId)
          : null
        const contextCursor = exact ? Math.max(0, exact.event.sequence - 51) : 0
        const page = await requestEvents(contextCursor)
        const byId = new Map(page.events.map((event) => [event.id, event]))
        if (exact) byId.set(exact.event.id, exact.event)
        const loaded = [...byId.values()].sort((a, b) => a.sequence - b.sequence)
        if (!alive) return
        eventCursorRef.current = page.next_cursor
        setEventCursor(page.next_cursor)
        setHasMoreEvents(page.has_more)
        setEvents({ status: 'ready', data: loaded, error: null })
      } catch (error) {
        if (!alive) return
        setEvents({
          status: 'error',
          data: [],
          error: messageFor(error, 'Conversation events could not be loaded.'),
        })
      } finally {
        if (alive) setSearching(false)
      }
    }
    void load()
    return () => { alive = false }
  }, [requestEvents, selectedConversation?.id, selectedEventId])

  useEffect(() => {
    if (!selectedEventId || focusedEventRef.current === selectedEventId || events.status !== 'ready') return
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-agent-event-id]'))
      .find((element) => element.dataset.agentEventId === selectedEventId)
    if (!target) return
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    target.focus({ preventScroll: true })
    focusedEventRef.current = selectedEventId
  }, [events.data, events.status, selectedEventId])

  useEffect(() => {
    if (!selectedConversation) return
    let alive = true
    const poll = async () => {
      try {
        const page = await requestEvents(eventCursorRef.current)
        if (!alive || page.events.length === 0) return
        eventCursorRef.current = page.next_cursor
        setEventCursor(page.next_cursor)
        setHasMoreEvents(page.has_more)
        setEvents((current) => {
          const byId = new Map(current.data.map((event) => [event.id, event]))
          page.events.forEach((event) => byId.set(event.id, event))
          return {
            status: 'ready',
            data: [...byId.values()].sort((a, b) => a.sequence - b.sequence),
            error: null,
          }
        })
      } catch {
        // Preserve the last durable projection during a transient poll failure.
      }
    }
    const timer = window.setInterval(() => void poll(), 2_500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [requestEvents, selectedConversation?.id])

  useEffect(() => {
    if (!selectedProfile) return
    const next = agentHomeDeepLink(location.search, {
      boardId: selectedProfile.board_id,
      profileId: selectedProfile.id,
      conversationId: selectedConversation?.id ?? null,
      sessionId: selectedSession?.id ?? null,
      jobId: selectedSession?.job_id ?? null,
      workspaceId: selectedSession?.workspace_id ?? null,
      processId: selectedProcess ? String(selectedProcess.id) : null,
      eventId: selectedEventId,
    }, { pathname: location.pathname, hash: location.hash })
    if (`${location.pathname}${location.search}${location.hash}` !== next) {
      history.replaceState(null, '', next)
    }
  }, [
    selectedConversation?.id,
    selectedProcess?.id,
    selectedProfile?.board_id,
    selectedProfile?.id,
    selectedEventId,
    selectedSession?.id,
    selectedSession?.job_id,
    selectedSession?.workspace_id,
  ])

  const selectProfile = (profile: AgentProfile) => {
    setSelectedProfileId(profile.id)
    setSelectedSessionId(null)
    setSelectedConversationId(null)
    setSelectedProcessId(null)
    setSelectedEventId(null)
    focusedEventRef.current = null
    setHeaderError(null)
    localStorage.setItem('orchestra-agent-home-profile', profile.id)
  }

  const selectSession = (session: AgentSessionRecord) => {
    setSelectedSessionId(session.id)
    setSelectedConversationId(session.conversation_id)
    setSelectedProcessId(null)
    setSelectedEventId(null)
    focusedEventRef.current = null
  }

  const selectConversation = (conversation: AgentConversation) => {
    setSelectedConversationId(conversation.id)
    setSelectedEventId(null)
    focusedEventRef.current = null
    const matchingSession = home.data?.sessions.find((session) => session.conversation_id === conversation.id)
    if (matchingSession) setSelectedSessionId(matchingSession.id)
  }

  const loadMoreEvents = async () => {
    setSearching(true)
    try {
      const page = await requestEvents(eventCursor)
      const byId = new Map(events.data.map((event) => [event.id, event]))
      page.events.forEach((event) => byId.set(event.id, event))
      eventCursorRef.current = page.next_cursor
      setEventCursor(page.next_cursor)
      setHasMoreEvents(page.has_more)
      setEvents({
        status: 'ready',
        data: [...byId.values()].sort((a, b) => a.sequence - b.sequence),
        error: null,
      })
    } catch (error) {
      setHeaderError(messageFor(error, 'More events could not be loaded.'))
    } finally { setSearching(false) }
  }

  const performAction = async (action: AgentHomeAction, body: Record<string, unknown> = {}) => {
    if (readOnly || !selectedSession) return
    if ((action === 'stop' || action === 'archive')
      && !window.confirm(`${action === 'stop' ? 'Stop' : 'Archive'} this provider session?`)) return
    setBusyAction(action)
    setHeaderError(null)
    try {
      const mutation = await runRuntimeMutation(readOnly,
        () => agentHomeApi.sessionAction(selectedSession.id, action, body))
      if (!mutation.performed) return
      const result = mutation.value
      if (result.created_session) {
        setSelectedSessionId(result.created_session.id)
        setSelectedConversationId(result.created_session.conversation_id)
      } else {
        setSelectedSessionId(result.session.id)
      }
      setSessionCapabilities(result.capabilities)
      await refreshHome(true)
      await loadRuntime(true)
      onChange()
    } catch (error) {
      setHeaderError(messageFor(error, `The ${action} action could not be completed.`))
    } finally { setBusyAction(null) }
  }

  const requestAction = (action: AgentHomeAction) => {
    if (readOnly) return
    if (action === 'rename') {
      setRenameOpen(true)
      return
    }
    void performAction(action)
  }

  const openShell = async () => {
    const workspace = runtime.workspace
    if (readOnly || !workspace || openingShell) return
    setOpeningShell(true)
    setHeaderError(null)
    try {
      const mutation = await runRuntimeMutation(readOnly, () => osApi.createProcess(workspace.id, {
        name: 'shell',
        interactive: true,
        cwd: workspace.worktree_path ?? workspace.root_path,
        cols: 100,
        rows: 30,
        restartable: true,
      }))
      if (!mutation.performed) return
      const process = mutation.value
      setSelectedProcessId(String(process.id))
      await loadRuntime(true)
    } catch (error) {
      setHeaderError(messageFor(error, 'The interactive shell could not start.'))
    } finally { setOpeningShell(false) }
  }

  const runCommand = async (command: string) => {
    const workspace = runtime.workspace
    if (readOnly || !workspace) return
    setStartingCommand(true)
    setHeaderError(null)
    try {
      const mutation = await runRuntimeMutation(readOnly, () => osApi.createProcess(workspace.id, {
        name: command.split(/\s+/)[0] || 'command',
        command,
        cwd: workspace.worktree_path ?? workspace.root_path,
        cols: 100,
        rows: 30,
        restartable: true,
      }))
      if (!mutation.performed) return
      const process = mutation.value
      setSelectedProcessId(String(process.id))
      await loadRuntime(true)
    } catch (error) {
      setHeaderError(messageFor(error, 'The command could not start.'))
    } finally { setStartingCommand(false) }
  }

  const signalProcess = async (process: WorkspaceProcess, signal: string) => {
    if (readOnly) return
    try {
      const mutation = await runRuntimeMutation(readOnly, () => signal === 'SIGTERM'
        ? osApi.stopProcess(process.id)
        : osApi.signalProcess(process.id, signal))
      if (!mutation.performed) return
      await loadRuntime(true)
    } catch (error) { setHeaderError(messageFor(error, 'The signal could not be delivered.')) }
  }

  const restartProcess = async (process: WorkspaceProcess) => {
    if (readOnly || restartingProcessId) return
    setRestartingProcessId(String(process.id))
    try {
      const mutation = await runRuntimeMutation(readOnly, () => osApi.restartProcess(process.id))
      if (!mutation.performed) return
      const restarted = mutation.value
      setSelectedProcessId(String(restarted.id))
      await loadRuntime(true)
    } catch (error) { setHeaderError(messageFor(error, 'The process could not be restarted.')) }
    finally { setRestartingProcessId(null) }
  }

  const exportConversation = async (format: 'human' | 'json') => {
    if (!selectedConversation) return
    setExportBusy(format)
    try {
      const result = await agentHomeApi.readExport(selectedConversation.id, format, selectedSession?.id)
      const blob = new Blob([result.content], { type: result.mimeType })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${selectedProfile?.name ?? 'agent'}-${selectedConversation.id.slice(0, 8)}.${format === 'json' ? 'json' : 'txt'}`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setHeaderError(messageFor(error, 'The redacted transcript could not be exported.'))
    } finally { setExportBusy(null) }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch (error) { setHeaderError(messageFor(error, 'The deep link could not be copied.')) }
  }

  const createProfile = async (input: {
    boardId: number
    name: string
    role: string
    provider: string
    model: string
  }) => {
    const mutation = await runRuntimeMutation(readOnly, () => agentHomeApi.createProfile(input.boardId, {
      name: input.name,
      role: input.role || null,
      default_provider: input.provider || null,
      default_model: input.model || null,
      default_access_profile: 'workspace_write',
    }))
    if (!mutation.performed) return
    const created = mutation.value
    await loadProfiles(true)
    selectProfile(created)
    setCreateOpen(false)
  }

  const visibleProfiles = useMemo(() => {
    const query = profileFilter.trim().toLocaleLowerCase()
    return profiles.data.filter((profile) => !query
      || `${profile.name} ${profile.role ?? ''} ${profile.default_provider ?? ''}`
        .toLocaleLowerCase().includes(query))
  }, [profileFilter, profiles.data])

  const showInitialLoading = profiles.status === 'loading' && profiles.data.length === 0
  const showProfileError = profiles.status === 'error' && profiles.data.length === 0

  return (
    <div className="agent-home" aria-readonly={readOnly || undefined}>
      <aside className="ah-rail">
        <header>
          <div><p>Agent OS</p><h2>Agent Home</h2></div>
          <button type="button" onClick={() => setCreateOpen(true)} disabled={readOnly}
            aria-label="Create durable agent" title={readOnly ? 'Reconnect Orchestra to create an agent' : 'Create durable agent'}>
            <OsIcon name="plus" size={15} />
          </button>
        </header>
        <label className="ah-rail-search">
          <OsIcon name="search" size={14} />
          <span className="sr-only">Filter durable agents</span>
          <input value={profileFilter} onChange={(event) => setProfileFilter(event.target.value)}
            placeholder="Find an agent" />
        </label>
        <div className="ah-rail-list">
          {showInitialLoading && <AgentHomePanelSkeleton rows={4} />}
          {showProfileError && <p className="ah-rail-error">{profiles.error}</p>}
          {profiles.status === 'ready' && visibleProfiles.length === 0 && (
            <div className="ah-rail-empty">
              <strong>{profiles.data.length ? 'No agents match' : 'No durable agents yet'}</strong>
              <p>{profiles.data.length ? 'Try another name or provider.' : 'Create an identity that can keep its history across provider sessions.'}</p>
              {!profiles.data.length && <button type="button" disabled={readOnly}
                onClick={() => setCreateOpen(true)}>Create first agent</button>}
            </div>
          )}
          {visibleProfiles.map((profile) => {
            const active = profile.id === selectedProfile?.id
            const profileSession = active ? selectedSession : null
            const profileSessionPresentation = profileSession
              ? agentHomeSessionPresentation(profileSession)
              : null
            return (
              <button className={`ah-profile-card${active ? ' active' : ''}`} type="button"
                onClick={() => selectProfile(profile)} key={profile.id} aria-current={active ? 'page' : undefined}>
                <span className="ah-profile-avatar">
                  {profile.name.split(/[\s-_]+/).map((part) => part[0]?.toUpperCase()).slice(0, 2).join('')}
                  <i className={profileSessionPresentation?.status ?? profile.status} />
                </span>
                <span className="ah-profile-copy">
                  <strong>{profile.name}</strong>
                  <small>{profile.role ?? 'General agent'}</small>
                  <span>{profileSessionPresentation?.status ?? profile.status} · {profileSession?.mode ?? 'identity'}</span>
                </span>
                {profileSession?.provider || profile.default_provider
                  ? <ProviderBadge provider={profileSession?.provider ?? profile.default_provider!} compact />
                  : <code>—</code>}
              </button>
            )
          })}
        </div>
        <footer>
          <span><i className="ready" /> durable identity</span>
          <span><i className="running" /> live provider</span>
          <small>{profiles.data.length} agent{profiles.data.length === 1 ? '' : 's'} across {snaps.length} project{snaps.length === 1 ? '' : 's'}</small>
        </footer>
      </aside>

      <main className="ah-stage">
        {showInitialLoading && <AgentHomeStageSkeleton />}
        {showProfileError && (
          <div className="ah-stage-state">
            <AgentHomeInlineState icon="attention" title="Agent Home unavailable"
              detail={profiles.error ?? 'Durable identities could not be loaded.'} />
            <button type="button" onClick={() => void loadProfiles()}>Retry connection</button>
          </div>
        )}
        {!showInitialLoading && !showProfileError && !selectedProfile && (
          <div className="ah-stage-state">
            <AgentHomeInlineState icon="message" title="Create a durable agent identity"
              detail="One identity can coordinate many independent Claude or Codex sessions while keeping its work, provenance, context, and history together." />
            <button type="button" disabled={readOnly} onClick={() => setCreateOpen(true)}>Create durable agent</button>
          </div>
        )}
        {selectedProfile && (home.status === 'loading' && !home.data ? <AgentHomeStageSkeleton /> : home.data ? (
          <>
            <AgentHomeHeader profile={selectedProfile} session={selectedSession}
              conversation={selectedConversation} workspace={runtime.workspace} job={runtime.job}
              contract={runtime.contract}
              process={selectedProcess} attention={runtime.attention} capabilities={sessionCapabilities}
              busyAction={busyAction} error={headerError ?? home.error ?? runtime.error} copied={copied}
              readOnly={readOnly}
              onAction={requestAction} onRefresh={() => {
                void refreshHome(false); void loadRuntime(false)
              }} onCopyLink={() => void copyLink()} />

            {mobile ? (
              <div className="ah-mobile-layout">
                <nav className="ah-mobile-tabs" role="tablist" aria-label="Agent Home panes">
                  {([
                    ['conversation', 'Conversation', 'message'],
                    ['terminal', 'Terminal', 'terminal'],
                    ['details', 'Details', 'context'],
                  ] as const).map(([id, label, icon]) => (
                    <button type="button" role="tab" aria-selected={mobilePane === id}
                      className={mobilePane === id ? 'active' : ''} onClick={() => setMobilePane(id)} key={id}>
                      <OsIcon name={icon} size={14} />{label}
                    </button>
                  ))}
                </nav>
                <div className="ah-mobile-pane" role="tabpanel">
                  {mobilePane === 'conversation' ? (
                    <AgentConversationPanel conversation={selectedConversation} session={selectedSession}
                      events={events} highlightedEventId={selectedEventId}
                      query={searchDraft} kind={eventKind} liveAgent={legacyAgent}
                      searching={searching} hasMore={hasMoreEvents} exportBusy={exportBusy}
                      readOnly={readOnly}
                      onQueryChange={setSearchDraft} onKindChange={(value) => {
                        setSelectedEventId(null)
                        focusedEventRef.current = null
                        setEventKind(value)
                      }}
                      onSearch={(event) => {
                        event.preventDefault()
                        setSelectedEventId(null)
                        focusedEventRef.current = null
                        setSearchQuery(searchDraft.trim())
                      }}
                      onLoadMore={() => void loadMoreEvents()} onOpenLiveAgent={() => legacyAgent && setLiveAgent(legacyAgent)}
                      onExport={(format) => void exportConversation(format)} />
                  ) : mobilePane === 'terminal' ? (
                    <AgentTerminalPanel workspace={runtime.workspace} processes={runtime.processes}
                      process={selectedProcess} loading={runtime.status === 'loading'} error={runtime.error}
                      openingShell={openingShell} startingCommand={startingCommand}
                      readOnly={readOnly}
                      restartingProcessId={restartingProcessId}
                      onSelectProcess={(process) => setSelectedProcessId(String(process.id))}
                      onOpenShell={() => void openShell()} onRunCommand={runCommand}
                      onSignal={(process, signal) => void signalProcess(process, signal)}
                      onRestart={(process) => void restartProcess(process)}
                      onProcessChanged={() => void loadRuntime(true)} />
                  ) : (
                    <AgentInspector tab={detailTab} profile={selectedProfile} home={home.data}
                      session={selectedSession} conversation={selectedConversation} workspace={runtime.workspace}
                      job={runtime.job} contract={runtime.contract}
                      processes={runtime.processes} attention={runtime.attention}
                      context={runtime.context} events={events.data} onTabChange={setDetailTab}
                      readOnly={readOnly}
                      onSelectSession={selectSession} onSelectConversation={selectConversation} />
                  )}
                </div>
              </div>
            ) : (
              <div className="ah-desktop-layout">
                <div className="ah-primary-pair">
                  <AgentConversationPanel conversation={selectedConversation} session={selectedSession}
                    events={events} highlightedEventId={selectedEventId}
                    query={searchDraft} kind={eventKind} liveAgent={legacyAgent}
                    searching={searching} hasMore={hasMoreEvents} exportBusy={exportBusy}
                    readOnly={readOnly}
                    onQueryChange={setSearchDraft} onKindChange={(value) => {
                      setSelectedEventId(null)
                      focusedEventRef.current = null
                      setEventKind(value)
                    }}
                    onSearch={(event) => {
                      event.preventDefault()
                      setSelectedEventId(null)
                      focusedEventRef.current = null
                      setSearchQuery(searchDraft.trim())
                    }}
                    onLoadMore={() => void loadMoreEvents()} onOpenLiveAgent={() => legacyAgent && setLiveAgent(legacyAgent)}
                    onExport={(format) => void exportConversation(format)} />
                  <AgentTerminalPanel workspace={runtime.workspace} processes={runtime.processes}
                    process={selectedProcess} loading={runtime.status === 'loading'} error={runtime.error}
                    openingShell={openingShell} startingCommand={startingCommand}
                    readOnly={readOnly}
                    restartingProcessId={restartingProcessId}
                    onSelectProcess={(process) => setSelectedProcessId(String(process.id))}
                    onOpenShell={() => void openShell()} onRunCommand={runCommand}
                    onSignal={(process, signal) => void signalProcess(process, signal)}
                    onRestart={(process) => void restartProcess(process)}
                    onProcessChanged={() => void loadRuntime(true)} />
                </div>
                <AgentInspector tab={detailTab} profile={selectedProfile} home={home.data}
                  session={selectedSession} conversation={selectedConversation} workspace={runtime.workspace}
                  job={runtime.job} contract={runtime.contract}
                  processes={runtime.processes} attention={runtime.attention}
                  context={runtime.context} events={events.data} onTabChange={setDetailTab}
                  readOnly={readOnly}
                  onSelectSession={selectSession} onSelectConversation={selectConversation} />
              </div>
            )}
          </>
        ) : (
          <div className="ah-stage-state">
            <AgentHomeInlineState icon="attention" title="Agent identity unavailable"
              detail={home.error ?? 'This durable identity could not be reconstructed.'} />
            <button type="button" onClick={() => void refreshHome(false)}>Retry Agent Home</button>
          </div>
        ))}
      </main>

      {createOpen && !readOnly && (
        <CreateAgentDialog snaps={snaps} onClose={() => setCreateOpen(false)}
          onCreate={createProfile} />
      )}
      {renameOpen && !readOnly && selectedSession && (
        <RenameSessionDialog session={selectedSession} onClose={() => setRenameOpen(false)}
          onRename={async (name) => {
            await performAction('rename', { name })
            setRenameOpen(false)
          }} />
      )}
      {liveAgent && !readOnly && legacySnapshot && (
        <AgentTerminal agent={liveAgent} boardId={legacySnapshot.board.id}
          threads={legacySnapshot.threads} cards={legacySnapshot.cards}
          onClose={() => setLiveAgent(null)} onChange={() => {
            onChange(); void refreshHome(true)
          }} />
      )}
    </div>
  )
}

function AgentHomeStageSkeleton() {
  return (
    <div className="ah-stage-skeleton" aria-label="Loading Agent Home">
      <div className="ah-stage-skeleton-head"><i /><span /><span /></div>
      <div className="ah-stage-skeleton-grid"><AgentHomePanelSkeleton rows={6} /><AgentHomePanelSkeleton rows={6} dark /></div>
    </div>
  )
}

function CreateAgentDialog({ snaps, onClose, onCreate }: {
  snaps: Snapshot[]
  onClose: () => void
  onCreate: (input: { boardId: number; name: string; role: string; provider: string; model: string }) => Promise<void>
}) {
  const dialogRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [boardId, setBoardId] = useState(snaps[0]?.board.id ?? 0)
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [provider, setProvider] = useState('codex')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useModalFocusTrap(true, dialogRef, onClose, nameRef)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!boardId || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onCreate({
        boardId,
        name: name.trim(),
        role: role.trim(),
        provider,
        model: model.trim(),
      })
    } catch (createError) {
      setError(messageFor(createError, 'The durable identity could not be created.'))
    } finally { setBusy(false) }
  }

  return (
    <div className="ah-modal-layer">
      <button type="button" className="ah-modal-scrim" aria-label="Close create agent dialog" onClick={onClose} />
      <form ref={dialogRef} className="ah-dialog" role="dialog" aria-modal="true"
        aria-labelledby="ah-create-title" onSubmit={submit} tabIndex={-1}>
        <header>
          <div><p>Durable identity</p><h2 id="ah-create-title">Create an agent home</h2></div>
          <button type="button" onClick={onClose} aria-label="Close"><OsIcon name="close" /></button>
        </header>
        <p className="ah-dialog-intro">This creates identity and a default conversation. It does not spend tokens until a provider session starts.</p>
        <label><span>Project</span><select value={boardId} onChange={(event) => setBoardId(Number(event.target.value))}>
          {snaps.map((snapshot) => <option value={snapshot.board.id} key={snapshot.board.id}>{snapshot.board.name}</option>)}
        </select></label>
        <label><span>Agent name</span><input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)}
          placeholder="Research lead" autoComplete="off" /></label>
        <label><span>Role</span><input value={role} onChange={(event) => setRole(event.target.value)}
          placeholder="Plans research, delegates evidence, resolves conflicts" /></label>
        <div className="ah-dialog-row">
          <label><span>Default provider</span><select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="codex">Codex</option><option value="claude">Claude</option>
          </select></label>
          <label><span>Default model</span><input value={model} onChange={(event) => setModel(event.target.value)}
            placeholder="Provider default" /></label>
        </div>
        {error && <div className="ah-dialog-error" role="alert">{error}</div>}
        <footer><button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={!name.trim() || !boardId || busy}>
            {busy ? 'Creating…' : 'Create agent'}
          </button></footer>
      </form>
    </div>
  )
}

function RenameSessionDialog({ session, onClose, onRename }: {
  session: AgentSessionRecord
  onClose: () => void
  onRename: (name: string) => Promise<void>
}) {
  const dialogRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const initialName = typeof session.context.name === 'string' ? session.context.name : `${session.provider} session`
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useModalFocusTrap(true, dialogRef, onClose, inputRef)

  return (
    <div className="ah-modal-layer">
      <button type="button" className="ah-modal-scrim" aria-label="Close rename session dialog" onClick={onClose} />
      <form ref={dialogRef} className="ah-dialog compact" role="dialog" aria-modal="true"
        aria-labelledby="ah-rename-title" tabIndex={-1} onSubmit={async (event) => {
          event.preventDefault()
          if (!name.trim()) return
          setBusy(true)
          setError(null)
          try { await onRename(name.trim()) }
          catch (renameError) { setError(messageFor(renameError, 'The session could not be renamed.')) }
          finally { setBusy(false) }
        }}>
        <header>
          <div><p>Provider session</p><h2 id="ah-rename-title">Rename session</h2></div>
          <button type="button" onClick={onClose} aria-label="Close"><OsIcon name="close" /></button>
        </header>
        <label><span>Session name</span><input ref={inputRef} value={name}
          onChange={(event) => setName(event.target.value)} /></label>
        {error && <div className="ah-dialog-error" role="alert">{error}</div>}
        <footer><button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={!name.trim() || busy}>{busy ? 'Saving…' : 'Rename'}</button></footer>
      </form>
    </div>
  )
}
