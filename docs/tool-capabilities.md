# Tool capability, permission, and provenance contract

Status: Beta Lane B integration candidate, 2026-08-02.

## Release rule

The direct provider terminal remains the source of truth. Managed tool execution is a
separate capability and fails closed unless the exact provider mode, executable evidence,
permission state, and acceptance evidence are all supported. Finding a command on `PATH`,
declaring a manifest, or passing a mock test does not establish provider support.

The declared-provider matrix always contains Claude, Codex, Qwen, and Kimi. Its current
release truth remains:

- Claude managed subscription automation: policy blocked.
- Codex managed subscription automation: candidate until the real acceptance matrix passes.
- Qwen and Kimi managed adapters: explicitly unsupported.
- API or metered execution: never selected as an implicit fallback.

## Capability model

`src/tool-capabilities.ts` normalizes five tool kinds: CLI, MCP server, plugin, skill, and
provider-native integration. Every record carries managed-support state, direct-terminal
evidence, requested and effective permission, safe executable/package provenance, and an
explicit error when it is not ready.

Executable paths are never returned. Only bounded version/platform labels and SHA-256
fingerprints may cross the API. An absent doctor result is `unknown`, not available. A
doctor timeout is distinct from a missing executable and remains unsupported until a real
version is observed.

## Durable session behavior

`SessionToolService` stores policy updates and minimal invocation provenance in the existing
`os_events` log. No new projection or migration is required.

- The default policy is `approval_required`.
- A policy revision prevents lost updates.
- Approval-required requests create durable global `tool.approval.request` attention items.
- Idempotent retries reuse the same approval item and invocation identifier.
- Invocation records contain tool/provider IDs, outcome, provider correlation IDs, argument
  count, and a one-way SHA-256 argument digest. Tool inputs and outputs are withheld.
- A daemon restart reconstructs policy, invocations, and open approvals from durable state.

## Server integration

Create one registry from real evidence and mount the encapsulated plugin below the existing
Agent OS prefix:

```ts
const { registry, matrix } = createDeclaredProviderToolRegistry(
  { doctor, discoveries, accepted, observedAt },
  inspectDeclaredProviderToolIntegrations({ scope: 'project' }),
)

server.register(sessionToolPlugin, {
  prefix: '/api/v1/os',
  db,
  registry,
  providerMatrix: matrix,
  isOperator: (request) => request.orchestraPrincipal === 'operator',
})
```

Routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/provider-tool-capabilities` | Exact four-provider support/evidence matrix |
| `GET` | `/sessions/:id/tools` | Effective policy, drift, provenance, and approvals |
| `PUT` | `/sessions/:id/tools/policy` | Operator-only revisioned policy update |
| `POST` | `/sessions/:id/tools/authorize` | Fail-closed authorization/approval routing |
| `POST` | `/sessions/:id/tools/invocations` | Minimal durable invocation provenance |

Mutations require an `Idempotency-Key` header or equivalent body field.

Deliberate terminal command history is an immutable submission-attempt ledger: validation and the
privacy-preserving digest are committed before bytes are offered to the PTY. The HTTP result is
the delivery outcome; a retained history row does not by itself claim that the process accepted or
executed the command.

## Web integration

`AgentToolControls` is a mountable accessibility-first panel. Its parent supplies a
`SessionToolSnapshot` from `agentToolApi.getSessionTools`, converts a per-tool selection into
the next revisioned rule set, calls `agentToolApi.updatePolicy`, and refreshes the snapshot.
The panel exposes provider evidence/blockers, managed-versus-terminal truth, permission drift,
global approval routing, and the invocation privacy boundary.

## Real-evidence limitations

Deterministic implementation and tests do not remove the external acceptance blockers above.
A provider can move to `supported` only when `accepted(manifest, modeId)` is backed by the real
executable/version/source/platform/auth-mode matrix. Hook/plugin inspection validates actual
configuration files and manifest shape; it does not prove a credentialed provider session.
