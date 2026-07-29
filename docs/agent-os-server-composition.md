# Agent OS server composition boundary

Status: DOM-015 delivered at exact code head
`98c722f10357311d5c1dfdb4ca8e83228adc2b8c`.

## TL;DR

`buildServer` remains the Fastify composition and legacy-compatibility hub, but no longer assembles
Agent OS provider/driver defaults or registers the focused Agent OS plugin directly. That work is
delegated to `src/server-composition.ts`, whose executable contract excludes canonical domain
transitions, service construction, persistence, validation, SQL, and inline HTTP handlers.

This slice changes no database schema, URL, status code, response envelope, provider label,
runtime capability, CLI command, or rendered UI.

## Boundary contract

| Concern | Exact ownership |
|---|---|
| `buildServer` | Fastify lifecycle/authentication, dependency injection, focused plugin registration, supported legacy compatibility routes |
| `registerAgentOsServerComposition` | one composition-only delegation seam |
| `composeAgentOsRouteOptions` | already-created dependency injection plus the existing provider/driver fallbacks |
| `registerAgentOsRoutes` | canonical `/api/v1/os` plugin registration |
| Focused services | canonical state transitions, persistence, and domain validation |

The executable `SERVER_COMPOSITION_CONTRACT` calls this role
`composition_and_compatibility_routing`. Its exclusions are fail-closed documentation: adding a
canonical service constructor or inline Agent OS route to the server/composition boundary fails
the direct test gate.

```text
daemon-created dependencies
          |
          v
      buildServer
          |
          v
registerAgentOsServerComposition
          |
          +--> composeAgentOsRouteOptions
          |
          v
 registerAgentOsRoutes --> focused route plugins/services
```

## Preserved behavior

- Without the daemon Conductor, Claude remains unavailable with the existing explanatory detail.
- Codex remains unavailable without the daemon app-server runtime and retains
  `CODEX_CAPABILITIES`.
- Shell availability still follows the injected PTY runtime.
- A daemon host still supplies its live provider catalog.
- Explicit `drivers` and `providers` overrides retain identity and precedence.
- `buildServer` still derives operator authorization from `request.orchestraPrincipal`.
- `/api/v1/os/drivers` and `/api/v1/os/providers` retain their public fallback envelopes.

## Static drift guard

`test/server-composition.test.ts` verifies that:

- `src/server.ts` delegates through `registerAgentOsServerComposition` and does not import
  `registerAgentOsRoutes`;
- the composition module invokes the focused registrar exactly once;
- the composition module defines no Fastify route handler and executes no prepared SQL;
- neither boundary constructs an orchestration, conversation, delivery, knowledge, conflict, or
  scheduler service;
- the runtime fallbacks and explicit injection overrides remain behaviorally identical.

## Deliberate non-goals

- Existing supported Board routes remain compatibility routing in `src/server.ts`; DOM-015 does
  not claim that legacy tables are canonical projections.
- DOM-016 still owns projection/compatibility-view design and source-of-truth rules.
- DOM-017 still owns forward migrations, backfills, validation queries, and rollback plans.
- DOM-019 still owns old-versus-canonical migration telemetry.
- TOOL-014 and BASE-010 remain open until exact real-provider evidence exists.
- Reserved Discussions and device-pairing services, compatibility-only conflicts, and
  persistence-only Knowledge retain their DOM-014 implementation states.

## Evidence

- Direct composition contract: 1 file / 5 tests PASS.
- Focused regression: 6 files / 28 tests PASS.
- Complete default-parallel suite: 154 files / 1,228 tests PASS.
- Complete one-worker suite: 154 files / 1,228 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Changed-diff Gitleaks and `git diff --check` PASS.
- GitNexus staged review: LOW, 2 stale-index-adjacent touched symbols, and no affected execution
  flow. Pre-edit review correctly classified `buildServer` and `ServerOptions` as CRITICAL.

The first complete run exposed a user-login-shell Oh My Zsh update prompt that consumed the first
character of a PTY test command. Re-running with `DISABLE_AUTO_UPDATE=true` scoped only to the test
process made the host-shell fixture deterministic; no user shell configuration or project file was
changed.

## Rollback

Revert the DOM-015 code commit and restore the prior inline provider/driver fallback block plus
direct `registerAgentOsRoutes` call in `buildServer`. Because this slice changes no schema or
durable state, rollback requires no migration, backfill, data rewrite, route deprecation, or client
coordination.
