import { OrganizationSwitcher, Show, SignInButton, SignUpButton, UserButton } from '@clerk/react'

/**
 * Sign-in / sign-up / account / org-switcher controls for the topbar.
 *
 * Renders nothing when no Clerk publishable key is configured, so the local
 * single-machine app looks exactly as it did before hub mode existed.
 *
 * The org switcher only makes sense once signed in (there is no org to switch
 * between otherwise) — it lives inside the same `signed-in` `<Show>` as
 * `UserButton` rather than a second one, since Clerk's `Show` mounts/unmounts
 * its children on every auth transition and there is no reason to pay that
 * twice for two elements that always change state together.
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
        <OrganizationSwitcher hidePersonal createOrganizationMode="modal" organizationProfileMode="modal" />
        <UserButton />
      </Show>
    </div>
  )
}
