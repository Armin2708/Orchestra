// The mastermind is a reserved identity, enforced server-side (src/teams.ts
// MASTERMIND_NAME, src/mastermind-scope.ts). One web-side source of truth so the
// Overview filter and the Teams tab can never drift apart.
export const MASTERMIND_NAME = 'mastermind'

export const isMastermind = (a: { name: string }) => a.name === MASTERMIND_NAME
