import React, { useEffect, useState } from 'react'
import { billingPrimaryAction, checkoutOutcome } from './billingRedirect'
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
 * already knows how to price. Only used for an org with NO subscription at all
 * — see `openCheckout` below and `billingPrimaryAction`. */
const CLOUD_BASE_LOOKUP_KEY = 'cloud_base_monthly'

export function BillingPage({ orgId }: { orgId: string }) {
  const [entitlements, setEntitlements] = useState<HubEntitlements | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'checkout' | 'portal' | null>(null)
  const [outcome, setOutcome] = useState<'success' | 'cancelled' | null>(
    () => (typeof window === 'undefined' ? null : checkoutOutcome(window.location.search)),
  )

  // Read once, then strip the query parameter, so a reload (or a later navigation) doesn't
  // keep re-announcing a checkout that already happened. `replaceState` leaves no history
  // entry to go "back" into.
  useEffect(() => {
    if (!outcome || typeof window === 'undefined') return
    window.history.replaceState({}, '', window.location.pathname)
  }, [outcome])

  useEffect(() => {
    let cancelled = false
    getHubEntitlements(orgId)
      .then((next) => { if (!cancelled) setEntitlements(next) })
      .catch((e) => { if (!cancelled) setError(e instanceof HubApiError ? e.message : 'failed to load billing') })
    return () => { cancelled = true }
  }, [orgId])

  /**
   * Checkout — reached ONLY by an org with no subscription at all.
   *
   * The primary button used to send tier `'cloud'` here as well as `'none'`, which
   * double-billed an existing Cloud customer: a second Stripe subscription against the same
   * customer, while `subscriptions.org_id` is a PRIMARY KEY — so the sync overwrote the row
   * and the first subscription's purchased seats and packs became 0, with both still being
   * charged. Cancelling either one then suspended the org while the other kept billing. An
   * org that already has a subscription now goes to the Stripe customer portal instead
   * (`openPortal`), where quantities change on the subscription they already have. The server
   * refuses a second checkout regardless (`createCheckoutSession` in src/hub/billing.ts) —
   * this is the client half of that fix, not the enforcement.
   */
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
      {outcome === 'success' && (
        <p className="billing-checkout-success" role="status">
          Payment received — thanks. Your plan is below. If the numbers still look like your
          old plan, Stripe's confirmation is still in flight; reload in a moment.
          <button type="button" className="btn ghost" onClick={() => setOutcome(null)}>Dismiss</button>
        </p>
      )}
      {outcome === 'cancelled' && (
        <p className="billing-checkout-cancelled" role="status">
          Checkout cancelled — nothing was charged.
          <button type="button" className="btn ghost" onClick={() => setOutcome(null)}>Dismiss</button>
        </p>
      )}

      <section className="billing-card">
        <h2>Plan</h2>
        <p className="billing-plan-name">{TIER_LABEL[entitlements.tier]}</p>
        {!entitlements.subscribed && (
          <p className="billing-suspended" role="alert">
            This org has no subscription, so writes are disabled — agents cannot create or move
            cards. Subscribe below to enable them. Reading the board always works.
          </p>
        )}
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
        {billingPrimaryAction(entitlements) === 'portal' ? (
          <button type="button" className="btn primary" disabled={busy !== null} onClick={openPortal}>
            {busy === 'portal' ? 'Opening…' : 'Manage plan and seats'}
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy !== null} onClick={openCheckout}>
            {busy === 'checkout' ? 'Opening…' : 'Subscribe'}
          </button>
        )}
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
