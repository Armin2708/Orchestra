# Canonical lifecycle acceptance

## TL;DR

Milestone A is delivered at `fce20fc`. One executable acceptance harness proves Board, Agent OS
API, and CLI launch parity from persisted contract, delivery, workspace assignment, workspace,
session, job, and causal-event records. It also proves idempotent replay/conflict behavior, one
winner under a three-entrypoint race, and restart recovery from a reopened database without
duplicating a lifecycle.

## Asked

- **ORC-GATE:** the same contracted card launched from Board, API, or CLI produces an equivalent
  durable lifecycle.
- **ORC-015:** a daemon restart reconciles running provider/session state without duplicate jobs.
- **ORC-019:** canonical UI surfaces display the persisted job, session, workspace, and dispatch
  truth instead of reconstructing it from card ownership.
- **BASE-009:** establish the executable north-star acceptance seam on which later delivery,
  discussion, and knowledge stages can be appended.

## Canonical launch response

Card-linked canonical launch entrypoints share this additive envelope:

```text
mode: "canonical"
orchestration:
  lifecycle: "canonical"
  contract_attached: true
  job_id: <durable id>
  workspace_id: <durable id>
  session_id: <durable id>
  contract_id: "card:<card id>:v<version>"
  contract_version: <frozen version>
  correlation_id: <operation id>
  idempotency_key: <request key or null>
contract: <frozen work contract>
job: <scheduled execution>
delivery: <prepared Trackbook report>
workspace: <reserved assignment>
session: <reserved or active provider session>
dispatch: { started, completed, blocked, deferred }
dispatch_error: <string or null>
```

Compatibility and ambient responses must identify themselves as `legacy` or `ambient`; consumers
must not manufacture missing canonical links. `web/src/osApi.ts` rejects incomplete values passed
to its canonical normalizer for this reason.

## Executable evidence

| Requirement | Test evidence |
|---|---|
| Board/API/CLI lifecycle parity | `test/canonical-orchestration-acceptance.test.ts` compares normalized durable snapshots from all three entrypoints |
| Cross-entrypoint duplicate race | The same file races Board, API, and CLI and requires exactly one job/workspace/session lifecycle |
| Restart reconciliation | The same file closes the original server/database, reopens the SQLite file, creates a new runtime, and terminalizes the original non-resumable job/session once |
| Idempotency replay/conflict | The acceptance and route suites reuse snake/camel/header spellings, require the original IDs for the same fingerprint, reject changed fingerprints, duplicate raw headers, and body arrays |
| Frozen non-mutating refresh | `test/orchestration-launch.test.ts` advances the editable contract after launch, then proves replay/GET return the frozen Asked version and that GET creates no records for a scheduler-only job |
| Exact causal events | The route rejects same-job events with inconsistent workspace/card/session/contract/correlation scope; web normalization independently checks the same identifiers |
| Canonical presentation join | `test/canonical-lifecycle-presentation.test.ts` proves exact-ID joins and refuses card-owner, board-job, or workspace-job inference without a scoped delivery |
| Shared response contract | The presentation test covers provider controls, access profile, frozen contract, idempotency, correlation, dispatch, workspace, session, delivery, and causal events |
| Existing resumable-provider recovery | `test/agent-os-runtime-integration.test.ts` resumes a Claude session and preserves the job identity |

## UI behavior

When a workspace-scoped delivery names a job, the Workspace Cockpit loads
`GET /api/v1/os/jobs/:id` and presents:

- the exact persisted job ID and status;
- the selected workspace ID;
- the exact session ID from that lifecycle;
- the latest scope-validated causal dispatch event.

Loading state is not labeled ambient. Invalid or unavailable exact lifecycle data is a visible
error. Without a workspace-scoped delivery, the cockpit remains ambient and does not select a job
from board/workspace proximity.

## Remaining integration work

- BASE-009 remains broader than Milestone A: append delivery verification, accepted discussion
  promotion, and cited knowledge reuse when those north-star services are implemented.

## Delivered / Evidence / Remaining handoff

- **Delivered:** durable entrypoint parity, atomic reservation, idempotent replay/conflict,
  reopened-database recovery, non-mutating frozen lifecycle refresh, strict causal response
  validation, and exact-ID Workspace Cockpit presentation.
- **Evidence:** 88 files / 526 tests, root/web TypeScript, CLI/web builds, staged GitNexus review,
  and an independent two-pass acceptance review.
- **Remaining:** post-Milestone-A request-to-knowledge stages listed above.
