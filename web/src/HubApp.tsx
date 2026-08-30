import React, { useEffect, useState } from 'react'
import { CreateOrganization, OrganizationList, useAuth, useOrganization } from '@clerk/react'
import { OrchestraMark } from './BrandMark'
import { ClerkAuthControls } from './ClerkAuthControls'
import { HubBoard } from './HubBoard'
import { BillingPage } from './BillingPage'
import { UnsubscribedBanner } from './UnsubscribedBanner'
import { checkoutOutcome } from './billingRedirect'
import { HubApiError, mintHubDeviceToken, resolveHubIdentity } from './hubApi'
import './hubBoard.css'

type HubTab = 'board' | 'billing'

/**
 * The hub-mode shell: a separate deployment from the local single-machine app
 * (see App.tsx's `hubConfigured()` gate) — signed-in-user + org-scoped, no
 * device-authority/pairing concerns at all.
 */
export function HubApp() {
  const { isLoaded, isSignedIn } = useAuth()

  if (!isLoaded) return <HubShell>Loading…</HubShell>
  if (!isSignedIn) return <HubSignedOut />
  return <HubSignedIn />
}

function HubShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app hub-app">
      <header className="topbar">
        <div className="brand"><OrchestraMark /><span className="brand-title">Orchestra</span></div>
        <div className="topbar-actions"><ClerkAuthControls /></div>
      </header>
      <main className="hub-app-body">{children}</main>
    </div>
  )
}

function HubSignedOut() {
  return (
    <HubShell>
      <div className="hub-signin-prompt">
        <p>Sign in to see your org's board.</p>
      </div>
    </HubShell>
  )
}

function HubSignedIn() {
  const { organization, isLoaded } = useOrganization()
  const [identity, setIdentity] = useState<{ orgId: string } | null>(null)
  const [identityError, setIdentityError] = useState<string | null>(null)
  // Stripe sends a paying customer back to `${WEB_ORIGIN}/billing?checkout=success`. This app
  // has no router; `vercel.json`'s SPA rewrite serves index.html for that path, and this is
  // what turns it into the billing tab rather than the board. `BillingPage` reads (and then
  // clears) the parameter itself to show the acknowledgement.
  const [tab, setTab] = useState<HubTab>(() => {
    if (typeof window === 'undefined') return 'board'
    if (checkoutOutcome(window.location.search)) return 'billing'
    return window.location.pathname === '/billing' ? 'billing' : 'board'
  })
  const [mintOpen, setMintOpen] = useState(false)

  useEffect(() => {
    if (!organization) { setIdentity(null); return }
    let cancelled = false
    setIdentity(null)
    setIdentityError(null)
    resolveHubIdentity()
      .then((next) => { if (!cancelled) setIdentity(next) })
      .catch((e) => { if (!cancelled) setIdentityError(e instanceof HubApiError ? e.message : 'failed to resolve org') })
    return () => { cancelled = true }
    // Re-resolve whenever the member switches the active Clerk org — `organization.id`
    // (not the whole object, which Clerk may re-instantiate on unrelated updates) is
    // the actual dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id])

  if (!isLoaded) return <HubShell>Loading…</HubShell>

  if (!organization) {
    return (
      <HubShell>
        <div className="hub-org-picker">
          <h2>Choose or create an org</h2>
          <OrganizationList hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
          <CreateOrganization afterCreateOrganizationUrl="/" />
        </div>
      </HubShell>
    )
  }

  if (identityError) {
    return (
      <HubShell>
        <div className="hub-board-error" role="alert">{identityError}</div>
      </HubShell>
    )
  }

  if (!identity) return <HubShell>Loading…</HubShell>

  return (
    <div className="app hub-app">
      <header className="topbar">
        <div className="brand"><OrchestraMark /><span className="brand-title">Orchestra</span></div>
        <div className="topbar-actions">
          <nav className="view-tabs" role="tablist" aria-label="Hub views">
            <button type="button" role="tab" className={tab === 'board' ? 'tab active' : 'tab'}
              aria-selected={tab === 'board'} onClick={() => setTab('board')}>Board</button>
            <button type="button" role="tab" className={tab === 'billing' ? 'tab active' : 'tab'}
              aria-selected={tab === 'billing'} onClick={() => setTab('billing')}>Billing</button>
          </nav>
          <button type="button" className="tab" onClick={() => setMintOpen(true)}>Connect a daemon</button>
          <ClerkAuthControls />
        </div>
      </header>
      <main className="hub-app-body">
        {/* Above the board, not inside it: the refusal applies to the whole org, and the
            board is exactly where someone stands while wondering why nothing appears. */}
        {tab === 'board' && (
          <UnsubscribedBanner orgId={identity.orgId} onOpenBilling={() => setTab('billing')} />
        )}
        {tab === 'board' ? <HubBoard orgId={identity.orgId} /> : <BillingPage orgId={identity.orgId} />}
      </main>
      {mintOpen && <DeviceMintDialog orgId={identity.orgId} onClose={() => setMintOpen(false)} />}
    </div>
  )
}

/**
 * Task 7's device-token mint UI: `mintDeviceToken` (devices.ts) had no HTTP
 * route before this task (see the report) — without one, no daemon could ever
 * obtain a token. The plaintext token is returned exactly once by the server
 * (only its hash is stored), so this shows it once with a copy button and
 * never re-fetches it. Seat-cap refusals (`assertSeatAvailable`) arrive as a
 * normal `HubApiError` whose `.message` is already the server's actionable
 * text (see hubApi.ts's `hubErrorMessage`) — rendered directly, not swapped
 * for a generic error.
 */
function DeviceMintDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const [name, setName] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const mint = async () => {
    setBusy(true); setError(null)
    try {
      const result = await mintHubDeviceToken(orgId, name.trim() || 'daemon')
      setToken(result.token)
    } catch (e) {
      setError(e instanceof HubApiError ? e.message : 'could not mint a device token')
    } finally { setBusy(false) }
  }

  const copy = async () => {
    if (!token) return
    try { await navigator.clipboard.writeText(token); setCopied(true) } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="hub-modal-scrim" onClick={onClose}>
      <div className="hub-modal" role="dialog" aria-modal="true" aria-label="Connect a daemon"
        onClick={(event) => event.stopPropagation()}>
        {token ? (
          <>
            <h2>Copy this token now</h2>
            <p>It won't be shown again — paste it into your daemon's setup.</p>
            <code className="hub-token">{token}</code>
            <div className="billing-actions">
              <button type="button" className="btn primary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              <button type="button" className="btn ghost" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <h2>Connect a daemon</h2>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Device name (e.g. laptop)" aria-label="Device name" className="hub-token-input" />
            {error && <p className="billing-error" role="alert">{error}</p>}
            <div className="billing-actions">
              <button type="button" className="btn primary" disabled={busy} onClick={mint}>
                {busy ? 'Minting…' : 'Generate token'}
              </button>
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
