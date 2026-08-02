# Remote and mobile threat model

Status: REM-001 candidate

Observed code: `fefec4c70810f1b5fd196835f0696fc2deaba8fe`

Machine-readable companion: `docs/remote-mobile-threat-control-matrix.json`

## TLDR

Remote access is a functional beta, not a safe remote beta. The current daemon is loopback-first, refuses an unauthenticated tunnel, uses a high-entropy token, prefers Tailscale, separates managed-agent and operator credentials, validates several high-risk actions, and withholds raw approval parameters from durable managed events.

The critical gap is the browser trust model. `orchestra remote` puts the reusable master operator bearer in the QR fragment. The web app moves that bearer into `localStorage`, SSE puts it in a query string, and the server maps it to a broad `operator` principal. A photographed QR, lost phone, injected browser script, extension, or leaked stream URL can therefore become terminal input, approval, agent-control, and administration authority. There is no named device, per-device expiry or revocation, scope boundary, high-risk step-up, or device-attributed audit.

The safe target is:

1. A one-time `PairingTicket`, never the master bearer in a QR.
2. A named, expiring, revocable, key-bound `DeviceSession`.
3. Default phone scopes of `observe`, `message`, and `approve`.
4. Default-deny route/resource/field/data classification for every read, including raw PTY output, transcripts, context, exports, and new GET routes.
5. A no-tool default message/Q&A path so low-scope text cannot launder instructions through a tool-capable agent.
6. Explicit opt-in scopes for `agent-control`, `terminal-write`, and `admin`.
7. User-verifying, action- and resource-bound step-up for terminal writes, destructive controls, administration, and risky approval allows.
8. Device attribution for every remote mutation without storing raw PTY input, raw approval parameters, secrets, or withheld reasoning.
9. Explicit offline read-only behavior, safe cache purge, private-tunnel default, anti-framing controls, and a tested lost-device response.

This document is a threat-model deliverable only. It does not implement the controls and does not satisfy `REM-GATE`.

## Scope and evidence rule

This model covers the existing remote command, daemon authentication, web credential handling, global event stream, canonical and compatibility mutation surfaces, PTY controls, provider approvals, durable event projection, PWA service worker, push notifications, and tunnel lifecycle.

Claims about current behavior are tied to exact source markers in the machine-readable matrix and enforced by `test/remote-mobile-threat-model.test.ts`. A current marker changing causes the documentation test to fail so the model must be reviewed rather than silently becoming historical fiction.

The model deliberately distinguishes:

- `implemented`: observed in current code.
- `partial`: useful current behavior that does not meet the remote target.
- `target`: required future behavior, not an implementation claim.
- `release gate`: evidence needed before the product may be called a safe remote beta.

No production authentication, migration, database, route, service-worker, push, Vault, Graphify, or backlog state is changed by REM-001.

## Observed system

### Remote startup and pairing

1. The normal daemon binds `127.0.0.1`; direct `--expose` rejects auth-disabled mode.
2. `orchestra remote` also rejects auth-disabled mode and ensures the loopback daemon is reachable.
3. If Tailscale exists, `tailscale serve` is preferred.
4. Otherwise, if Cloudflare Tunnel exists, a public random quick tunnel starts automatically.
5. Tunnel state is written owner-only. Tailscale reuse checks binary presence, while Cloudflare reuse and stop trust PID liveness; a recycled PID is not ownership proof.
6. The pairing URL is `public-origin/#token=<master operator token>`.
7. The browser reads the fragment, writes the value to `localStorage`, and removes the fragment.
8. Normal fetches use an `Authorization: Bearer` header.
9. The global `EventSource` URL uses `?token=<master operator token>`.
10. The daemon accepts the bearer or `query.token` for every `/api/` route and maps the master value to `operator`.

The fragment is not sent to the server on the first HTTP request. That is a useful but narrow property: it does not make the QR one-time, prevent a photo or screenshot, prevent browser persistence, or protect the same value once it is used in an SSE query string.

### Privileged control

The current authorization model has two principals:

- `operator`: the master token and broad human authority.
- `agent`: the separate managed-agent token and a narrower set of allowed routes.

Many high-risk compatibility and PTY routes call `requireOperator`, including agent launch/control, permissions, provider approvals, access profile changes, process spawn, PTY input, resize, restart, and signals. That separation is valuable. It is not a remote device model: every browser with the master token is the same operator, while canonical, legacy, and infrastructure mutations rely on individual route authors choosing the right local check.

The web terminal sends batched keyboard data directly to the PTY input API and sends resizes automatically. PTY input is bounded to 1 MiB, process and state checks apply, and signal names are constrained. Process-input audit retains `source` and byte count, not raw keystrokes. It cannot identify which remote device caused an action.

### Approvals

Provider approval endpoints accept the closed decisions `allow`, `allow_session`, `deny`, and `cancel`; answer arrays are bounded. The Codex driver only resolves a live pending request. The durable native-event path records a synthesized approval outcome, rejects an outcome without a matching durable request, and marks raw native payload state as withheld.

Those are strong integrity and minimization controls. The remote gap is authorization and attribution:

- every master-token browser can answer high-risk approvals;
- `allow_session` is available without user-verifying step-up;
- the live UI necessarily receives enough detail to answer the request;
- the durable winning actor is generic `operator` with a null actor id;
- there is no device, scope, request-digest, or step-up-grant attribution.

Safe remote approval must preserve the current redaction and durability properties. Device attribution must never be added by copying raw approval parameters into managed `os_events`.

### Messages and confused-deputy risk

The current message route validates a closed kind vocabulary, recipient state, replies, and swarm confirmation. For a live hired agent, however, `ask`, `reply`, and `task` content is formatted as prompt text and pushed straight into the agent's active conversation. That agent can already have terminal, workspace, network, or provider tools.

This means `message` is not inherently low-risk. A compromised phone with only the planned default message scope could write “please run this command” as an ask or reply and attempt to use the agent as a confused deputy. Text filtering cannot reliably distinguish a question from a disguised instruction.

The target default message scope therefore terminates in a no-tool discussion/Q&A path. Remote provenance is explicit and untrusted. Promoting a discussion into tool-capable work is a separate `agent-control` decision with its own policy, step-up where required, and device-attributed audit. A remote message must never inherit the recipient agent's authority merely because the agent can read it.

### Sensitive reads

The baseline inventory has 68 GET routes: 51 canonical, 3 compatibility, 9 legacy, and 5 infrastructure. They are not all equivalent. Health and the static shell are public bootstrap surfaces; process output, transcripts, conversations, assignment history, context, search/export, contract-template previews, Open Work, outcome dashboards and benchmark comparisons, live approval detail, settings, and system/provider information can reveal source, prompts, commands, paths, usage, or credentials.

Some handlers bound pagination, validate object existence, or require the generic operator. There is no DeviceSession policy that classifies each read by scope, board/workspace/agent/process resource, field allowlist, data sensitivity, cache behavior, and reauthentication need. A default `observe` scope that only denies mutations would still enable raw-output exposure, cross-resource identifier attacks, and newly added GET routes.

The target request policy is default-deny for every method. Ordinary observe returns only explicitly allowlisted, server-redacted fields for granted resources. Raw PTY output, raw transcripts, context, exports, settings/system detail, secrets, raw approval parameters, and withheld reasoning are unavailable remotely by default or require a separately approved, purpose-bound view. A new GET route is denied until it has a read classification and abuse test.

### Offline and push

The current service worker only handles same-origin `GET`, excludes SSE, and does not queue non-GET requests. Therefore offline mutations fail rather than replay today; that invariant must remain explicit.

The worker caches successful authenticated API GET responses in one shared API cache and returns cached responses when the network fails. A lost or revoked device can retain transcripts or process output, and the UI has no explicit stale, revoked, or offline-read-only state. The cache is not partitioned by device session and is not purged by logout, token replacement, tunnel stop, or revocation.

Push delivery has per-item cooldown and a global cap. Current server-generated links are relative. However:

- subscriptions are global, not associated with a device;
- agent-authenticated infrastructure mutation routes are not uniformly operator-gated;
- notification title and body can expose project information on a lock screen;
- the service worker trusts the payload URL when navigating or opening a window;
- lost-device revocation cannot remove a specific device subscription.

## Assets

| ID | Asset | Sensitivity |
| --- | --- | --- |
| AST-001 | Master operator bearer | Critical |
| AST-002 | Managed-agent bearer | High |
| AST-003 | PTY processes, input, output, and signals | Critical |
| AST-004 | Source trees, worktrees, environment, and developer credentials reachable from a terminal | Critical |
| AST-005 | Approval and permission requests and outcomes | Critical |
| AST-006 | Conversations, transcripts, context, evidence, and process output | High |
| AST-007 | Agent, job, delivery, workspace, and settings control plane | High |
| AST-008 | Device identity, scopes, credentials, and revocation state | Critical |
| AST-009 | Audit attribution and forensic history | High |
| AST-010 | Tunnel state, public origin, and service availability | High |
| AST-011 | Push subscriptions and lock-screen content | High |
| AST-012 | Browser storage and service-worker caches | High |

## Actors

| ID | Actor | Trust assumption |
| --- | --- | --- |
| ACT-001 | Local owner/operator | Trusted local recovery authority |
| ACT-002 | Authorized remote device user | Trusted only within explicit device grants |
| ACT-003 | Managed agent process | Limited, never equivalent to owner |
| ACT-004 | Unauthenticated attacker or tunnel scanner | Untrusted |
| ACT-005 | Lost-device holder | Untrusted |
| ACT-006 | Malicious page, extension, injected script, or same-device malware | Untrusted |
| ACT-007 | Tunnel, proxy, log, analytics, or referrer observer | External |
| ACT-008 | Push provider or lock-screen observer | External |
| ACT-009 | Compromised or confused authorized device | Authenticated but adversarial |

## Trust boundaries

| ID | Boundary | Security question |
| --- | --- | --- |
| TB-001 | QR display to camera | Is the pairing artifact one-time, short-lived, and bound to the intended origin? |
| TB-002 | Browser runtime to persistent storage/cache | Can script-readable or offline state become reusable authority or retained sensitive data? |
| TB-003 | Tailnet/public tunnel to loopback daemon | Is the endpoint intended, private by default, healthy, owned, and abuse-resistant? |
| TB-004 | HTTP/SSE request to principal | Does credential validation produce a named, expiring, scoped device identity? |
| TB-005 | Principal to route handler | Is every mutation default-denied until scope, step-up, and audit policy are explicit? |
| TB-006 | Browser terminal to host PTY | Is host control intentional, recent, resource-bound, and attributable? |
| TB-007 | Provider approval to driver and durable event | Is the exact request safely summarized, authorized, answered once, and recorded without raw secrets? |
| TB-008 | Daemon through push provider to notification click | Is content minimal, subscription device-bound, and navigation same-origin and allowlisted? |
| TB-009 | Online response to offline view | Is stale state obvious, read-only, partitioned, and removable? |
| TB-010 | Owner revocation to credential, stream, cache, and push shutdown | Does one lost device stop without breaking other devices or local recovery? |
| TB-011 | Remote message to tool-capable agent session | Can untrusted text become a privileged tool instruction or change work outside the device's scope? |

## Required threat topics

| ID | Required topic | Covered threats |
| --- | --- | --- |
| TOP-001 | Tunnel discovery | REM-T01, REM-T14, REM-T18 |
| TOP-002 | Token theft | REM-T02, REM-T03, REM-T04, REM-T05, REM-T15 |
| TOP-003 | CSRF, Origin, Host, and UI redress | REM-T06, REM-T19, REM-T22 |
| TOP-004 | Terminal-control escalation | REM-T07, REM-T09 |
| TOP-005 | Offline mutation and stale state | REM-T11, REM-T12, REM-T16 |
| TOP-006 | Lost device and revocation | REM-T05, REM-T13, REM-T16 |
| TOP-007 | Approvals | REM-T08, REM-T17 |
| TOP-008 | Audit attribution | REM-T10, REM-T19 |
| TOP-009 | Message confused deputy | REM-T20 |
| TOP-010 | Read authorization and data minimization | REM-T11, REM-T16, REM-T21 |

## Current controls

These controls reduce risk today but do not collectively make the current QR flow safe for general remote use.

| ID | Status | Observed control | Important limit |
| --- | --- | --- | --- |
| CUR-001 | Implemented | Remote refuses auth-disabled mode | Authentication is a shared master bearer |
| CUR-002 | Partial | Tailscale preferred; TLS Cloudflare fallback | Public fallback is automatic |
| CUR-003 | Implemented | 256-bit token, owner-only file, timing-safe compare | Stable bearer has no device expiry or selective revoke |
| CUR-004 | Partial | Fragment import and immediate fragment removal | Master bearer moves into `localStorage` |
| CUR-005 | Partial | Bearer/query authentication | Query token is accepted broadly; master maps to operator |
| CUR-006 | Partial | Operator/agent separation and explicit high-risk gates | No per-device scopes or exhaustive policy |
| CUR-007 | Implemented | PTY bounds and signal/process validation | Valid operator requests still control the host |
| CUR-008 | Implemented | Worker only intercepts same-origin GET and excludes SSE | Authenticated GET responses are cached |
| CUR-009 | Implemented | Closed approval decisions, bounded answers, live pending request | Broad operator can make risky decisions |
| CUR-010 | Implemented | Durable, matched, redacted Codex approval outcomes | Actor is not a named device |
| CUR-011 | Partial | PTY audit records source and byte count, not raw input | No device, scope, or step-up attribution |
| CUR-012 | Partial | Push rate cap and relative generated links | Subscription and click handling are not device-safe |
| CUR-013 | Partial | Owner-only tunnel state and provider stop | Stop does not revoke the copied master bearer |
| CUR-014 | Implemented | Loopback default and authenticated direct expose | Tunnel still makes the daemon remotely reachable |
| CUR-015 | Partial | Managed agents receive a separate token | Route-local checks are not a device policy |
| CUR-016 | Partial | Network-first API availability cache | Shared sensitive offline cache has no revoke purge |
| CUR-017 | Partial | Closed message kinds and recipient checks | Ask/reply/task-like text is pushed directly into a live tool-capable agent |
| CUR-018 | Partial | Some reads check object existence, paginate, or require operator | No exhaustive device read, resource, field, or data-class policy |

## Threat register

| ID | Risk | Threat | Current defenses | Explicit gap | Target controls | Abuse evidence |
| --- | --- | --- | --- | --- | --- | --- |
| REM-T01 | Medium | Tunnel discovery and daemon fingerprinting | CUR-001, CUR-002, CUR-014 | Public origin can be scanned; no origin binding or abuse signal | TGT-007, TGT-008, TGT-009 | AC-05, AC-12 |
| REM-T02 | Critical | Master-token QR observation and replay | CUR-003, CUR-004, CUR-005 | QR is the stable master operator bearer | TGT-001, TGT-002, TGT-003 | AC-01, AC-13 |
| REM-T03 | Critical | Browser credential extraction | CUR-003, CUR-004 | `localStorage` makes reusable authority script-readable | TGT-002, TGT-003, TGT-007, TGT-011 | AC-02, AC-04 |
| REM-T04 | Critical | Query-token disclosure through SSE URLs | CUR-005, CUR-008 | Master token appears in a URL and query auth is API-wide | TGT-001, TGT-003, TGT-008, TGT-014 | AC-03 |
| REM-T05 | Critical | Lost device with a non-expiring global bearer | CUR-003, CUR-013 | No device inventory, expiry, rotation, or selective revoke | TGT-002, TGT-003, TGT-011 | AC-04, AC-13 |
| REM-T06 | High | Untrusted Host, Origin, or cross-site context | CUR-005, CUR-014 | No explicit Host/Origin/Fetch Metadata policy | TGT-007, TGT-009, TGT-014 | AC-05 |
| REM-T07 | Critical | Stolen credential becomes terminal control | CUR-006, CUR-007, CUR-011 | No terminal scope or user-verifying step-up | TGT-004, TGT-005, TGT-006 | AC-06, AC-14 |
| REM-T08 | Critical | Approval hijack or over-broad allow-session | CUR-006, CUR-009, CUR-010 | No risk/digest/device-bound step-up | TGT-004, TGT-005, TGT-006, TGT-012 | AC-07, AC-14, AC-15 |
| REM-T09 | Critical | Agent-control or administration escalation | CUR-006, CUR-015 | Phone bearer has broad operator authority | TGT-004, TGT-005, TGT-006, TGT-015 | AC-08, AC-16 |
| REM-T10 | High | Generic operator audit attribution | CUR-010, CUR-011 | Durable actions do not identify the remote device | TGT-002, TGT-006, TGT-012 | AC-15 |
| REM-T11 | High | Sensitive GET responses remain available offline | CUR-008, CUR-016 | Shared cache serves stale authenticated data | TGT-010, TGT-011 | AC-09 |
| REM-T12 | Medium | Future offline mutation queue replays authority | CUR-008 | No-queue is current behavior, not yet a release invariant | TGT-005, TGT-010, TGT-016 | AC-10, AC-14 |
| REM-T13 | High | Push subscription, deep-link, or lock-screen disclosure | CUR-012, CUR-015 | Not device-bound; payload navigation is not allowlisted | TGT-004, TGT-011, TGT-013 | AC-11, AC-17 |
| REM-T14 | High | Unconfirmed public fallback or stale tunnel reuse | CUR-002, CUR-013 | Automatic public fallback; weak reuse validation can signal a recycled unrelated PID | TGT-008, TGT-009, TGT-015 | AC-12 |
| REM-T15 | Medium | Authentication and stream abuse without limits | CUR-003, CUR-005 | Entropy prevents guessing but not resource abuse or alert gaps | TGT-008, TGT-014, TGT-015 | AC-03, AC-12 |
| REM-T16 | High | Revocation does not purge browser caches | CUR-013, CUR-016 | No session partition or purge trigger | TGT-010, TGT-011, TGT-013 | AC-04, AC-09, AC-13 |
| REM-T17 | High | Live approval detail visible to every operator client | CUR-009, CUR-010 | Durable redaction does not scope the live channel | TGT-004, TGT-005, TGT-012, TGT-014 | AC-07, AC-15 |
| REM-T18 | Low | Open health/static fingerprinting | CUR-001, CUR-014 | Product presence and version remain visible | TGT-007, TGT-008, TGT-009 | AC-12 |
| REM-T19 | Critical | New or overlooked mutation misses route-local auth | CUR-006, CUR-015 | No centralized default-deny device policy | TGT-004, TGT-006, TGT-007, TGT-016 | AC-08, AC-16 |
| REM-T20 | Critical | Default message scope launders privileged instructions through an agent | CUR-006, CUR-017 | Ask/reply/task-like text enters a live tool-capable session | TGT-004, TGT-005, TGT-006, TGT-018 | AC-18 |
| REM-T21 | Critical | Broad observe scope exposes raw or cross-resource reads | CUR-005, CUR-006, CUR-016, CUR-018 | No exhaustive route/resource/field/data-class read policy | TGT-004, TGT-010, TGT-016, TGT-017 | AC-09, AC-19 |
| REM-T22 | High | Framed paired UI enables clickjacking | CUR-004, CUR-005, CUR-014 | No explicit anti-framing policy protects authenticated controls | TGT-005, TGT-007, TGT-016 | AC-20 |

### Token-theft chain

The current worst-case chain is short:

```text
QR photo / localStorage read / SSE URL capture
  -> reusable master bearer
  -> operator principal
  -> PTY + approvals + agent control + administration
  -> source, credential, or delivery compromise
```

High token entropy prevents guessing; it does not reduce the authority of a copied bearer. Sender constraint is useful only after the master bearer leaves the browser design entirely. The target chain is:

```text
single-use PairingTicket
  -> named DeviceSession + non-exportable device key
  -> short-lived rotating credential
  -> narrow default scopes
  -> action/resource/request-bound step-up
  -> device-attributed mutation
```

### CSRF, Origin, and Host nuance

The current client normally sends a bearer header and the server does not advertise permissive cross-origin behavior. That materially limits classic form-based CSRF. This model does not claim every current mutation is trivially exploitable through CSRF.

The remaining gap is defense-in-depth and future device auth:

- the daemon does not explicitly validate `Host` or trusted forwarded-host data;
- state-changing requests do not enforce an `Origin` allowlist;
- Fetch Metadata context is not checked;
- query tokens are accepted beyond the one SSE use case;
- the public origin is not pinned to verified tunnel state;
- future cookie or browser-bound auth would change CSRF assumptions.

Target policy rejects unexpected host, origin, and cross-site mutation context before credential evaluation. It must account for explicitly configured proxies and must not blindly trust forwarded headers from arbitrary clients.

UI redress is a separate browser boundary. The current app has no explicit `frame-ancestors` or equivalent anti-framing control. A malicious parent page may attempt to frame the paired origin and disguise terminal, approval, pause, stop, or administrative controls; whether the frame sees prior storage varies by browser privacy behavior and is not an application guarantee. Target responses use CSP `frame-ancestors 'none'` plus a compatible anti-framing fallback, and browser acceptance verifies the denial. High-risk actions still require clear native user verification so anti-framing is not the sole defense.

### Terminal and approval step-up

A step-up grant is not a second global token. It must be:

- issued only after user verification on a named device;
- short-lived;
- bound to `device_session_id`;
- bound to action family and exact resource;
- bound to a nonce and, for approvals, the redacted request digest;
- invalid after credential rotation, revocation, request completion, or relevant state change;
- single-use where the action can be represented as one request;
- recorded by identifier and result, never by copying secret material.

For approvals, the `approve` scope can permit safe review and `deny`/`cancel` of the exact pending request. `allow`, `allow_session`, command execution, file changes, permissions, MCP elicitation, and acceptance overrides need risk classification and fresh step-up. The UI must display what is being approved while preserving the existing rule that raw provider parameters and withheld reasoning do not enter durable managed events.

## Target controls

| ID | Target control | Primary backlog |
| --- | --- | --- |
| TGT-001 | Single-use, short-lived, origin-bound PairingTicket | REM-002, REM-003 |
| TGT-002 | Named DeviceSession inventory and lifecycle | REM-003, REM-008, REM-018, REM-GATE |
| TGT-003 | Short-lived rotating per-device, key-bound credential; no master in browser storage | REM-002, REM-003, REM-004 |
| TGT-004 | Central default-deny scope policy across every route family | REM-005, REM-006, REM-020 |
| TGT-005 | Action/resource/digest-bound user-verifying step-up | REM-007, REM-020 |
| TGT-006 | Device-, user-, scope-, and grant-attributed mutation audit | REM-009 |
| TGT-007 | Host, proxy, Origin, Fetch Metadata, anti-framing CSP, and security-header policy | REM-010, OPS-022 |
| TGT-008 | Pair/auth/stream/approval/PTY/admin rate limits and privacy-safe alerts | REM-010, REM-018, OPS-012 |
| TGT-009 | Private default, public confirmation, tunnel ownership/health/origin verification | REM-011 |
| TGT-010 | Explicit offline read-only mode, no mutation queue, safe cache policy | REM-015, REM-016, REM-017 |
| TGT-011 | Atomic lost-device revoke across credentials, streams, grants, cache, and push | REM-004, REM-008, REM-018, REM-GATE |
| TGT-012 | Redacted risk-aware, request-digest-bound approval workflow | REM-007, REM-009, QA-012 |
| TGT-013 | Device-bound push, minimal preview, safe deep links | REM-008, REM-012, REM-013, REM-014, REM-018 |
| TGT-014 | Header/proof-bound APIs and one-purpose stream credentials | REM-004, REM-010 |
| TGT-015 | Independent flags, privacy-safe telemetry, and remote kill switch | BASE-007, REM-018 |
| TGT-016 | Cross-platform abuse and acceptance release gate | REM-017, REM-018, REM-019, REM-020, REM-GATE, QA-012, QA-013 |
| TGT-017 | Default-deny route/resource/field/data-class read policy | REM-005, REM-006, REM-020, OPS-009, OPS-011 |
| TGT-018 | Untrusted message provenance and no-tool default Q&A path | REM-005, REM-006, OPS-011, QA-011 |

## Target device scopes

The authorization layer must default-deny every `DeviceSession` request, not only mutations. A newly added route of any method remains unavailable until it has explicit scope, resource, field, data-class, cache, step-up, audit, and abuse classification. Compatibility, legacy, canonical, and infrastructure routes all pass through the same decision point.

The observed baseline has 68 GET routes—51 canonical, 3 compatibility, 9 legacy, and 5 infrastructure—and 119 non-GET routes—73 canonical, 26 compatibility, 16 legacy, and 4 infrastructure. These are drift tripwires, not grant lists. Any surface-count change forces the model and future centralized policy to be reviewed.

| Scope | Default phone | Intended access | Always excluded or elevated |
| --- | --- | --- | --- |
| `observe` | Yes | Explicitly allowlisted, resource-bound, field-minimized, redacted board, agent, delivery, conversation, process-status, and event-stream views | Unclassified GETs, cross-resource identifiers, raw PTY output/transcripts/context/exports/system detail, secrets, raw approvals, mutations, shared sensitive cache |
| `message` | Yes | Bounded `ask`, `reply`, and `notify` in a no-tool discussion/Q&A path with device attribution | Direct live-agent prompt injection, instruction laundering, task assignment, launch, swarm control, policy change, terminal input |
| `approve` | Yes | Redacted review; exact-request deny/cancel; policy-classified low-risk allow | Risky allow, `allow_session`, command/file/permission/MCP/acceptance override without step-up |
| `agent-control` | No | Explicit pause/stop; risk-controlled start/resume/retry/interrupt/model/effort/access changes | Workspace/provider/plugin/MCP/policy/device admin without `admin` |
| `terminal-write` | No | Explicit selected-process input, resize, spawn, restart, and signals | Offline/background input, wildcard process access, expired or mismatched grants |
| `admin` | No | Device, tunnel, access, provider, plugin, MCP, retention, policy, and settings management | Never inherited from any other scope; mutation always requires step-up |

The names are human-facing capability groups, not permission shortcuts. The policy engine may use more granular internal actions, but it must preserve these comprehensible boundaries.

### Read and data policy

Every device read is classified before its handler executes:

| Data class | Examples | Target rule |
| --- | --- | --- |
| Public bootstrap | Health and static shell | Explicit minimal allowlist, no project state, abuse controls, anti-framing headers |
| Redacted observe | Allowlisted board summary, agent/delivery status, redacted conversation, process status | `observe` plus exact resource grant, server-side field allowlist/redaction, bounded pagination, no shared sensitive cache |
| Sensitive content | Raw process output/transcript, context, search/export, live approval detail, settings/system detail | Unavailable remotely by default; separately approved purpose, stricter minimization, exact object authorization, reauthentication where warranted, no offline cache |
| Secret or withheld | Credentials, raw environment, raw approval parameters, withheld reasoning | Never returned to a remote DeviceSession |

The outcome-analytics surface is classified explicitly rather than inheriting authority from its
HTTP methods. Both dashboard GET routes are `sensitive_content` and default-deny for a
`DeviceSession`; a future remote view would require `observe` plus an explicit board grant, exact
`boardId` object authorization, a minimized response allowlist, and no authenticated-device cache.
All nine outcome POST routes require the production operator predicate before request-body parsing
or service execution. Their future device policy remains default-deny with `admin` scope and
user-verifying step-up. This includes budget evaluation as well as evidence ingestion, budgets,
digests, operation planning, confirmation, and consumption; a route being computational does not
make it a read.

Object authorization is not satisfied by knowing an id. Board, workspace, agent, session, conversation, process, approval, delivery, and export identifiers must belong to the device's explicit resource grant. Parent/child relationships are checked server-side at the service boundary. Field filtering happens before serialization, streaming, caching, push, or audit.

### Message-to-agent policy

Device-authored content carries immutable remote provenance. Default `message` may create discussion/Q&A content or communicate with a no-tool responder. It may not be inserted into a live tool-capable agent prompt, regardless of whether the user labels it `ask`, `reply`, or `notify`.

Turning a discussion into execution is an explicit command:

1. the user selects the target agent/job/workspace and proposed objective;
2. the policy engine evaluates `agent-control`, existing agent capability, resource grant, and risk;
3. step-up applies when the promoted objective can change code, run commands, expose sensitive data, or expand access;
4. the runtime creates an attributed command/job boundary rather than concatenating untrusted text into an ambient prompt;
5. the audit links the originating discussion and device without granting the discussion itself authority.

This is a structural boundary. Keyword filtering or a prompt that merely says “treat this as untrusted” is not sufficient.

## Target pairing and session lifecycle

### Pairing

1. The local owner requests a pairing QR.
2. The daemon mints a high-entropy `PairingTicket` with a short expiry, expected public origin, one redemption, and requested default scopes.
3. The QR contains the public origin and pairing ticket, never AST-001.
4. The device generates a non-exportable key where supported and redeems the ticket over the expected origin.
5. The owner sees and names the new device.
6. The server records a pending or active `DeviceSession`, hashed/rotating credential material, public-key binding, scopes, creation source, expiry, and last-seen.
7. The ticket is atomically consumed before a credential is returned.
8. A second redemption, wrong origin, expired ticket, changed tunnel, or replay fails closed.

The local master token remains a loopback recovery mechanism. It is not returned by pairing, not accepted as a device credential, and not stored by the PWA.

### Active session

A session has explicit states such as `pending`, `active`, `expired`, `revoked`, and `compromised`. Authorization evaluates:

- credential validity and key proof;
- device state and expiry;
- requested route action;
- granted scope;
- resource constraints;
- step-up policy and grant;
- trusted origin and tunnel context;
- abuse/rate-limit state.

All checks precede the route mutation. Audit outcome is recorded whether the action is allowed or denied, using bounded and redacted metadata.

### Lost device

A single revoke operation must:

1. mark the DeviceSession revoked;
2. invalidate access, refresh, stream, pairing, and step-up artifacts;
3. close active streams;
4. remove the matching push subscription;
5. reject proof from the device key;
6. arrange authenticated cache purge at next contact and refuse stale content;
7. retain bounded audit records;
8. leave other devices and local loopback recovery working.

Global emergency revoke remains available, but it is not the normal lost-device workflow.

Revocation cannot remotely erase a phone that is offline and unreachable. The design must not imply otherwise. Sensitive API data therefore stays out of the offline cache by default. If a narrowly defined offline-safe view is later supported, it needs a short local lease, device/user-verification lock, session partitioning, an obvious stale/read-only state, and purge at next contact. Server-side revoke immediately blocks server resources; local deletion is only observable when the device reconnects or its local lease expires.

## Audit attribution

Every remote mutation needs a durable attribution envelope:

- authenticated user or local owner identity;
- `device_session_id`;
- scope and internal action;
- step-up grant id and verification method when required;
- route family and normalized resource identifiers;
- request correlation/idempotency identity;
- tunnel mode and verified origin class;
- allow/deny/result and bounded reason;
- timestamp and server-side sequence.

The envelope must exclude:

- access, refresh, pairing, stream, or step-up secrets;
- raw PTY keystrokes or commands;
- raw provider approval parameters;
- raw environment values or developer credentials;
- withheld provider reasoning;
- unbounded request bodies.

For PTY input, source, device, process, byte count, grant id, and result are sufficient. For approvals, request id/digest, approval kind, redacted risk class, decision, finality, device, and grant id are sufficient. Existing redacted projection and unmatched-outcome failure behavior remain mandatory.

## Verification abuse cases

These are executable acceptance targets, not prose-only examples.

| ID | Abuse case | Current expected behavior | Target expected behavior |
| --- | --- | --- | --- |
| AC-01 | Photograph and replay the QR | Reusable master bearer authenticates until global rotation | Only first correct-origin redemption creates a named device |
| AC-02 | Read `localStorage` and replay elsewhere | Extracted master bearer authenticates as operator | No master in storage; device credential is scoped, expiring, revocable, and key-bound |
| AC-03 | Capture an SSE URL and replay its query value | Query bearer works broadly; stream creation lacks specific limits | One-purpose stream credential fails on other routes and is bounded/rate-limited |
| AC-04 | Lose a paired phone that may already be offline, revoke it, and reconnect later | No selective revoke; token/cache persist | Server access ends selectively; sensitive data was not cached by default; local purge occurs at next contact without claiming remote erase |
| AC-05 | Send unexpected Host/Origin/Fetch Metadata context | Bearer still applies; no explicit contextual rejection | Rejected before auth/handler with privacy-safe signal |
| AC-06 | Use observe/message/approve to write a PTY | Master browser can; managed agent is gated | Missing terminal scope or matching step-up always denies |
| AC-07 | Allow/allow-session a risky or altered approval | Master bearer can answer live request | Exact digest and fresh risk-bound step-up required; deny/cancel remains safe |
| AC-08 | Use agent or low-scope device on privileged route families | Explicit gates cover some paths; no exhaustive device layer | Central policy rejects every unclassified or under-scoped mutation |
| AC-09 | Read cached transcript while offline before and after device revoke | Shared API cache may return stale content | Sensitive content absent by default; any offline-safe view expires locally and purges at next contact |
| AC-10 | Attempt mutations offline and reconnect | Worker currently does not queue non-GET | No mutation replay; intentional retry required |
| AC-11 | Put external or non-allowlisted URL in push payload | Worker navigates/openWindow using payload value | Only normalized same-origin allowlisted paths open |
| AC-12 | Force public fallback, recycled PID/stale state, scan, and flood | Fallback automatic; reuse/stop trust PID liveness; no auth-failure cap | Consent, ownership/health check before reuse/stop, bounded open surface, rate limit |
| AC-13 | Revoke device A while device B remains active | Global replacement is the only practical revoke | A fails everywhere; B remains valid; old artifacts never become master |
| AC-14 | Replay step-up across device/action/resource/digest/expiry | No step-up primitive | Every mismatch or replay fails and is attributed |
| AC-15 | Race two devices on one approval and inspect storage | One live request wins, raw durable parameters withheld, actor generic | Exactly one digest-bound decision; device attribution without raw payload |
| AC-16 | Add a new mutation without device policy | Handler author must remember local checks | Route stays denied and release test fails until classified |
| AC-17 | Expose project detail on lock screen | Title/body may reveal card, agent, or message context | Generic default preview; reveal is explicit per device |
| AC-18 | Use message-only access to tell a live agent to run tools or change work | Ask/reply/task-like text is pushed into the tool-capable session | Default message ends in no-tool Q&A; promotion requires agent-control policy, step-up where applicable, and audit |
| AC-19 | Use observe on raw/cross-resource/new GET routes | Master bearer reads broadly; handler checks are inconsistent | Every read is route/resource/field/data-class classified and default-denied until explicitly allowed |
| AC-20 | Frame the paired UI and induce privileged interaction | No explicit application anti-framing policy | Browser proves CSP `frame-ancestors 'none'`/fallback denial; step-up remains clear and user-verifying |

## Rollout order

Rollout is dependency-ordered so later convenience never creates authority before identity, policy, recovery, and evidence exist.

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| R0 | REM-001 evidence baseline | Threat model, matrix, and drift test; no production behavior change |
| R1 | Device-principal policy skeleton and telemetry in shadow mode | Default-deny decision point, Host/Origin observation, counters, and kill switches without widened access |
| R2 | PairingTicket and DeviceSession behind flags | Replay/origin/expiry tests; master remains local recovery only |
| R3 | Observe-only named-device beta | Private tunnel, exhaustive read/resource/data classification, IDOR/raw-output denial, revoke, stream, offline, and no-sensitive-cache tests |
| R4 | No-tool messaging and risk-bound approval | Confused-deputy barrier, device attribution, race, digest, replay, redaction, and step-up tests |
| R5 | Opt-in agent, terminal, and admin control | Scope editor plus resource-bound step-up, expiry, revoke, and audit evidence |
| R6 | Retire unsafe compatibility | No master QR; no broad query token; public fallback requires verified consent |
| R7 | Safe remote beta gate | Desktop, phone, iOS, Android, offline, accessibility, independent security, and rollback evidence |

## Rollback invariants

- RB-001: a remote kill switch stops tunnel access while the loopback CLI and local recovery remain available.
- RB-002: rollback never restores a master-token QR or treats a device credential as the master bearer.
- RB-003: disabling a rollout phase revokes its device credentials, pairing tickets, stream tickets, and step-up grants and closes streams.
- RB-004: device schema remains additive until downgrade and recovery drills pass; dormant rows grant no authority.
- RB-005: service-worker rollback changes cache version and purges authenticated device content.
- RB-006: rollback stops the public tunnel and only clears verified Orchestra-owned state.
- RB-007: revoking one device or capability does not revoke other explicitly valid devices.
- RB-008: audit remains append-only and attributed while secrets, raw PTY input, raw approval parameters, and withheld reasoning stay absent.

## Release gate

`REM-GATE` is not satisfied by this document. Before the product is described as a safe remote beta, plug-and-play, shippable, or production-ready for remote access, combined evidence must show:

- PairingTicket and named DeviceSession implementation;
- expiry, rotation, selective revoke, and sender constraint where supported;
- centralized default-deny read/mutation scopes, resource and data classification, and resource-bound step-up;
- a no-tool default message path that cannot launder device instructions through a tool-capable agent;
- device-attributed mutation and approval audit;
- Host/proxy/Origin/Fetch Metadata/anti-framing CSP/header/rate-limit/tunnel controls;
- explicit offline read-only semantics and cache purge;
- device-bound, privacy-preserving push and safe deep links;
- AC-01 through AC-20 automated abuse coverage;
- desktop and phone browser acceptance plus iOS and Android acceptance;
- independent regression/security review and a practiced rollback.

## Standards references

- STD-001: [RFC 6750 — OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/info/rfc6750). Any holder of a bearer token can use it, so storage, transport, replay, and logging are security boundaries.
- STD-002: [RFC 9700 — OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/info/rfc9700). The target removes access tokens from URI query parameters.
- STD-003: [RFC 9449 — Demonstrating Proof of Possession](https://www.rfc-editor.org/info/rfc9449). The target uses a DPoP-like sender-constraint property as a design reference, not as an implementation claim.
- STD-004: [Fetch Metadata Request Headers](https://www.w3.org/TR/fetch-metadata/). Fetch Metadata contributes to the target cross-site request policy; it does not replace Host, Origin, credential, and authorization checks.
- STD-005: [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/). Platform user verification is a reference for high-risk step-up where supported.

## Maintenance contract

The JSON matrix is the canonical structured register for REM-001. The Markdown is the human explanation. The documentation test checks:

- unique, valid, cross-referenced ids;
- every required topic has threats;
- every threat has assets, actors, boundaries, current controls, an explicit gap, target controls, and abuse cases;
- every evidence marker remains in current source;
- all structured ids appear in this document;
- both GET and non-GET route counts remain synchronized with the baseline inventory;
- every canonical outcome route has exactly one read or mutation classification, and no
  `DeviceSession` receives implicit outcome authority;
- every outcome mutation rejects a remote device principal before body validation, including
  budget evaluation;
- default-deny covers every device request, and the current direct message-to-live-agent flow remains explicitly modeled;
- the absence of an anti-framing policy remains a failing baseline marker until the control is implemented;
- DeviceSession and PairingTicket are still explicitly classified as unimplemented at this baseline;
- the current service-worker no-mutation-queue invariant remains visible;
- no release claim is implied by REM-001.

When one of the target controls is implemented, update the matrix status and evidence in the same change. Do not weaken the test merely to preserve old wording.
