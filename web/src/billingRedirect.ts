/**
 * The two pure decisions the billing page makes, kept out of the component so they can be
 * unit-tested without a DOM (web/test runs with no jsdom — see web/vitest.config.ts).
 */

/**
 * Reads Stripe's post-checkout redirect. `createCheckoutSession` (src/hub/billing.ts) sends
 * the customer back to `${WEB_ORIGIN}/billing?checkout=success` (or `…=cancelled`). Before
 * `vercel.json` gained an SPA rewrite that path had no build output and 404'd, so a paying
 * customer's last impression of checkout was a Vercel error page.
 */
export function checkoutOutcome(search: string): 'success' | 'cancelled' | null {
  const value = new URLSearchParams(search).get('checkout')
  return value === 'success' || value === 'cancelled' ? value : null
}

/**
 * Where the billing page's primary button sends this org.
 *
 * Routing on `subscribed` — has ANY Stripe subscription ever synced — not on tier. The page
 * used to send tier `'cloud'` into checkout alongside `'none'`, which created a SECOND Stripe
 * subscription against the same customer. `subscriptions.org_id` is a PRIMARY KEY, so the
 * sync overwrote the one row: the first subscription's purchased seats and agent packs became
 * 0 while both kept billing, and cancelling either one then suspended the org. An org that
 * already has a subscription belongs in the Stripe customer portal, where quantities change
 * on the subscription it already has.
 *
 * The server refuses a second checkout independently (`createCheckoutSession`) — a client can
 * always be bypassed, so this is the convenience half, not the enforcement.
 */
export function billingPrimaryAction(entitlements: { subscribed: boolean }): 'checkout' | 'portal' {
  return entitlements.subscribed ? 'portal' : 'checkout'
}
