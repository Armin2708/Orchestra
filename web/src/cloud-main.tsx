import { ClerkProvider } from '@clerk/react'
import { createRoot } from 'react-dom/client'
import { HubApp } from './HubApp'

// The shared cloud workspace's entry — a different deployment from the local board
// (Vercel talking to the hub, see hubApi.ts). Clerk identifies the person; the org
// scopes what they see. There is no local daemon here, so none of the board's
// device-pairing concerns apply.
//
// This bundle is built only by `npm run build:cloud` (vite --mode cloud), which is
// the only build that loads .env.cloud.local. A plain `npm run build` produces the
// local board and cannot pull Clerk in.
const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

function CloudBootstrap() {
  // Fail loudly rather than hanging: without a key Clerk never initialises and the
  // app would sit on "Loading…" forever with the reason buried in the console.
  if (!clerkPublishableKey) {
    return (
      <div className="hub-board-loading">
        Cloud build is missing VITE_CLERK_PUBLISHABLE_KEY — set it in the deployment’s
        build-time environment and rebuild.
      </div>
    )
  }
  return (
    <ClerkProvider publishableKey={clerkPublishableKey} afterSignOutUrl="/">
      <HubApp />
    </ClerkProvider>
  )
}

createRoot(document.getElementById('root')!).render(<CloudBootstrap />)
