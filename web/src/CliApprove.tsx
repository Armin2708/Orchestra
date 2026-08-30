import React, { useState } from 'react'
import { SignIn, useAuth } from '@clerk/react'
import { OrchestraMark } from './BrandMark'
import { hubFetch, HubApiError } from './hubApi'

/**
 * The browser half of `orchestra login`.
 *
 * A terminal opened this page and is waiting on a loopback listener. Approving trades the
 * signed-in Clerk session for a one-time code and hands it back by redirecting to that
 * listener. The code is useless to anyone who intercepts it: completing the login also
 * requires the verifier, which never left the terminal.
 *
 * Nothing happens on mount. A link alone must never connect a machine to someone's
 * organization — that is exactly the attack this page is the defence against, so approval
 * is always a deliberate click by a signed-in human who can see which machine is asking.
 */
export function CliApprove({ params }: { params: URLSearchParams }) {
  const { isLoaded, isSignedIn } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const requestId = params.get('request') ?? ''
  const port = params.get('port') ?? ''
  const state = params.get('state') ?? ''
  const label = params.get('label') ?? 'a terminal'

  // The redirect target is built here, from a port this page validates — never from a URL
  // the hub returned. A login can only ever hand its code to loopback on this machine.
  const portNumber = Number(port)
  const validPort = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535
  const usable = Boolean(requestId) && validPort && Boolean(state)

  const approve = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await hubFetch('POST', '/cli/auth/approve', { request_id: requestId }) as { code: string }
      setDone(true)
      const target = new URL(`http://127.0.0.1:${portNumber}/callback`)
      target.searchParams.set('code', result.code)
      target.searchParams.set('state', state)
      window.location.replace(target.toString())
    } catch (cause) {
      setError(cause instanceof HubApiError ? cause.message : 'could not approve this login')
      setBusy(false)
    }
  }

  if (!isLoaded) return <CliShell>Loading…</CliShell>
  if (!isSignedIn) {
    return (
      <CliShell>
        <p className="hub-agent-empty">Sign in to connect {label}.</p>
        <SignIn routing="hash" />
      </CliShell>
    )
  }
  if (!usable) {
    return (
      <CliShell>
        <h2>This link is incomplete</h2>
        <p className="hub-agent-empty">
          Run <code>orchestra login</code> again — the link it opens carries the details this
          page needs.
        </p>
      </CliShell>
    )
  }

  return (
    <CliShell>
      <h2>Connect {label}?</h2>
      <p className="hub-agent-empty">
        This will let the Orchestra daemon on <strong>{label}</strong> connect to one of your
        organizations. You choose which one back in the terminal.
      </p>
      {error && <p className="hub-error">{error}</p>}
      <div className="billing-actions">
        <button type="button" className="btn primary" onClick={() => void approve()} disabled={busy || done}>
          {done ? 'Connected — return to your terminal' : busy ? 'Connecting…' : 'Approve'}
        </button>
        <button type="button" className="btn ghost" onClick={() => window.close()} disabled={busy || done}>
          Cancel
        </button>
      </div>
    </CliShell>
  )
}

function CliShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app hub-app">
      <header className="topbar">
        <div className="brand"><OrchestraMark /><span className="brand-title">Orchestra</span></div>
      </header>
      <main className="hub-main"><div className="hub-panel">{children}</div></main>
    </div>
  )
}
