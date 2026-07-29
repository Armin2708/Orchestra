# Agent OS Lane 2 Claude/Codex Provider Candidate — 2026-07-29

Status: **reviewable, unregistered Claude adapter candidate**. This lane does not deliver
Claude support, change the Codex candidate, close TOOL-014 or BASE-010, record a provider
acceptance matrix, or enable production contract routing.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/accel-provider-claude-codex` |
| Required base | `b18181a32880eda3c51242fc07d3c3ba22bd66f2` |
| Toolchain | Node `22.20.0`; npm `10.9.3`; no `.env` or `.env.*` file was present |
| Backlog truth | **137 / 375 delivered; 238 open**; TOOL-014 and BASE-010 remain open |
| Candidate | New Claude AgentDriver/provider-contract bridge; not exported, registered, or routed |
| Focused evidence | Claude candidate: 1 file / 7 tests PASS |
| Cross-contract evidence | 8 files / 150 tests PASS |
| Compile evidence | Root source TypeScript PASS; standalone strict candidate-test TypeScript PASS |
| Real provider evidence | **None created or claimed** |

## Asked

Audit the existing Claude/Codex TOOL-013, TOOL-014, and BASE-010 evidence, then add a
credential-free, capability-aware Claude provider-adapter candidate around the existing
`ClaudeAgentDriverAdapter`. Preserve personal-subscription CLI billing as the default, require
explicit API opt-in without fallback, preserve exact capability and unsupported states, redact
managed events, and test launch/recovery/cancellation behavior only to the extent the canonical
contract honestly permits.

The lane was restricted to three new files. It did not edit a manifest, shared bridge, registry,
composition root, provider manager, production wrapper, backlog, migration, acceptance store, or
existing test.

## Evidence audit

| Area | Repository/Vault truth at this base | Lane conclusion |
|---|---|---|
| TOOL-013 | Delivered provider-neutral contract and reserved canonical manifests | Preserve the reserved fingerprints and exact declarations |
| Claude manifest | `unsupported`; SDK-bundled CLI `2.1.212` on `darwin-arm64`; primary native subscription is `policy_blocked` / automation `blocked` because `third_party_subscription_routing_prohibited` | A candidate may exist, but the gateway must not authorize it |
| Claude lifecycle | Existing `ClaudeAgentDriverAdapter` launches, sends, forks provider transcript state, interrupts, stops, and projects transcript/accounting; raw attach exists for legacy recovery | Contract attach, resume, and restart recovery remain explicitly unsupported |
| Codex TOOL-014 | Real app-server adapter, authorized recovery, durable evidence storage, and acceptance harness exist | Codex remains `candidate`, native subscription remains `unknown`, and no real all-pass matrix exists |
| BASE-010 | Exact four-provider version/authentication/billing/capability/platform evidence is incomplete | Remains open; this source-level lane is not provider evidence |
| Backlog | 137 / 375 delivered, 238 open | Counts and checkboxes remain unchanged |

Sources read before implementation included the recovery checkpoint, both required Agentboard Vault
notes, Claude/Codex audit and subscription-first Vault notes, the complete provider contract and
manifests, provider environment and registry boundaries, generic AgentDriver bridge, Claude and
Codex drivers/adapters, focused contract/integration/recovery/security tests, and the subscription
strategy/checkpoints.

## Candidate delivered

`src/runtime/drivers/claude-provider-adapter.ts` adds:

- canonical `CLAUDE_PROVIDER_MANIFEST_V1` binding without cloning or changing the reserved
  declaration;
- SDK-bundled executable discovery only—no PATH, ambient Claude, or environment-command fallback;
- exact bundled CLI version/platform classification and executable-byte fingerprinting, with
  `missing`, `unknown`, `incompatible`, and `untrusted` kept distinct;
- a minimal allowlisted environment for `claude --version`, excluding HOME, PATH, API credentials,
  OAuth values, provider selectors, and endpoints;
- a separate `claude auth status --json` probe using a provider-conflict-stripped environment,
  accepting `claude.ai` account-session evidence, rejecting API-key identity as a credential
  conflict, and otherwise failing closed as unknown;
- personal-subscription selection as the canonical default; API-key mode remains secondary,
  explicitly selected, and durably cost-consent-gated by TOOL-013;
- bridge callbacks for model discovery, launch mapping, effective session evidence, approval
  resolution, usage, and same-workspace transcript-fork child launch;
- sealed fork launch fields so callbacks cannot replace the authorized environment, external
  provider-session ID, workspace, cwd, model, effort, access, permission, or cost boundary;
- suppression of Claude thinking/user echoes, redaction through `defineProviderEventV1`, and
  withholding of raw tool-result text;
- bounded private session bindings: explicit stop, terminal/failed event completion, and natural
  stream completion release bindings, while a consumer-only stream cancellation keeps a live
  session forkable;
- exact lifecycle evidence: launch uses `driver.launch` only after provider authorization,
  follow-up uses `driver.send`, fork uses `driver.forkSession` then `driver.launch`, interrupt and
  cancel use `driver.interrupt`, and stop uses `driver.stop`;
- exact unsupported recovery evidence: public contract attach is unavailable, while resume and
  restart recovery remain `durable_resume_not_implemented_v1`.

The adapter requires explicit integration callbacks rather than inventing effective model,
approval, usage, board, or fork authority. It is intentionally not exported or registered.

## Honest launch, resume, and cancel boundary

- **Launch:** synthetic discovery and account-session readiness can pass, but authorization returns
  `provider_policy_blocked` and `unsupported_provider`. The focused test proves zero raw
  `driver.launch` calls.
- **Cancel:** the capability bridge requires driver interrupt support and maps cancel to the same
  raw `driver.interrupt` boundary. No cancel dispatch can be exercised through the canonical
  gateway because no Claude contract session can first be authorized.
- **Resume/restart:** the canonical manifest declares both unsupported. The focused test proves
  restart authorization includes `capability_unsupported`, and public attach is rejected before
  the legacy driver's raw attach method is called.
- **Fork:** the candidate implements the existing SDK transcript-only fork semantics and launches
  the child only inside the same authorized workspace/cwd. This path is source-tested only and
  remains unreachable while canonical launch is policy-blocked.

These are implementation and negative-routing facts, not a real provider acceptance gate.

## Focused tests

`test/claude-provider-adapter.test.ts` covers:

1. exact SDK-bundled discovery, executable fingerprint, subscription selection, environment
   stripping, credential-free auth-probe environment, and policy-blocked zero dispatch;
2. API mode requiring explicit selection consent and durable cost authority;
3. conservative account-session/API-key/signed-out/unknown authentication classification;
4. exact manifest lifecycle/capability/reason states, Codex candidate preservation, zero acceptance
   matrices, raw attach non-dispatch, and restart failure semantics;
5. managed-event redaction, thinking suppression, and raw tool-result withholding;
6. terminal stream binding cleanup without treating consumer cancellation as session termination;
7. nearby-version incompatibility, unknown version semantics, missing-bundle behavior, and no
   ambient PATH fallback.

## Verification

All commands used the explicit Node 22 path:

```sh
PATH=/Users/arminrad/.nvm/versions/node/v22.20.0/bin:$PATH
```

The login shell otherwise resolved host Node `26.4.0` / npm `11.17.0`; no product constraint was
weakened to accommodate that unsupported host default.

| Gate | Result |
|---|---|
| `node --version`; `npm --version` | `v22.20.0`; `10.9.3` |
| `npx vitest run test/claude-provider-adapter.test.ts` | PASS — 1 file / 7 tests |
| Candidate + provider contract/bridge/Codex/Claude runtime regression set | PASS — 8 files / 150 tests |
| `npx tsc --noEmit --pretty false` | PASS |
| Standalone strict candidate-test TypeScript (`--ignoreConfig`) | PASS |
| Gitleaks `8.30.1`, each new file | PASS — no leaks |
| `git diff --check` | PASS |

`npm ci` reported two pre-existing moderate dependency advisories. This lane did not run
`npm audit fix`, change dependencies, or claim those advisories resolved.

## Graphify and GitNexus

The isolated recovery Graphify graph was queried before source search. It identified the canonical
manifest, generic bridge, raw Claude driver, Codex adapter, and provider registry/test boundaries.

GitNexus was rebuilt for the exact worktree at the required base: 9,433 nodes, 27,621 edges,
622 clusters, and 288 execution flows. Semantic query remained degraded because the MCP server
reported a missing FTS layer even after a forced index refresh, so exact source was reread before
relying on details.

The final staged refresh indexed 9,528 nodes, 27,826 edges, 615 clusters, and 288 flows.
`detect_changes(scope: staged)` resolved exactly the three owned files, reported 102 new/touched
symbols, zero affected existing processes, and LOW risk. The high-risk shared bridge and
medium-risk raw driver remained unchanged.

Pre-edit upstream impact:

| Existing symbol | Risk | Exact result |
|---|---|---|
| `ClaudeAgentDriverAdapter` | MEDIUM, lower-bound | 8 direct / 44 total dependents; interface dispatch may hide callers |
| `defineAgentDriverProviderAdapterV1` | HIGH | 3 direct / 12 total; 2 process groups (`serve`, Codex acceptance) |

Neither existing symbol was edited. The new candidate consumes the shared bridge and preserves the
raw Claude driver.

## Required integration work not made in this lane

1. Obtain provider/policy authority for managed personal-subscription automation; do not infer it
   from login or source tests.
2. Reconcile the canonical Claude manifest only through the reserved-manifest process after that
   policy changes and exact evidence exists.
3. Export the candidate and construct it in Agent OS with real Conductor-backed model, launch,
   effective-session, fork, approval, and usage callbacks.
4. Register the implementation without claiming support; keep production routing behind
   `requireSupported(...)` and never fall back to legacy, API billing, or another provider.
5. Build a clean-profile Claude acceptance harness bound to the exact adapter, native CLI,
   platform, source commit, executable/configuration/environment fingerprints, billing identity,
   and eight common gate IDs.
6. Record a real acceptance matrix only after all eight gates pass, then re-run production,
   restart, cancellation, concurrent raw-terminal, failure, and credential-redaction acceptance.
7. Complete the corresponding exact evidence for Codex, Qwen, and Kimi before closing BASE-010.
8. Integrator/parent should add the required end-of-session Vault daily log; this lane did not edit
   Vault because its ownership was explicitly limited to the three repository files.

## Claims deliberately not made

- Claude is supported, validated, policy-allowed, production-routed, or plug-and-play.
- Claude login alone proves personal-subscription billing or zero-overage behavior.
- A real Claude launch, follow-up, approval, usage window, cancellation, fork, restart, or raw
  terminal coexistence gate passed.
- Codex is validated or has a real all-pass acceptance matrix.
- TOOL-014 or BASE-010 is delivered.
- Provider support labels, backlog counts, or public-release readiness changed.

## Resume point

Review and integrate the isolated commit only as an unregistered candidate. Preserve all canonical
support states and counts. The next provider action is policy/evidence work, not bypassing the
gateway to obtain a synthetic live session.
