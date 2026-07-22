# Delivery Trackbook

The Delivery Trackbook is Orchestra's durable answer to two questions:

1. What did we ask an agent to deliver?
2. What was actually delivered, verified, accepted, and shipped?

It does not treat a final chat message or a card moving to **done** as proof. Requested work,
agent claims, observed evidence, verifier findings, human overrides, and acceptance remain
separate records with one audit trail.

## Lifecycle

~~~text
contract vN
    |
    +-- launch job --> draft delivery with immutable Asked snapshot
    |
    +-- later contract edits become vN+1 and do not rewrite the snapshot

draft --submit--> submitted --verify--> verified --accept--> accepted
                         |                  |
                         +----reject--------+--> rejected --revise--> new draft
~~~

- **Draft** is created before a managed job is dispatched.
- **Submitted** means every promised deliverable and acceptance criterion has an explicit
  outcome, including honest **partial**, **missed**, or **unverifiable** outcomes.
- **Verified** means a verifier recorded deliverable- and criterion-level results. The normal
  workflow assigns that pass independently from the producing agent.
- **Accepted** requires every mandatory deliverable and criterion to pass with evidence, or
  an audited human override.
- **Rejected** preserves feedback. Revising creates a new delivery record linked to its parent;
  it never overwrites the rejected attempt.

Moving a managed card to **review** requires a submitted delivery report. Moving it to **done**
requires an accepted report. Manual cards that have never entered the managed contract/job
lifecycle retain the legacy board behavior.

## Asked snapshot

Every job freezes the contract it is answering:

- objective;
- stable, required/optional deliverables;
- stable, required/optional acceptance criteria;
- verification commands;
- non-goals and known risks;
- contract version and update time;
- base ref, dependencies, budgets, priority, and policy where present.

Contract updates create a newer version for later work. They cannot silently change the meaning
of a running or historical delivery.

## Delivered report

A delivery records:

- a concise human summary;
- one outcome for every promised deliverable;
- criterion-by-criterion results and evidence references;
- claims made by the agent, kept explicitly separate from evidence;
- changed files, commits, artifacts, patches, and verification records;
- evidence gaps and reasons for anything partial, missed, or unverifiable;
- job, session, workspace, actor, revision, and lifecycle timestamps.

The deterministic human report is suitable for a review note, terminal output, or export:

~~~text
Asked
  Make session renewal race-free.

Delivered
  2 of 3 promised outcomes delivered; 1 needs evidence.

Delta
  MET       Concurrent refresh is serialized - test artifact auth-race.txt
  PARTIAL   Recovery path updated - missing restart verification
  MISSED    Upgrade note - not delivered in this revision
~~~

## CLI

~~~sh
orchestra delivery show 42
orchestra delivery show 42 --json

orchestra contract set 42 \
  --objective 'Make session renewal race-free.' \
  --deliverables '[{"id":"session-renewal","text":"Serialize concurrent refresh","required":true}]' \
  --accept '[{"id":"concurrent-refresh","text":"Concurrent refresh test passes","required":true}]' \
  --non-goals '["Redesign authentication"]' \
  --risks '["Provider output may omit evidence"]'

orchestra delivery submit <job-id> \
  --summary 'Renewal is serialized and covered by concurrent tests.' \
  --items '[{"deliverableId":"session-renewal","status":"delivered"}]' \
  --claims '["The concurrent refresh test passes."]' \
  --files '["src/auth/session.ts","test/auth-race.test.ts"]' \
  --commits '["abc1234"]' \
  --artifacts '["test-report-artifact-id"]'

orchestra delivery verify <delivery-id> \
  --deliverables '[{"deliverableId":"session-renewal","outcome":"met","evidenceRefs":[{"kind":"artifact","ref":"test-report-artifact-id"}]}]' \
  --criteria '[{"criterionId":"concurrent-refresh","outcome":"met","evidenceRefs":[{"kind":"artifact","ref":"test-report-artifact-id"}]}]'
orchestra delivery accept <delivery-id> --note 'Evidence reviewed.'
orchestra delivery reject <delivery-id> --reason 'Restart evidence is missing.'
orchestra delivery revise <delivery-id>
orchestra delivery export <delivery-id>
orchestra delivery export <delivery-id> --json
~~~

Use **--stdin** for a submission or verification body that contains shell-sensitive text or a
larger JSON report. CLI JSON options accept JSON values directly; they do not expand `@file` paths.

## HTTP API

All routes inherit the normal **/api/v1/os** authentication boundary. The daemon gives managed
Claude/Codex subprocesses a scoped agent credential; the paired web UI and ordinary operator CLI
use the operator credential. Submit and verify remain available to agents, while accept, reject,
audited override, Board approve/send-back, and move-to-done require the server-derived operator
principal. Caller-supplied actor text cannot turn an agent credential into a human acceptance.

This is a workflow credential boundary, not OS isolation. A `full_access` agent intentionally
shares the user's account, filesystem, and database, so a deliberately hostile process could read
or rewrite operator state outside the API. Treat full-access agents as trusted, or run them under a
separate OS/container identity; proof of physical human presence remains a later WebAuthn/keychain
hardening step.

- GET /cards/:id/deliveries
- POST /jobs/:id/deliveries/prepare
- POST /jobs/:id/deliveries/submit
- POST /deliveries/:id/verify
- POST /deliveries/:id/accept
- POST /deliveries/:id/reject
- POST /deliveries/:id/revise
- GET /deliveries/:id/export?format=human|json

Create, submit, and provider-completion operations are idempotent so daemon recovery or a retried
request cannot manufacture duplicate delivery attempts.

## Evidence and overrides

Agent claims are useful context, but never proof. Normal acceptance requires evidence for every
mandatory deliverable and criterion. Evidence may be a diff, test result, command exit, review,
artifact, shipped commit, or another contract-appropriate record; research work is not forced to
have a code diff.

A human can override a deliverable or criterion only with actor identity, reason, timestamp, and
the affected result. The Trackbook presents the override beside the original verifier outcome
instead of rewriting it.

## Compatibility

- The legacy Board launch remains available while canonical launch is feature-gated.
- Legacy completion is projected into a compatibility delivery before review so both launch paths
  populate the same Trackbook.
- Existing verifier and approval routes update the canonical delivery record.
- Terminal jobs created before the Trackbook migration receive an explicitly attributed
  compatibility report when they next enter the review/approval flow; active jobs with missing
  reports still fail closed.
- A report is always selected from the latest managed job. Revising an older rejected lineage
  cannot steal the current review or completion gate.
- Unmanaged/manual cards are not retroactively blocked by delivery gates.
- The legacy **deliveries** table continues to mean message-recipient delivery; task results use
  dedicated delivery-report tables.

If canonical launch is switched off after a card already accumulated managed-job history, a new
legacy relaunch does not yet receive its own durable execution identity. The Trackbook keeps the
latest managed-job gate fail-closed; start a new managed job/card for that rollback edge instead
of reusing an older accepted report.
