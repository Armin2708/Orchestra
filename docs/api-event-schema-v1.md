# Versioned API, event, and schema contract

Contract version: **1**. Executable source: `src/operator-contract.ts`.

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

The automated compatibility check rejects operator-contract, first-run-schema and provider-contract
major mismatches. Database compatibility additionally requires the exact migration/integrity gates;
a matching API major alone does not authorize an old binary to write a newer database.

Authentication and DeviceSession scope are not encoded by URL version. Every route inherits the
current authorization boundary, and Lane C must prove remote attribution/step-up independently.
