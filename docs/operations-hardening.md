# Operations, diagnostics, and privacy hardening

Status: Beta Lane C integrated implementation contract. The central daemon wiring and gate
evidence are recorded in `docs/checkpoints/beta-lane-c-remote-ops.md`.

## TLDR

Orchestra now has reusable, fail-closed operations primitives for structured privacy-safe logs,
subsystem health, redacted diagnostics, bounded metrics/alerts, many-agent backpressure, request /
command / provider rate limiting, platform credential protection, and explicit failure behavior.
The lane integrator must wire these primitives at the central daemon, authorization, and route
boundaries; a public health response remains only `{ live, ready }`.

`createOperationsRuntime()` is the daemon-composition seam for that wiring. Instantiate it exactly
once after the database and daemon lease are acquired, then inject the same returned object into
the scheduler, handlers, diagnostics, and any local exporter. It intentionally does not register
routes or import the server.

## Ownership and integration boundary

| Concern | This module owns | Lane-root integration owns |
|---|---|---|
| Structured logging | Bounded logger, stable event/reason vocabulary, correlation/job/session/device IDs, final redaction | Supplying request correlation and server-derived job/session/device identity at every remote mutation |
| Health | Concurrent timeout-bound probes and aggregate readiness | Live probes for DB, lease, drivers, providers, PTY supervisor, hooks, and tunnels; central `/health` registration |
| Diagnostics | Explicit allowlist, double redaction, gzip artifact, owner-only exclusive write | Local-owner command/route, output directory choice, support workflow, retention/deletion |
| Metrics and alerts | Bounded-cardinality local registry and privacy-safe threshold engine | Scheduler/provider/recovery/projection observations and alert delivery |
| Capacity | Interactive reserve, bounded normal queue, background shedding, deterministic drain | Admission before scheduler/provider launch and durable retry/recovery coordination |
| Rate limits | Hashed partitions and bounded request/command/provider buckets | Auth/origin/device/account partition selection and rejection before mutation handlers |
| Credentials | Platform-store interface, opaque references, atomic rotation contract, no fallback | OS-specific keychain/secret-service implementation and DeviceSession persistence |

## Live runtime integration API

The shared `OperationsRuntime` retains one metrics registry, structured logger, alert engine,
capacity controller, and health service for the lifetime of the daemon. Constructing these per
request discards counters, deduplication, retained evidence, and admission state and is forbidden.

Root composition supplies live callbacks rather than placeholder booleans:

- registered/ready driver counts;
- configured/ready/degraded/unavailable provider counts;
- PTY supervisor responsiveness, reconciliation completion, and lost-process count;
- enabled/coherent hook state; and
- tunnel evidence from a recent end-to-end check that separately verifies reachability, expected
  origin, and authentication. A tunnel state file or live PID alone is not verification.

The database probe performs a transactional read, insert, verification, and deletion against the
real `kv` table. The lease probe requires the exact acquired owner ID and PID, a live process, and
a canonical heartbeat no older than the configured bound. The public integration calls
`runtime.publicReadiness()` and returns its exact `{ live, ready }` result; it never constructs a
readiness response independently. An internal clock failure or health-service failure returns
`ready: false`.

All scheduler/provider launch admission goes through `runtime.capacity.admit()`. The helper keeps
queue/active/rejection metrics synchronized and records stable structured decisions. Release,
queued cancellation, and priority drain use the same helper so its daemon-lifetime state cannot
diverge from exported metrics.

The integration must not place a secret in a correlation ID, label, reason code, filename, log
event, diagnostics configuration, or alert. A DeviceSession ID is an opaque database identifier,
never credential material.

## Log and diagnostics privacy contract

Operations events have no free-form message field. They contain a stable event name, outcome,
reason code, optional correlation/job/session/device identifiers, and structured attributes.
Before retention or sink delivery, the serializer:

1. redacts credential-shaped keys and text;
2. withholds commands/arguments, prompts/context/transcripts/reasoning, PTY input/output,
   approval parameters, environment, raw provider material, URLs, paths, worktrees, repository and
   branch values;
3. fails closed on cycles and excessive nesting; and
4. deep-clones and freezes retained, sink, return, and query copies so a consumer cannot rewrite
   nested audit evidence after redaction; and
5. bounds the in-memory ring so logging cannot consume unbounded memory.

Diagnostics are an allowlist, not a state archive. A bundle may include aggregate health,
bounded-cardinality metrics, already-redacted recent structured logs, version/revision, Node /
platform identity, uptime, and non-secret capacity settings. It cannot accept or include SQLite,
WAL/SHM, environment dumps, source/workspaces, transcripts, PTY output, raw approvals, provider raw
output, credentials, browser state, keychain output, or tunnel logs. The bundle applies the same
redaction again, compresses the JSON, and writes a generated filename with exclusive creation and
mode `0600`. Operators must still review the decoded bundle before sharing it.

## Credential-at-rest contract

`ProtectedCredentialVault` requires an injected platform secure store. The store must protect
credential bytes using an OS keychain, secret service, hardware-backed keystore, or equivalently
reviewed platform facility. Application records retain only an opaque `credential_ref`, facility,
identity and expiry. There is deliberately no plaintext file, browser-storage, log, analytics,
environment, or SQLite fallback.

The platform adapter must provide atomic `replace(current, next, secret)` semantics: rotation
either installs the replacement and removes the old entry as one operation, or leaves the old
entry unchanged. An unavailable store, missing reference, expired reference, partial rotation, or
foreign namespace fails closed. Revocation deletes one reference and does not affect unrelated
devices. Reference creation and expiry fields must be exact canonical UTC timestamps with a
coherent one-minute-to-one-year lifetime; malformed timestamps, an invalid trusted clock, future
creation, and rotation of an expired current reference are rejected before secure-store read or
replacement. The macOS Keychain adapter and migrations are integrated by the lane root;
unavailable, expired, foreign-namespace, partial-rotation and selective-revoke cases pass the
`OPS-010` tests.

## Health model

| Component | Required readiness question | Failure behavior |
|---|---|---|
| Database | Can the daemon perform a bounded read and required write transaction? | Required failure makes readiness unavailable |
| Daemon lease | Does this process still own a fresh lease? | Required failure makes readiness unavailable; never reconcile under uncertain ownership |
| Drivers | Are declared driver implementations registered and internally ready? | Required failure makes readiness unavailable |
| Providers | Is each enabled provider usable or explicitly in bounded backoff? | Required failure unavailable; partial fleet degradation is visible internally |
| PTY supervisor | Is the supervisor responsive and are persisted/live processes reconciled? | Required failure makes readiness unavailable |
| Hooks | Are installed hook manifests/state coherent for enabled providers? | Required failure makes readiness unavailable |
| Tunnels | Is enabled tunnel state owned, origin-matched and end-to-end reachable? | Optional when disabled; enabled failure degrades and remote policy fails closed |

All probes run concurrently with independent timeouts. Exceptions become stable `probe_failed` or
`probe_timeout` reason codes; raw exception messages never enter the snapshot. The authenticated
internal view may expose redacted component results. Public bootstrap returns only liveness and
readiness, without version, provider, tunnel, project, or credential fingerprinting.

## Metrics and alerts

The local registry defines these bounded metrics: queue depth, launch latency, active sessions,
provider errors, recovery outcomes, projection lag, rate-limit rejections, capacity rejections,
and dropped logs. Labels are limited to `provider`, `result`, `priority`, and `component`; device,
session, job, path, prompt, model input, and account labels are forbidden to prevent privacy leaks
and cardinality storms.

The alert engine covers:

- queued/running/cancelling jobs over the configured stuck threshold;
- repeated attempts over the retry threshold;
- supervisor-reported lost processes;
- event projection lag;
- aggregate token-rate storms; and
- repeated rate-limit rejections per privacy-hashed partition.

Alerts carry only opaque identifiers and reason codes. They are deduplicated by resource and
cooldown; downstream delivery must remain local by default. External alert delivery is opt-in,
must use a data-minimized template, and must never include diagnostic attributes, URLs, commands,
prompts, PTY data, approvals, credentials, or raw error text.

## Capacity and graceful degradation

Admission reserves explicit capacity for interactive work. Normal work starts below the ordinary
limit or enters a bounded queue. Background work is shed when the provider/global ordinary budget
is exhausted; it is never allowed to consume the interactive reserve. A full queue rejects with a
stable reason and retry delay. The controller stores only opaque request and provider IDs, not
work bodies. Draining is priority-ordered and respects global and per-provider limits. The rate
limiter rejects non-finite, negative, overflowing, or regressing trusted-clock values without
creating or resetting a bucket, preventing time corruption from becoming an authorization bypass.

The scheduler must persist an idempotent reservation before launch and correlate admission with
that durable command identity. Backpressure does not authorize duplicate jobs, change provider or
billing mode, broaden access, or silently discard accepted work. Rate limiting is an authorization
precondition, not a substitute for DeviceSession scope, origin, resource, step-up, or audit checks.

## Failure and recovery behavior

| Failure | Mutation behavior | Read behavior | Automatic recovery | Required evidence |
|---|---|---|---|---|
| Disk full / `SQLITE_FULL` | Fail closed; do not acknowledge persistence | Continue only already-safe reads where integrity is known | None until owner frees/verifies storage | Critical alert; integrity check before resume |
| Database locked/busy | Bounded retry, then explicit unavailable response | Best effort within the same deadline | At most 3 attempts / 2 seconds by default | Contention counter and final result |
| Provider unavailable/timeout | Bounded durable queue; never switch provider/billing silently | Local state remains readable | At most 5 retries / 60 seconds by default | Provider error and recovery outcome |
| Git/worktree conflict | Block the exact job; never auto-resolve or write shared checkout | Existing state remains readable | Human/independent resolution only | Conflict artifact linked to job/workspace |
| Unknown | Fail closed | Unavailable unless a safe read is independently proven | None | Critical alert and diagnostics reference |

Raw error messages are not used for classification or logs. Classification uses stable platform /
SQLite/provider/workspace codes. The recovery/outbox lane remains authoritative for transactional
reconciliation and duplicate prevention.

## Data ownership, local-only behavior, and external services

The user owns the local Orchestra database, worktrees, logs, metrics, diagnostics, device records,
and audit history. These operations primitives are local-only and contain no analytics or hosted
telemetry sender. Retention/deletion remains an explicit local-owner action; revocation retains
minimal audit evidence but removes authority.

External network use occurs only when a separately enabled feature requires it:

| External service | Purpose | Data boundary |
|---|---|---|
| Declared Claude/Codex/Qwen/Kimi provider endpoint | Managed provider execution | Provider-native requests under the declared account/billing mode; operations logs do not mirror content |
| Anthropic OAuth usage endpoint | Claude subscription usage check | OAuth bearer sent by the existing integration; only the usage result is cached/persisted |
| Tailscale | Private remote transport | Tunnel/control-plane metadata under the user's tailnet configuration |
| Cloudflare quick tunnel | Explicitly confirmed public transport only | Public origin and tunnel traffic; no automatic fallback in the safe target |
| Web Push endpoint / `ntfy` | Opt-in minimal notification delivery | Device-bound minimal preview only; no credentials, commands, prompts, PTY, approvals, or external deep links |

No operations artifact may be uploaded automatically. Documentation, UI, and setup must disclose
each enabled external service and its data class before activation.

## Security review checklist (`OPS-022` evidence)

- Dependency review: run `npm audit --omit=dev` and full `npm audit`; triage every finding against
  shipped/runtime reachability rather than suppressing it.
- Secret review: run Gitleaks on the branch diff and repository; decode a seeded diagnostics bundle
  and assert every seeded credential/content value is absent.
- Authentication review: rate limits run before handler mutation and use server-derived origin /
  device/account partitions; logs never accept caller-supplied authority identity as proof.
- Command injection review: operations modules use no shell execution or dynamic evaluation.
  Platform adapters must use fixed executable identity and argument arrays or native APIs and must
  never concatenate credentials or user input into a shell command.
- Path traversal review: bundle filenames are generated internally, normalized with `basename`,
  created under a real existing output directory, opened with `O_EXCL`, and never accept a caller
  path component. The lane-root API must not expose arbitrary output paths remotely.

## Verification map

| Backlog item | Direct evidence in this slice |
|---|---|
| `OPS-009` | `redaction.ts`, double-redacted logger/diagnostics tests |
| `OPS-010` | `credentials.ts`, fail-closed/expiry/atomic-rotation/selective-revoke tests |
| `OPS-012` | Hashed bounded request/command/provider limiter and load tests |
| `OPS-013` | Shared daemon-lifetime structured logger with correlation/job/session/device attribution |
| `OPS-014` | Seven live concurrent timeout-bound probes, real DB/lease verification, minimal readiness |
| `OPS-015` | Allowlisted gzip diagnostics, seeded secret/content absence, owner-only exclusive write |
| `OPS-016` | Shared daemon-lifetime registry, required vocabulary and label/cardinality controls |
| `OPS-017` | Shared alert state, six privacy-safe alert families with cooldown/deduplication |
| `OPS-018` | Live admission helper, persistent state, 10,000-admission bounded-load evidence |
| `OPS-019` | Immutable failure policy and stable-code classifier |
| `OPS-021` | Ownership/privacy/local-only/external-service contract above |
| `OPS-022` | Security checklist, injection/path guards, secret scan and dependency review commands |

`OPS-010`, `OPS-012`, `OPS-014`, and the end-to-end alert/metrics paths are integrated and covered
by the final Lane C checkpoint. This document intentionally does not update authoritative backlog
counts.
