# Beta Lane C adversarial security and chaos test plan

Status: independent pre-integration test contract; **not** REM-GATE or OPS-GATE sign-off.

This checkpoint freezes an executable black-box contract for the remote/mobile threat model and
operations recovery gate. It intentionally does not implement authentication, migrations, route
registration, service authorization, recovery, or observability. The lane integrator must supply a
`RemoteOpsAdversarialTarget` adapter backed by the integrated server and durable state, then run
the complete contract against the exact lane head.

## Executable integration

The reusable contract is
`test/support/remote-ops-adversarial-contract.ts`. An adapter implements two methods:

- `reset()` restores a clean, isolated fixture without reusing credentials or authority;
- `perform({ op, ...inputs })` maps the contract operation to real HTTP, browser, daemon, database,
  provider, tunnel, clock, or fault-injection behavior and returns `{ status, ...evidence }`.

The final integrated test must call both:

```ts
assertAdversarialContractPassed(await runRemoteSecurityAdversarialContract(realTarget))
assertAdversarialContractPassed(await runOperationsChaosContract(realTarget))
```

An adapter must not return synthetic success. Evidence fields such as `duplicateJobs`,
`orphanAuthority`, `silentDataLoss`, `purged`, `deviceName`, and `headers` must be read from the
durable database, active runtime, captured response, browser storage/cache, or external-process
probe named by the fixture. Each adapter mapping belongs in review evidence so a later implementation
cannot weaken the test by changing only the adapter.

## Threat-control acceptance checklist

| Case | Required proof | Primary controls |
|---|---|---|
| AC-01 | One correct-origin redemption wins; replay and wrong-origin redemption fail; QR has no master token | TGT-001, TGT-003 |
| AC-02 | Browser storage, URL, referrer, logs, analytics and push contain no master bearer; wrong device key fails | TGT-003 |
| AC-03 | Stream ticket is purpose-bound, single-use/bounded and rate-limited; never accepted by another API | TGT-001, TGT-008, TGT-014 |
| AC-04 | Lost device loses credential, stream, grants, push and cache at next contact without false remote-erase claim | TGT-002, TGT-003, TGT-010, TGT-011 |
| AC-05 | Host, trusted forwarded host, Origin and Fetch Metadata reject before credential/handler evaluation | TGT-007, TGT-009, TGT-014 |
| AC-06 | Default phone cannot write terminal; terminal-write still needs current process/resource-bound step-up | TGT-004, TGT-005, TGT-006 |
| AC-07 | Deny/cancel is exact-request; risky allow/allow-session needs digest-bound user verification | TGT-004, TGT-005, TGT-012 |
| AC-08 | Agent and low-scope devices fail across canonical, compatibility, legacy and infrastructure mutations | TGT-004 |
| AC-09 | Sensitive authenticated content is not cached by default; leased safe content expires and purge occurs on contact | TGT-010, TGT-011, TGT-017 |
| AC-10 | Offline message, approval, control, terminal, admin and destructive mutations fail and never replay | TGT-010 |
| AC-11 | External, scheme-relative, unsafe-scheme and non-allowlisted push links fall back to app home | TGT-013 |
| AC-12 | Public fallback needs consent; stale/unowned tunnel state cannot be reused or signalled; abuse is limited | TGT-008, TGT-009, TGT-015 |
| AC-13 | Selective revoke keeps the other phone, stream and daemon live; old ticket/token never becomes master authority | TGT-002, TGT-003, TGT-011, TGT-015 |
| AC-14 | Grant replay and device/action/process/workspace/resource/digest/expiry mismatch all fail | TGT-005, TGT-012 |
| AC-15 | Approval race has one winner with device/grant audit and no raw approval parameters or withheld reasoning | TGT-002, TGT-006, TGT-012 |
| AC-16 | A new non-GET route is denied until scope, step-up, attribution and abuse classification exist | TGT-004, TGT-015 |
| AC-17 | Default lock-screen preview is generic; device revocation removes only its subscription | TGT-013 |
| AC-18 | Message-only text stays in no-tool Q&A; wording cannot promote it into tool-capable work | TGT-018 |
| AC-19 | New GET, IDOR, raw output/transcript/context/export/system/settings/approval reads fail by default | TGT-017 |
| AC-20 | `frame-ancestors 'none'` plus compatible fallback prevents cross-origin embedding | TGT-007 |

## Lost, stolen, revoked, and expired-device matrix

| State | API | stream | step-up | push | cache/contact | unrelated sessions | daemon |
|---|---|---|---|---|---|---|---|
| Expired | deny | close/deny | deny | stop | purge at next contact | unchanged | running |
| Explicitly revoked | deny immediately online | close | expire | remove subscription | purge at next contact | unchanged | running |
| Lost but offline | no remote-erase claim | no new stream | no new grant | stop server delivery | local lease expires; purge when contact resumes | unchanged | running |
| Credential stolen without device key | sender-constraint failure | deny | deny | none | no new cache | unchanged | running |
| Credential and key stolen | bounded until expiry/revoke and only within scopes | bounded | user verification still required | device policy applies | no sensitive default cache | unchanged | running |

Rotation evidence must show the previous credential becomes unusable after the overlap policy,
only a hash/key binding is stored server-side, expiry is enforced against a controlled clock, and
rotating one device does not rotate other DeviceSessions or the master local-recovery credential.

## Operations and chaos checklist

| Case | Fault points | Passing invariant |
|---|---|---|
| OPS-CHAOS-01 | contract created, queued, claimed, session created, launching, running, delivery submitted, outbox pending | zero duplicate jobs, orphan authority, invalid leases or silent loss after restart |
| OPS-CHAOS-02 | replacement starts while old teardown write is blocked | old generation cannot mark replacement-owned agents gone; DB/runtime/provider counts agree |
| OPS-CHAOS-03 | event delivered, crash before acknowledgement | replay drains outbox with exactly one logical side effect and zero projection lag |
| OPS-CHAOS-04 | disk full, database locked, provider unavailable, git conflict | no false success; exact retry succeeds without duplicate work or lost evidence |

The integrated run must additionally prove:

- backup includes SQLite database plus WAL/SHM-consistent state and passes integrity/checksum;
- restore is offline, explicit and verified before the original state is retired;
- migration checksum mismatch and corruption fail closed without partially granting authority;
- active multi-agent shutdown drains or fences the old daemon generation before replacement writes;
- queue depth/backpressure has a declared cap and fails gracefully under many-agent load;
- reconciliation covers orphan sessions, jobs, workspaces, processes, locks, device grants and
  outbox receipts;
- idempotency keys bind normalized request, command and scope, returning the original durable result
  on exact replay and rejecting altered reuse;
- health, metrics and alerts expose recovery failure without logging credentials, raw terminal
  input, raw approval parameters, raw transcript/context or withheld reasoning.

## Injection, dependency, and secret-review expectations

### Command and path injection

- Enumerate every process spawn/exec, shell construction, signal, cwd, worktree, branch, archive,
  restore, diagnostics and tunnel command touched by the lane.
- Prefer argument arrays with `shell: false`; reject metacharacter, newline, NUL, option-injection,
  traversal, symlink escape, absolute-path escape and Unicode normalization cases.
- Resolve and re-check execution roots after filesystem canonicalization. A lexical prefix match is
  not an authorization check.
- Backup/restore destinations must be explicit, absent or deliberately replaceable, outside broad
  roots, and never derived from an untrusted device label.
- Tunnel stop must prove process ownership, executable identity and expected start identity before
  sending a signal; PID liveness alone is insufficient.

### Secret leakage

- Scan the changed diff, full tracked tree, built package, diagnostics fixture, logs, audit rows,
  browser bundles/service worker, URLs, QR payloads, response headers, referrers, analytics and push
  payloads.
- Seed recognizable sentinel values for master token, agent token, pairing secret, device
  credential, stream ticket, step-up grant, provider credential and VAPID private key. The scan is
  only credible when it detects a deliberately included positive-control fixture outside the
  shipped artifact.
- Device credentials must be hashed/key-bound at rest. Audit may retain device/session/grant
  identifiers but not credential material, raw PTY input, raw approval parameters or withheld
  reasoning.

### Dependency review

- Run `npm audit` against the exact root and web lockfiles and classify every production advisory;
  an allowlist needs owner, rationale, reachability, compensating control and expiry.
- Review every new direct/transitive production dependency for install scripts, maintenance,
  provenance, license, browser/server placement, native code and network behavior.
- Verify the packed artifact uses the same lockfiles and does not acquire unreviewed dependencies
  during install or diagnostics generation.

## Required observability evidence

- Structured logs correlate request, command, job, session and device with bounded opaque IDs.
- Health distinguishes database, daemon lease, drivers/providers, PTY supervisor, hooks and tunnels.
- Metrics include queue depth, launch latency, active sessions, provider errors, retries, outbox lag,
  reconciliation outcome, rate-limit rejection and device revoke propagation.
- Alerts cover stuck jobs, repeated retries, lost processes, event lag, token storms, auth floods,
  pairing replay, step-up replay and failed lost-device purge/contact.
- Diagnostics are generated from a synthetic fixture and independently scanned for every seeded
  sentinel before any claim of automatic redaction.

## Initial findings at required base `0dd3dd43`

These findings describe the pre-integration baseline and must be re-tested on the integrated lane
head. They are not new implementation regressions.

| Severity | Finding | Gate impact |
|---|---|---|
| P0 | QR/localStorage/SSE query expose one reusable master operator bearer | AC-01–03, REM-GATE blocked |
| P0 | No named, scoped, expiring, key-bound, selectively revocable DeviceSession or resource-bound step-up | AC-04, AC-06–08, AC-13–16, REM-GATE blocked |
| P1 | No centralized default-deny route/resource/field/data policy or no-tool message boundary | AC-08, AC-16, AC-18–19 |
| P1 | Host/Origin/Fetch Metadata/anti-framing and route-family rate limits are incomplete | AC-03, AC-05, AC-12, AC-20 |
| P1 | Sensitive authenticated cache and push subscription are not device-bound or revoke-purged | AC-04, AC-09, AC-11, AC-13, AC-17 |
| P1 | Documented old-daemon survivor write race can overwrite replacement recovery state | OPS-CHAOS-02, OPS-GATE blocked |
| P2 | Public quick-tunnel fallback and PID-based reuse/stop do not prove consent or ownership | AC-12 |
| P2 | No automatic independently proven redacted diagnostics bundle | OPS-015 blocked |

Final security review requires zero unresolved P0/P1/P2 findings, exact integrated-head evidence,
Node 22.20.0, both complete test modes, typecheck/build/package gates, Graphify update, GitNexus
change review, dependency review, secret scans, injection review, chaos/load evidence, and a
practiced rollback. This document alone satisfies none of those completion claims.
