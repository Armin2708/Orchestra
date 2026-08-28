import React, { useEffect, useState } from 'react'
import {
  createHubCheckout, createHubPortal, getHubEntitlements, HubApiError, HubEntitlements,
} from './hubApi'
import './hubBoard.css'

const TIER_LABEL: Record<HubEntitlements['tier'], string> = {
  cloud: 'Cloud', business: 'Business', none: 'No active plan',
}

/** Lookup key for the Cloud base subscription's Stripe price — matches the
 * `cloud_base_monthly` key `deriveQuantities` (billing.ts) already recognizes;
 * this page never invents new pricing, it only starts the checkout Stripe
 * already knows how to price. */
const CLOUD_BASE_LOOKUP_KEY = 'cloud_base_monthly'

export function BillingPage({ orgId }: { orgId: string }) {
  const [entitlements, setEntitlements] = useState<HubEntitlements | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'checkout' | 'portal' | null>(null)

  useEffect(() => {
    let cancelled = false
    getHubEntitlements(orgId)
      .then((next) => { if (!cancelled) setEntitlements(next) })
      .catch((e) => { if (!cancelled) setError(e instanceof HubApiError ? e.message : 'failed to load billing') })
    return () => { cancelled = true }
  }, [orgId])

  const openCheckout = async () => {
    setBusy('checkout'); setError(null)
    try {
      const { url } = await createHubCheckout(orgId, CLOUD_BASE_LOOKUP_KEY, 1)
      window.location.assign(url)
    } catch (e) {
      setError(e instanceof HubApiError ? e.message : 'could not start checkout')
    } finally { setBusy(null) }
  }

  const openPortal = async () => {
    setBusy('portal'); setError(null)
    try {
      const { url } = await createHubPortal(orgId)
      window.location.assign(url)
    } catch (e) {
      setError(e instanceof HubApiError ? e.message : 'could not open the billing portal')
    } finally { setBusy(null) }
  }

  if (error && entitlements === null) {
    return <div className="hub-board-error" role="alert">{error}</div>
  }
  if (entitlements === null) {
    return <div className="hub-board-loading">Loading…</div>
  }

  return (
    <div className="billing-page">
      <section className="billing-card">
        <h2>Plan</h2>
        <p className="billing-plan-name">{TIER_LABEL[entitlements.tier]}</p>
        {entitlements.status === 'suspended' && (
          <p className="billing-suspended" role="alert">
            Billing is suspended — writes are disabled until this is resolved.
          </p>
        )}
      </section>

      <section className="billing-card">
        <h2>Seats</h2>
        <UsageMeter used={entitlements.seats.used} entitled={entitlements.seats.entitled} unit="seat" />
        {entitlements.seats.overCap && (
          <p className="billing-overcap">
            Over your seat cap — members past your entitled count can still sign in and view the
            board, but cannot connect a daemon until you add seats.
          </p>
        )}
      </section>

      <section className="billing-card">
        <h2>Agent capacity</h2>
        <UsageMeter used={entitlements.agents.used} entitled={entitlements.agents.entitled} unit="concurrent agent" />
        {entitlements.agents.overCap && (
          <p className="billing-overcap">Over your concurrent-agent cap.</p>
        )}
      </section>

      {error && <p className="billing-error" role="alert">{error}</p>}

      <div className="billing-actions">
        <button type="button" className="btn primary" disabled={busy !== null} onClick={openCheckout}>
          {busy === 'checkout' ? 'Opening…' : 'Upgrade / add seats'}
        </button>
        <button type="button" className="btn ghost" disabled={busy !== null} onClick={openPortal}>
          {busy === 'portal' ? 'Opening…' : 'Manage billing'}
        </button>
      </div>
    </div>
  )
}

function UsageMeter({ used, entitled, unit }: { used: number; entitled: number; unit: string }) {
  const pct = entitled > 0 ? Math.min(100, Math.round((used / entitled) * 100)) : 0
  return (
    <div className="billing-meter">
      <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
      <span className="progress-label">{used} / {entitled} {unit}{entitled === 1 ? '' : 's'}</span>
    </div>
  )
}
