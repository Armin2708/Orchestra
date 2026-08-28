import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from './api'
import { OrchestraMark } from './BrandMark'
import {
  hasPendingDeviceAuthorityRecovery,
  passwordDeviceLogin,
  recoverPendingDeviceAuthority,
  remoteMutationDigest,
  rotateDeviceAuthority,
} from './deviceAuth'
import { OfflineStateBanner, RemoteAccessProvider, useRemoteAccess } from './RemoteAccess'
import { RemoteAccessCenter } from './RemoteAccessCenter'

export type RemoteBoardSummary = {
  id: number
  name: string
  status: 'active' | 'clear'
  attention_count: number
}

type RemoteAgentSummary = {
  id: number
  name: string
  status: string
  provider: string
  process_id: string | null
}

type RemoteApprovalSummary = {
  id: string
  agent_id: number
  severity: string
  summary: string
  created_at: string
}

type PendingPrivilegedAction = {
  operation: string
  resourceType: 'agent' | 'process' | 'approval'
  resourceId: string
  requestDigest: string
  nonce: string
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

export function normalizeRemoteBoards(value: unknown): RemoteBoardSummary[] {
  const envelope = asObject(value)
  const candidates = Array.isArray(envelope.boards) ? envelope.boards : []
  return candidates.flatMap((candidate) => {
    const board = asObject(candidate)
    const id = Number(board.id)
    if (!Number.isSafeInteger(id) || id <= 0 || typeof board.name !== 'string' || !board.name.trim()) return []
    const count = (input: unknown) => Number.isSafeInteger(Number(input)) && Number(input) >= 0 ? Number(input) : 0
    return [{
      id,
      name: board.name,
      status: board.status === 'active' ? 'active' : 'clear',
      attention_count: count(board.attention_count),
    }]
  })
}

const messageFor = (cause: unknown): string => {
  if (cause instanceof ApiError && cause.status === 401) return 'This device credential is unavailable, expired, or revoked. Pair again from the host.'
  return cause instanceof Error ? cause.message : 'The remote request failed.'
}

export function PairingRequired({ error, onSignedIn }: { error?: string | null; onSignedIn?: () => void }) {
  const [recoverable, setRecoverable] = useState(() => hasPendingDeviceAuthorityRecovery())
  const [recovering, setRecovering] = useState(false)
  const [password, setPassword] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  // reload only when no host wired a transition — it re-fetches the shell through the tunnel
  const signedIn = () => (onSignedIn ? onSignedIn() : location.reload())
  const recover = async () => {
    setRecovering(true)
    try {
      if (await recoverPendingDeviceAuthority()) signedIn()
      else setRecoverable(false)
    } finally { setRecovering(false) }
  }
  const signIn = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password.trim() || signingIn) return
    setSigningIn(true)
    setSignInError(null)
    try {
      await passwordDeviceLogin(password)
      signedIn()
    } catch (cause) {
      setSignInError(cause instanceof Error ? cause.message : 'Sign-in failed.')
    } finally { setSigningIn(false) }
  }
  return (
    <main className="remote-pairing-required" aria-labelledby="pairing-required-title">
      <section className="remote-pairing-card">
        <OrchestraMark className="remote-brand-mark" label="Orchestra" />
        <p className="settings-kicker">Remote device</p>
        <h1 id="pairing-required-title">Sign in</h1>
        <p>{error || 'This browser has no active DeviceSession yet.'}</p>
        <p>Password sign-in is available only through the private Tailscale tunnel.</p>
        <form className="remote-password-form" onSubmit={(event) => void signIn(event)}>
          <input className="login-input" type="password" placeholder="Orchestra password"
            autoFocus autoComplete="current-password" value={password}
            onChange={(event) => setPassword(event.target.value)} />
          <button className="login-btn" type="submit" disabled={!password.trim() || signingIn}>
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {signInError && <p className="remote-pairing-safety" role="alert">{signInError}</p>}
        <p>For public Cloudflare access or narrower board scopes, use a single-use pairing ticket:</p>
        <ol>
          <li>On the machine running Orchestra, create a named single-use pairing ticket.</li>
          <li>Open its HTTPS link on this device before it expires.</li>
          <li>Grant only the boards and scopes this device needs.</li>
        </ol>
        <p className="remote-pairing-safety">Do not paste a master token here. No token field exists on remote origins.</p>
        {recoverable && <button type="button" className="remote-authority-recover" disabled={recovering}
          onClick={() => void recover()}>{recovering ? 'Recovering…' : 'Recover credential storage'}</button>}
      </section>
    </main>
  )
}

export function RemoteDeviceShell() {
  return (
    <RemoteAccessProvider>
      <RemoteDeviceShellContent />
    </RemoteAccessProvider>
  )
}

function RemoteDeviceShellContent() {
  const access = useRemoteAccess()
  const [boards, setBoards] = useState<RemoteBoardSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState<'message' | 'rotate' | 'recover-authority' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [messageKey, setMessageKey] = useState<string | null>(null)
  const [authorityRecovery, setAuthorityRecovery] = useState(false)
  const [agents, setAgents] = useState<RemoteAgentSummary[]>([])
  const [approvals, setApprovals] = useState<RemoteApprovalSummary[]>([])
  const [terminalAgent, setTerminalAgent] = useState<RemoteAgentSummary | null>(null)
  const [terminalOutput, setTerminalOutput] = useState<Array<{ seq: number; stream: string; data: string }>>([])
  const [terminalInput, setTerminalInput] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingPrivilegedAction | null>(null)

  const load = useCallback(async () => {
    if (!navigator.onLine) return
    try {
      const response = await api('GET', '/os/remote/boards')
      const next = normalizeRemoteBoards(response)
      setBoards(next)
      setSelectedId((current) => next.some((board) => board.id === current) ? current : next[0]?.id ?? null)
      setError(null)
    } catch (cause) {
      setBoards([])
      setError(messageFor(cause))
    }
  }, [])

  useEffect(() => {
    if (!access.session || !access.hasScope('observe')) return
    void load()
    const poll = window.setInterval(() => { void load() }, 10_000)
    return () => window.clearInterval(poll)
  }, [access.session, access.hasScope, load])

  const loadControls = useCallback(async () => {
    if (!navigator.onLine || !selectedId || !access.hasScope('observe')) return
    const [agentEnvelope, approvalEnvelope] = await Promise.all([
      api('GET', `/os/remote/agents?board_id=${selectedId}`),
      api('GET', `/os/remote/approvals?board_id=${selectedId}`),
    ])
    const nextAgents = Array.isArray(asObject(agentEnvelope).agents)
      ? (asObject(agentEnvelope).agents as unknown[]).flatMap((candidate) => {
          const value = asObject(candidate)
          const id = Number(value.id)
          if (!Number.isSafeInteger(id) || id <= 0 || typeof value.name !== 'string') return []
          return [{
            id,
            name: value.name,
            status: typeof value.status === 'string' ? value.status : 'unknown',
            provider: typeof value.provider === 'string' ? value.provider : 'unknown',
            process_id: typeof value.process_id === 'string' ? value.process_id : null,
          }]
        }) : []
    const nextApprovals = Array.isArray(asObject(approvalEnvelope).approvals)
      ? (asObject(approvalEnvelope).approvals as unknown[]).flatMap((candidate) => {
          const value = asObject(candidate)
          const agentId = Number(value.agent_id)
          if (typeof value.id !== 'string' || !Number.isSafeInteger(agentId)
            || typeof value.summary !== 'string') return []
          return [{
            id: value.id,
            agent_id: agentId,
            severity: typeof value.severity === 'string' ? value.severity : 'unknown',
            summary: value.summary,
            created_at: typeof value.created_at === 'string' ? value.created_at : '',
          }]
        }) : []
    setAgents(nextAgents)
    setApprovals(nextApprovals)
    setTerminalAgent((current) => current
      ? nextAgents.find((agent) => agent.id === current.id) ?? null
      : null)
  }, [access.hasScope, selectedId])

  useEffect(() => {
    if (!selectedId || !access.session || !access.hasScope('observe')) return
    void loadControls().catch((cause) => setError(messageFor(cause)))
    const poll = window.setInterval(() => {
      if (navigator.onLine) void loadControls().catch(() => undefined)
    }, 10_000)
    return () => window.clearInterval(poll)
  }, [access.hasScope, access.session, loadControls, selectedId])

  const selected = useMemo(() => boards.find((board) => board.id === selectedId) ?? null, [boards, selectedId])
  const canMessage = Boolean(selected && body.trim() && access.canUse('message'))

  const send = async () => {
    if (!canMessage || !selected || busy) return
    setBusy('message')
    setError(null)
    setSent(null)
    try {
      const idempotencyKey = messageKey ?? crypto.randomUUID()
      setMessageKey(idempotencyKey)
      const response = asObject(await api('POST', '/os/remote/messages', {
        board_id: selected.id,
        body: body.trim(),
      }, { 'idempotency-key': idempotencyKey }))
      if (response.target_kind !== 'no-tool') throw new Error('The daemon did not confirm a no-tool message target.')
      setBody('')
      setMessageKey(null)
      setSent('Message accepted as no-tool remote work with device attribution.')
    } catch (cause) { setError(messageFor(cause)) }
    finally { setBusy(null) }
  }

  const rotate = async () => {
    if (!access.online || busy) return
    setBusy('rotate')
    setError(null)
    try {
      await rotateDeviceAuthority()
      setAuthorityRecovery(false)
      await access.refresh()
      setSent('Credential and nonextractable device key rotated.')
    } catch (cause) {
      setAuthorityRecovery(hasPendingDeviceAuthorityRecovery())
      setError(messageFor(cause))
    }
    finally { setBusy(null) }
  }

  const recoverAuthority = async () => {
    if (busy || !authorityRecovery) return
    setBusy('recover-authority')
    setError(null)
    try {
      const recovered = await recoverPendingDeviceAuthority()
      setAuthorityRecovery(!recovered)
      if (recovered) {
        await access.refresh()
        setSent('Recovered the newly issued credential in protected storage.')
      }
    } catch (cause) { setError(messageFor(cause)) }
    finally { setBusy(null) }
  }

  const exactGrantHeaders = (pending: PendingPrivilegedAction): Record<string, string> | null => {
    const grant = access.session?.step_up
    if (!grant || grant.action !== pending.operation || grant.resource_type !== pending.resourceType
      || grant.resource_id !== pending.resourceId || grant.request_digest !== pending.requestDigest
      || grant.nonce !== pending.nonce || Date.parse(grant.active_until) <= Date.now()) return null
    return {
      'x-orchestra-step-up-grant': grant.id,
      'x-orchestra-step-up-nonce': grant.nonce,
    }
  }

  const requestOrRunStepUp = async (input: {
    scope: 'agent-control' | 'terminal-write' | 'approve'
    operation: string
    resourceType: PendingPrivilegedAction['resourceType']
    resourceId: string
    canonicalRequest: string
    path: string
    body?: unknown
  }): Promise<boolean> => {
    if (!access.online) return false
    const requestDigest = await remoteMutationDigest(JSON.parse(input.canonicalRequest))
    const pending = pendingAction?.operation === input.operation
      && pendingAction.resourceType === input.resourceType
      && pendingAction.resourceId === input.resourceId
      && pendingAction.requestDigest === requestDigest
      ? pendingAction : {
          operation: input.operation,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          requestDigest,
          nonce: crypto.randomUUID(),
        }
    const headers = exactGrantHeaders(pending)
    if (!headers) {
      if (!access.hasScope(input.scope)) throw new Error(`${input.scope} scope is not granted.`)
      setPendingAction(pending)
      await access.requestStepUp(input.scope, input.resourceType, input.resourceId, {
        operation: input.operation,
        requestDigest,
        nonce: pending.nonce,
      })
      setSent('Exact action requested. Confirm it on the trusted local screen, then retry here.')
      return false
    }
    await api('POST', input.path, input.body, headers)
    setPendingAction(null)
    await access.refresh()
    return true
  }

  const pauseAgent = async (agent: RemoteAgentSummary) => {
    if (!access.online || busy || !access.hasScope('agent-control')) return
    setBusy('message')
    try {
      await api('POST', `/os/remote/agents/${agent.id}/pause`)
      setSent(`${agent.name} paused with this device attributed in audit evidence.`)
      await loadControls()
    } catch (cause) { setError(messageFor(cause)) }
    finally { setBusy(null) }
  }

  const stopAgent = async (agent: RemoteAgentSummary) => {
    setBusy('message')
    try {
      const applied = await requestOrRunStepUp({
        scope: 'agent-control', operation: 'agent.stop', resourceType: 'agent', resourceId: String(agent.id),
        canonicalRequest: JSON.stringify({ operation: 'agent.stop', agent_id: agent.id }),
        path: `/os/remote/agents/${agent.id}/stop`,
      })
      if (applied) { setSent(`${agent.name} stopped.`); await loadControls() }
    } catch (cause) { setError(messageFor(cause)) }
    finally { setBusy(null) }
  }

  const readTerminal = async (agent: RemoteAgentSummary) => {
    if (!agent.process_id || !access.online) return
    setTerminalAgent(agent)
    try {
      const response = asObject(await api('GET', `/os/remote/processes/${encodeURIComponent(agent.process_id)}/terminal`))
      setTerminalOutput(Array.isArray(response.redacted_output)
        ? response.redacted_output.map(asObject).flatMap((row) => typeof row.data === 'string'
          ? [{ seq: Number(row.seq), stream: String(row.stream ?? 'stdout'), data: row.data }] : [])
        : [])
    } catch (cause) { setError(messageFor(cause)) }
  }

  const writeTerminal = async () => {
    if (!terminalAgent?.process_id || !terminalInput || !access.online) return
    setBusy('message')
    try {
      const bytes = new TextEncoder().encode(terminalInput)
      const inputDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('')
      const applied = await requestOrRunStepUp({
        scope: 'terminal-write', operation: 'terminal.input', resourceType: 'process',
        resourceId: terminalAgent.process_id,
        canonicalRequest: JSON.stringify({
          operation: 'terminal.input', process_id: terminalAgent.process_id,
          input_digest: inputDigest, byte_length: bytes.byteLength,
        }),
        path: `/os/remote/processes/${encodeURIComponent(terminalAgent.process_id)}/terminal/input`,
        body: { data: terminalInput },
      })
      if (applied) { setTerminalInput(''); setSent('Terminal input applied with exact step-up and device attribution.') }
    } catch (cause) { setError(messageFor(cause)) }
    finally { setBusy(null) }
  }

  const decideApproval = async (approval: RemoteApprovalSummary, decision: 'deny' | 'allow') => {
    if (!access.online || busy || !access.hasScope('approve')) return
    setBusy('message')
    try {
      if (decision === 'deny') {
        await api('POST', `/os/remote/approvals/${encodeURIComponent(approval.id)}/decision`, { decision })
      } else {
        const operation = 'approval.allow'
        const applied = await requestOrRunStepUp({
          scope: 'approve', operation, resourceType: 'approval', resourceId: approval.id,
          canonicalRequest: JSON.stringify({ operation, approval_id: approval.id, decision }),
          path: `/os/remote/approvals/${encodeURIComponent(approval.id)}/decision`, body: { decision },
        })
        if (!applied) return
      }
      setSent(`Approval ${decision === 'deny' ? 'denied' : 'allowed'} with exact device attribution.`)
      await loadControls()
    } catch (cause) { setError(messageFor(cause)) }
    finally { setBusy(null) }
  }

  if (!access.checking && (!access.session || access.error)) {
    return <PairingRequired error={access.error || error} onSignedIn={() => void access.refresh()} />
  }

  return (
    <main className="remote-device-shell">
      <OfflineStateBanner />
      <header className="remote-shell-header">
        <div className="remote-shell-brand">
          <OrchestraMark className="remote-brand-mark" />
          <div>
            <p className="settings-kicker">Paired remote shell</p>
            <h1>Orchestra monitor</h1>
            <p>Classified board summaries, no-tool messages, named-device controls, and device-bound push only.</p>
          </div>
        </div>
        <div className="remote-shell-device">
          <strong>{access.session?.name ?? 'Verifying device…'}</strong>
          <span>{access.online ? 'Online' : 'Offline · read-only'}</span>
          <button type="button" disabled={!access.online || busy !== null || !access.session}
            onClick={() => void rotate()}>{busy === 'rotate' ? 'Rotating…' : 'Rotate credential + key'}</button>
          {authorityRecovery && <button type="button" className="remote-authority-recover"
            disabled={busy !== null} onClick={() => void recoverAuthority()}>
            {busy === 'recover-authority' ? 'Recovering…' : 'Recover issued credential'}
          </button>}
        </div>
      </header>

      {error && <p className="remote-access-error" role="alert">{error}</p>}
      {sent && <p className="remote-shell-success" role="status">{sent}</p>}

      <section className="remote-shell-summary" aria-labelledby="remote-boards-title">
        <div className="remote-shell-section-title">
          <div><h2 id="remote-boards-title">Granted boards</h2><p>Only redacted summaries explicitly granted to this DeviceSession.</p></div>
          <button type="button" onClick={() => void load()} disabled={!access.online || !access.hasScope('observe')}>Refresh</button>
        </div>
        {!access.hasScope('observe') && <p>Observe scope is not granted.</p>}
        {access.hasScope('observe') && boards.length === 0 && <p>No readable boards are granted to this device.</p>}
        <div className="remote-shell-board-grid">
          {boards.map((board) => (
            <button type="button" key={board.id}
              className={selectedId === board.id ? 'remote-shell-board selected' : 'remote-shell-board'}
              onClick={() => { setSelectedId(board.id); setMessageKey(null) }}>
              <strong>{board.name}</strong>
              <span>{board.status === 'active' ? 'Work is active' : 'No open work'}</span>
              <span>{board.attention_count} need attention</span>
            </button>
          ))}
        </div>
      </section>

      <section className="remote-shell-controls" aria-labelledby="remote-controls-title">
        <div className="remote-shell-section-title">
          <div><h2 id="remote-controls-title">Agents and approvals</h2>
            <p>Terminal output is redacted and view-only. Stop, terminal input, and allow decisions require exact local step-up.</p></div>
          <button type="button" onClick={() => void loadControls()} disabled={!access.online}>Refresh</button>
        </div>
        <div className="remote-agent-list">
          {agents.map((agent) => <article key={agent.id}>
            <div><strong>{agent.name}</strong><span>{agent.provider} · {agent.status}</span></div>
            <button type="button" disabled={!agent.process_id || !access.online}
              onClick={() => void readTerminal(agent)}>View terminal</button>
            <button type="button" disabled={!access.online || !access.hasScope('agent-control') || busy !== null}
              onClick={() => void pauseAgent(agent)}>Pause</button>
            <button type="button" disabled={!access.online || !access.hasScope('agent-control') || busy !== null}
              onClick={() => void stopAgent(agent)}>Stop · confirm</button>
          </article>)}
          {!agents.length && <p>No active agents are visible for this board.</p>}
        </div>
        {terminalAgent?.process_id && <section className="remote-terminal-view" aria-label={`${terminalAgent.name} terminal`}>
          <header><strong>{terminalAgent.name} · redacted terminal</strong><span>View-only by default</span></header>
          <pre>{terminalOutput.map((row) => row.data).join('') || 'No output available.'}</pre>
          <label><span>Explicit terminal input</span><textarea value={terminalInput} rows={3} maxLength={65_536}
            disabled={!access.online || !access.hasScope('terminal-write')}
            onChange={(event) => setTerminalInput(event.target.value)} /></label>
          <button type="button" disabled={!terminalInput || !access.online || !access.hasScope('terminal-write') || busy !== null}
            onClick={() => void writeTerminal()}>Send input · confirm exact action</button>
        </section>}
        <div className="remote-approval-list">
          {approvals.map((approval) => <article key={approval.id}>
            <div><strong>{approval.summary}</strong><span>{approval.severity} risk · raw parameters withheld</span></div>
            <button type="button" disabled={!access.online || !access.hasScope('approve') || busy !== null}
              onClick={() => void decideApproval(approval, 'deny')}>Deny</button>
            <button type="button" disabled={!access.online || !access.hasScope('approve') || busy !== null}
              onClick={() => void decideApproval(approval, 'allow')}>Allow · confirm</button>
          </article>)}
        </div>
      </section>

      <section className="remote-shell-message" aria-labelledby="remote-message-title">
        <h2 id="remote-message-title">Send a no-tool message</h2>
        <p>Messages enter a quarantined no-tool queue. They cannot become an agent command from this scope.</p>
        <label><span>Granted board</span>
          <select value={selectedId ?? ''} onChange={(event) => { setSelectedId(Number(event.target.value)); setMessageKey(null) }}
            disabled={!access.online || boards.length === 0}>
            {boards.map((board) => <option value={board.id} key={board.id}>{board.name}</option>)}
          </select>
        </label>
        <label><span>Message</span>
          <textarea value={body} maxLength={4_000} rows={5}
            placeholder="Ask a bounded question without terminal or tool authority"
            disabled={!access.online || !access.hasScope('message') || boards.length === 0}
            onChange={(event) => { setBody(event.target.value); setMessageKey(null) }} />
        </label>
        <button type="button" onClick={() => void send()} disabled={!canMessage || busy !== null}>
          {busy === 'message' ? 'Sending…' : access.hasScope('message') ? 'Send no-tool message' : 'Message scope not granted'}
        </button>
      </section>

      <section className="remote-shell-management" aria-labelledby="remote-device-management-title">
        <h2 id="remote-device-management-title">Trusted device management</h2>
        <p>Self notifications are available to every paired device. Peer inventory and revoke remain scope- and target-bound.</p>
        <RemoteAccessCenter remoteShell />
      </section>
    </main>
  )
}
