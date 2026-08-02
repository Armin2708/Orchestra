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

- all eight lifecycle fault points create real scheduler jobs and durable session/process/outbox
  rows, close/reopen the actual SQLite database, reacquire the production daemon lease, and run
  `OperationsRecoveryService.reconcileOrphans`;
- old-generation shutdown release executes the production lease's owner-CAS cleanup after a
  replacement owner is installed, proving the stale handle cannot delete replacement authority;
- ambiguous outbox delivery commits a real idempotent database projection, interrupts before
  acknowledgement, then reopens and drains with five logical effects and zero duplicates/lag;
- disk-full uses SQLite `max_page_count`, database lock uses a second exclusive SQLite connection,
  provider/network loss uses an unavailable then restored loopback HTTP destination, and Git
  conflict runs `git merge-file`; every first attempt fails closed and the same idempotency key
  succeeds without duplicate jobs after recovery; and
- actual provider-child processes are isolated under the test root and always killed during
  cleanup. Only generated temporary directories are removed.

The pre-existing `test/agent-home-daemon-restart-acceptance.test.ts` remains the full-process
SIGKILL proof: it starts the production daemon and Codex app-server adapter, kills the daemon during
two active jobs, restarts, resumes both provider threads, preserves exact job/session/workspace /
conversation identities, and completes with no duplicate authority or history.

## Evidence and closure boundary

The new focused test is `test/operations-chaos-production-adapter.test.ts`. It executes the exact
four-case register from `test/support/remote-ops-adversarial-contract.ts`; a failure in any
operation returns a failed case and fails the test. Final counts, exact commit, dual-mode results,
type/build/audit/secret-scan output, GitNexus change review, and Graphify refresh belong in the
ready marker after verification.

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
