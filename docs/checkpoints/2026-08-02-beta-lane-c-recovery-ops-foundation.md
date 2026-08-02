# Beta Lane C recovery and operations foundation

Status: implementation integrated for `OPS-002` through `OPS-008`, `OPS-019`, and `OPS-020`.
Production transition-chaos acceptance for `OPS-002` and `OPS-GATE` remains open. This checkpoint
does not update authoritative backlog counts.

## Delivered boundary

`src/agent-os/operations-recovery.ts` defines migration contract
`041-operations-recovery-foundation`, which follows integrated migration
`040-device-sessions`. Its transactional installer creates all seven owned tables/indexes only
when all are absent, then attests exact normalized `sqlite_master` SQL and column metadata. A
lost-marker replay is a no-op; partial or weakened same-name schemas fail without repair. It also
provides:

- atomic source-write plus outbox enqueue with content-bound deduplication;
- lease-based at-least-once delivery with one stable downstream idempotency key;
- transaction-scoped idempotent database projection consumers;
- expired delivery lease recovery after database restart;
- fixed-vocabulary persisted delivery failures; raw provider/HTTP errors never enter the outbox;
- orphan reconciliation for processes, managed sessions, jobs, workspaces, and stale daemon
  leases, while leaving unrelated active work, the current lease, and independently ownership-
  proven live leases intact; PID liveness alone is never authority;
- configurable event, transcript, PTY, and artifact retention policy, lossless gzip archives,
  checksums, and bounded compaction;
- fixed fail-closed dispositions for disk-full, SQLite locked/corrupt, provider unavailable, Git
  conflict, and path-escape conditions, selected only by stable error codes rather than raw error
  text;
- a mutation admission/drain barrier with explicit, independently bounded provider detach or stop
  at the deadline.

`src/agent-os/operations-runtime.ts` provides the daemon-owned integration seam without registering
central routes:

- ordered existing-process, existing-job, and operations-orphan reconciliation before launch
  admission opens;
- a non-overlapping durable outbox worker with destination adapters, bounded delivery calls,
  stable downstream idempotency keys, lease retry, dead-letter outcomes, a lease longer than the
  maximum adapter call, mandatory durable-idempotency conformance evidence, abort signaling,
  same-process unsettled-call reuse, fixed-vocabulary observations, and queryable diagnostics;
- a non-overlapping retention scheduler that passes the configured transcript duration and stable
  restart-safe cycle id to the existing transcript-retention seam before lossless operations
  compaction, but only after consuming named local-admin authorization and audit evidence;
- synchronous shutdown admission freeze, producer stop, bounded active-work drain, bounded flush,
  and a stable shutdown report; launch callbacks cannot execute after closing begins, and any
  unresolved, unflushed, or still-active outbox delivery explicitly forbids releasing the daemon
  lease/database authority.

`src/agent-os/database-recovery.ts` provides:

- SQLite online backup into unpublished partial files;
- integrity, foreign-key, byte-size, database SHA-256, schema SHA-256, and migration-inventory
  SHA-256 verification before publication or restore;
- restore only after an owner-only clean-shutdown receipt binds the exact database identity to a
  recorded exited daemon PID, released lease, and completed provider-runtime/hook shutdown;
- one exclusive state-transition lock serializes daemon startup with restore, so a new daemon
  cannot claim SQLite authority during database replacement;
- recoverable quarantine of replaced database, WAL, and SHM state;
- recoverable backup retirement instead of deletion;
- repository/worktree/branch/cwd validation through argv-only Git calls;
- lexical, realpath, and symlink path-containment enforcement.

## Acceptance coverage

| Item | Foundation/evidence |
|---|---|
| `OPS-002` | Close/reopen outbox lease recovery, persisted reconciliation state, and startup ordering have focused coverage. Production every-transition `OPS-CHAOS-01`–`04` acceptance remains open because the generic contract was only executed against `DenyAllProbe`. |
| `OPS-003` | One immediate reconciliation transaction revokes duplicate/orphan authority, requeues within attempt budget, blocks exhausted/missing-workspace jobs, marks dead PTYs lost, and releases only stale leases; runtime test proves startup ordering |
| `OPS-004` | `transact`, durable non-overlapping outbox worker, bounded adapter delivery, leased retries, exponential bounded backoff, dead-letter terminal state |
| `OPS-005` | Content-bound `(consumer,event_id)` receipts and stable delivery idempotency keys |
| `OPS-006` | Online backup, offline restore, migration/schema/database checksums, corruption rejection, recoverable quarantine, and a real CLI lifecycle test that blocks wrong-port/connection-reset restore attempts while the recorded daemon is live |
| `OPS-007` | Per-board four-category policy and scheduler; lossless event compression; recoverable PTY/artifact compaction; transcript duration handed to existing Agent Home retention service |
| `OPS-008` | Registered worktree, exact branch, cwd containment, realpath/symlink defense, no shell command construction |
| `OPS-019` | Stable-code-only failure classification and fixed retry/fail-closed/operator dispositions; raw messages remain evidence, never policy input |
| `OPS-020` | Freeze admission synchronously, stop producers, bounded settle and deadline actions, bounded flush, idempotent shutdown result, proof no late launch callback executes, and fatal non-clean authority-release guard |
| `OPS-GATE` | **Open.** Focused multi-job/orphan/outbox tests pass, but no production adapter executes the complete four-case chaos contract at every claimed transition. |

Focused evidence is in `test/operations-recovery.test.ts`, `test/operations-runtime.test.ts`,
`test/database-recovery.test.ts`, and `test/database-restore-cli-quiescence.test.ts`. These tests
do not substitute for the still-open production chaos adapter.

## Root integration contract

1. Add migration `041-operations-recovery-foundation` after `040-device-sessions`, call
   `installOperationsRecoverySchema(db)`, record
   `OPERATIONS_RECOVERY_SCHEMA_SHA256`, and include marker-loss/partial/weakened schema cases in
   canonical migration integrity tests. Do not execute the raw SQL directly from the migration.
2. Construct `OperationsRecoveryService` only after acquiring the single-daemon lease. Bind the
   existing PTY/provider and job reconciliation callbacks plus orphan proof callbacks into
   `OperationsRuntimeCoordinator`; its `start()` enforces reconciliation before the outbox worker.
   Supply `ownsDaemonLease` only from a proof that binds lease owner id, PID, state directory, and
   heartbeat identity; a live PID by itself must return false.
3. Enqueue critical Attention/notification projections in the same transaction that appends their
   source event. Every downstream adapter must provide reviewed durable-idempotency conformance
   evidence and honor `delivery.idempotencyKey` across process restart; it must also consume the
   supplied `AbortSignal`. Runtime tracking prevents concurrent reinvocation while an ignored-abort
   callback remains unsettled, but restart safety remains the downstream durable contract.
4. Route transcript retention through `AgentHomeRetentionService` using
   `OperationsRetentionPolicy.transcript_days`. Bind `authorizeCompaction` to consume current,
   named local-admin command evidence and its durable audit event; absent/invalid evidence leaves
   retained content untouched.
5. Expose backup/verify/restore/retire as local operator commands. Restore must acquire the shared
   state-transition lock, verify the owner-only receipt against the exact database identity,
   prove the recorded PID has exited, require an absent daemon PID file and lease, and retain the
   lock through replacement. A health URL, wrong port, timeout, reset, or operator flag is never
   quiescence evidence.
6. Put `OperationsRuntimeCoordinator.admitLaunch` at central launch admission and invoke `close()`
   on signal/upgrade. Keep ordinary mutation admission behind the same
   `SafeShutdownCoordinator`. Release the lease and close SQLite only when
   `safeToReleaseAuthority` is true (or after `assertOperationsShutdownClean` succeeds); otherwise
   preserve authority and enter fatal operator recovery.
7. Bind each worker's observation callback to structured logs/metrics/alerts and export its
   fixed-vocabulary `diagnostics()` snapshot. Never attach raw provider error text to observations.

## Residual risks after lane acceptance

- Migration registration, daemon wiring, CLI/routes, authorization, and security-attributed audit
  events are integrated in the lane root; combined evidence is in `beta-lane-c-remote-ops.md`.
- External notification exactly-once behavior depends on the downstream adapter honoring the
  stable idempotency key; delivery is intentionally at least once across the acknowledgement
  window.
- Focused live SIGKILL and active multi-agent reconciliation tests passed. The repository
  lifecycle-transition chaos matrix remains unproven against a production adapter, so
  `OPS-002` release acceptance and `OPS-GATE` remain open.
- Backup restore is offline by contract; it must not be exposed through a remotely scoped device
  route.
