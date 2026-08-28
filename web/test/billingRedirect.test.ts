import { describe, it, expect } from 'vitest'
import { billingPrimaryAction, checkoutOutcome } from '../src/billingRedirect.js'

describe('checkoutOutcome', () => {
  it('reads the success redirect Stripe sends the customer back to', () => {
    expect(checkoutOutcome('?checkout=success')).toBe('success')
  })

  it('reads the cancelled redirect', () => {
    expect(checkoutOutcome('?checkout=cancelled')).toBe('cancelled')
  })

  it('ignores an absent, empty, or unrecognized value rather than announcing something', () => {
    expect(checkoutOutcome('')).toBeNull()
    expect(checkoutOutcome('?other=1')).toBeNull()
    expect(checkoutOutcome('?checkout=')).toBeNull()
    expect(checkoutOutcome('?checkout=whatever')).toBeNull()
  })

  it('tolerates the leading ? being absent and other parameters being present', () => {
    expect(checkoutOutcome('utm=x&checkout=success')).toBe('success')
  })
})

describe('billingPrimaryAction', () => {
  /** The double-billing regression: tier 'cloud' used to route into CHECKOUT, creating a
   * second Stripe subscription against the same customer and zeroing the seats and packs the
   * first one paid for. */
  it('sends an org that already has a subscription to the portal, never to checkout', () => {
    expect(billingPrimaryAction({ subscribed: true })).toBe('portal')
  })

  it('sends an org with no subscription to checkout — that is how a plan starts', () => {
    expect(billingPrimaryAction({ subscribed: false })).toBe('checkout')
  })
})
