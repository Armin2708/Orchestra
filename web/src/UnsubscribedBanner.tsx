import { useEffect, useState } from 'react'
import { getHubEntitlements } from './hubApi'

/**
 * Says out loud that an unsubscribed org cannot write.
 *
 * The hub enforces this at the API (`assertOrgWritable`, src/hub/entitlements.ts) — a
 * daemon's very first presence heartbeat is refused — but until now nothing in the UI
 * said so. You landed on an empty board, connected a daemon, and the only evidence was a
 * 403 in a terminal that had usually scrolled away. The Billing tab existed and was never
 * a reason to click.
 *
 * Renders nothing for a subscribed org, and nothing while it is still loading: a banner
 * that flashes on every page load would be worse than the silence it replaces.
 */
export function UnsubscribedBanner({ orgId, onOpenBilling }: {
  orgId: string
  onOpenBilling: () => void
}) {
  const [subscribed, setSubscribed] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    setSubscribed(null)
    getHubEntitlements(orgId)
      .then((next) => { if (!cancelled) setSubscribed(next.subscribed) })
      // A failed entitlements read is not evidence of anything — stay quiet rather than
      // accusing a paying org of not paying.
      .catch(() => { if (!cancelled) setSubscribed(true) })
    return () => { cancelled = true }
  }, [orgId])

  if (subscribed !== false) return null

  return (
    <div className="hub-paywall" role="status">
      <div>
        <strong>This organization has no subscription.</strong>{' '}
        Daemons can connect and everyone can read the board, but agents cannot post
        presence, cards, or mail until billing is started.
      </div>
      <button type="button" className="btn primary" onClick={onOpenBilling}>
        Start subscription
      </button>
    </div>
  )
}
