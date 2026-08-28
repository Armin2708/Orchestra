import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/react'

/**
 * Sign-in / sign-up / account controls for the topbar.
 *
 * Renders nothing when no Clerk publishable key is configured, so the local
 * single-machine app looks exactly as it did before hub mode existed.
 */
export function ClerkAuthControls() {
  if (!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) return null
  return (
    <div className="clerk-auth">
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button className="tab" type="button">Sign in</button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button className="tab" type="button">Sign up</button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </div>
  )
}
