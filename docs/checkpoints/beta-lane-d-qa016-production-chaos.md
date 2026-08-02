# Beta Lane D QA-016 production-bound chaos evidence

Status: bounded production-interface acceptance implemented; exact central-head rerun pending.
`QA-016`, `REL-009`, real-provider dogfood duration, and public release gates remain open.

## Asked

Replace the `DenyAllProbe`-only operations check with an isolated adapter that executes
`OPS-CHAOS-01` through `OPS-CHAOS-04` against the repository's real daemon lease, scheduler,
SQLite recovery/outbox, provider/network interruption, and rollback-preservation seams. Never use
user state, the shared checkout, provider credentials, or an external service.

## Delivered

`test/support/production-operations-chaos-target.ts` implements the existing independent
`RemoteOpsAdversarialTarget` contract with disposable state only:

- all eight lifecycle fault points have distinct, query-asserted production shapes: contract only;
  queued job; claimed job; created session; launching supervised helper; running supervised helper;
  submitted delivery report; and pending outbox. Each case closes/reopens the actual SQLite
  database, reacquires the production daemon lease, and runs
  `OperationsRecoveryService.reconcileOrphans` while checking every expected durable identity;
- old-generation shutdown release executes the production lease's owner-CAS cleanup after a
  replacement owner is installed, proving the stale handle cannot delete replacement authority;
- ambiguous outbox delivery commits a real idempotent database projection, interrupts before
  acknowledgement, closes the live database, then reopens it under a new runtime generation and
  drains with five logical effects and zero duplicates/lag;
- disk-full uses SQLite `max_page_count`, database lock uses a second exclusive SQLite connection,
  provider/network loss uses an unavailable then restored loopback HTTP destination, and Git
  conflict runs `git merge-file`; every mutation is durably prepared before fault injection, every
  first attempt asserts its exact stable failure class and fail-closed disposition with a preserved
  nonempty job/outbox identity, and the same idempotency key applies exactly one effect after
  recovery; and
- generic supervised helper processes model the process-lifecycle seam without claiming a provider
  implementation. They are isolated under the test root, SIGKILLed, and awaited through exit during
  cleanup. Only generated temporary directories are removed.

The pre-existing `test/agent-home-daemon-restart-acceptance.test.ts` remains the full-process
SIGKILL proof: it starts the production daemon and a fake Codex app-server fixture, kills the daemon
during two active jobs, restarts, resumes both provider threads, preserves exact job/session /
workspace/conversation identities, and completes with no duplicate authority or history.

## Evidence and closure boundary

The new focused test is `test/operations-chaos-production-adapter.test.ts`. It executes the exact
four-case register from `test/support/remote-ops-adversarial-contract.ts`; a failure in any
operation returns a failed case and fails the test. Final counts, exact commit, dual-mode results,
type/build/audit/secret-scan output, GitNexus change review, and Graphify refresh belong in the
ready marker after verification.

The remediated lane was verified with Node `22.20.0` and npm `10.9.3`:

- the focused adapter passes, and the recovery/contract/runtime/real-daemon group passes as
  5 files / 31 tests in both default and one-worker modes;
- the complete repository passes as 267 files / 2,204 tests in both default-parallel and
  one-worker modes;
- root and web TypeScript and production builds pass;
- root and web production/full dependency audits report zero vulnerabilities; and
- the three changed files pass Gitleaks and diff-hygiene checks.

The first independent exact review correctly blocked three vacuous P1 claims and two P2 cleanup /
wording issues. This revision addresses all five; a fresh independent exact-commit review is still
required before the ready marker.

This bounded harness is strong implementation evidence for `OPS-002` and the engineering portion
of `OPS-GATE`, but it is not elapsed-time dogfood and does not claim a real subscription provider,
external network, dirty user worktree, or clean-machine release environment. Therefore:

- `QA-016` remains open until the defined long-running duration passes with real claimed providers
  and observed daemon/provider/network interruptions on the exact retained candidate;
- `REL-009` remains open until that duration completes without unresolved P0/P1; and
- release-wide `OPS-GATE` remains central-pending until the exact integrated head reruns both this
  register and the real-daemon SIGKILL test and reconciles the complete repository evidence.

## Rollback

Revert the lane commits. The change adds tests and documentation only; it does not change runtime
code, migrations, package version, public state, user data, or release artifacts.
