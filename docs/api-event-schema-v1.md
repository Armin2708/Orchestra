# Versioned API, event, and schema contract

Candidate contract version: **1**. Executable draft: `src/operator-contract.ts`. This file documents
the intended compatibility rule; it is not a generated exhaustive route/event/schema inventory and
does not close PKG-014 until central publication and drift gates exist.

| Surface | Version | Compatibility rule |
| --- | --- | --- |
| HTTP API | `/api/v1` | additive fields/routes within v1; clients ignore unknown response fields |
| Agent OS HTTP API | `/api/v1/os` | additive within v1; canonical mutations require exact state/idempotency guards |
| Causal events | schema 1 | append-only kind plus server-derived actor, correlation and causation metadata |
| First-run config | schema 1 | unknown schema fails closed; credentials are never stored |
| Provider adapter contract | version 1 | exact selection and eight-gate evidence required for support |
| SQLite | ordered migration markers | forward-only; no automatic down migration |

Breaking meaning, required-field removal, incompatible state transition, authorization weakening,
or identity/idempotency reinterpretation requires a new major contract. An additive response field
does not. Event consumers must key on version and kind, preserve unknown events, and never infer a
terminal state from ordering alone.

The local candidate compatibility helper rejects operator-contract, first-run-schema and provider-contract
major mismatches. It is not a retained-artifact upgrade test. Database compatibility additionally requires the exact migration/integrity gates;
a matching API major alone does not authorize an old binary to write a newer database.

Authentication and DeviceSession scope are not encoded by URL version. Every route inherits the
current authorization boundary, and Lane C must prove remote attribution/step-up independently.

## Local support-case export

`POST /api/v1/ops/support-case` is local-owner-only and additive within API v1. Its request is a
closed schema containing title, summary, reproduction steps, expected/actual behavior, exact commit,
Orchestra version and the exact local-export/review consent literal. Unknown or missing fields fail
closed. Clients cannot supply diagnostics metadata, bytes, file paths or a verifier verdict.

On success, the response is one attachment with `application/json`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and an `X-Content-SHA256` digest covering the exact response bytes.
The schema-1 body contains the validated support case, the exact verified gzip bytes encoded as
base64, and explicit `required_before_sharing`, `transport_registered: false` and
`publication_performed: false` state. This route creates no external side effect.
