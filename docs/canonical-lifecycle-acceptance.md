# Canonical lifecycle acceptance

## TL;DR

Milestone A has one executable acceptance harness for Board, Agent OS API, and CLI launches. The
harness compares persisted contract, job, workspace, session, and causal-event snapshots rather
than trusting route-specific response text. It also proves one winner under a three-entrypoint race
and verifies restart reconciliation does not duplicate a lifecycle.

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
| Restart reconciliation | The same file recreates the runtime and requires the original non-resumable job/session to be terminalized once |
| Canonical presentation join | `test/canonical-lifecycle-presentation.test.ts` proves exact-ID joins and refuses card-owner inference |
| Shared response contract | The presentation test covers provider controls, idempotency, correlation, dispatch, workspace, and session fields |
| Existing resumable-provider recovery | `test/agent-os-runtime-integration.test.ts` resumes a Claude session and preserves the job identity |

## UI behavior

The Workspace Cockpit loads canonical jobs beside workspaces, deliveries, and events. Its lifecycle
strip presents:

- the exact persisted job ID and status;
- the selected workspace ID;
- the delivery-scoped session ID, or `not linked` when none is persisted;
- the latest exact job dispatch event, or `not recorded` when the event ledger has no match.

Loading state is not labeled ambient. A workspace is called ambient only after the canonical job
list has loaded and no job has that exact workspace ID.

## Remaining integration work

- Add authenticated `GET /api/v1/os/jobs/:id` backed by
  `OrchestrationService.getJobSnapshot(jobId)` after that domain read method lands. This is the
  durable refresh/restart response counterpart to the launch envelope.
- Run the harness again after idempotency-key routing lands, then extend the race case to assert
  same-key replay and changed-fingerprint conflict.
- BASE-009 remains broader than Milestone A: append delivery verification, accepted discussion
  promotion, and cited knowledge reuse when those north-star services are implemented.

## Delivered / Evidence / Remaining handoff

- **Delivered:** executable entrypoint parity, duplicate-race and restart-recovery harnesses; strict
  canonical response types; exact-ID Workspace Cockpit presentation.
- **Evidence:** focused Vitest suite, root/web TypeScript checks, and the repository-wide test/build
  evidence recorded with the implementing commit.
- **Remaining:** the durable GET snapshot route and post-Milestone-A request-to-knowledge stages
  listed above.
