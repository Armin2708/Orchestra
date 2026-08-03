# Beta release monitoring

The beta monitor turns privacy-safe NDJSON events into one digest-bound release report:

```sh
npm run beta:monitor -- ./beta-events.ndjson ./beta-monitor-report.json
```

Accepted event types are install success/failure, provider error/recovery, token usage, and
migration success/failure. Provider incidents use opaque incident IDs so recovery must reconcile
to an observed error. Token samples include only provider, token count and bounded window length.
Raw errors, prompts, outputs, paths, user/device IDs, credentials and arbitrary labels are rejected.

Defaults fail on any install failure, migration failure, unresolved provider incident, or sample at
or above 100,000 tokens/minute. The generated report retains counts, alert categories and a
SHA-256 digest. It always writes `gate_claimed: false`: an empty stream cannot pass, and a clean
local fixture is not rollout evidence.

For a real opt-in beta, append events from install support, provider health, recovery, usage and
migration telemetry into one retained stream for the defined observation window. Keep the stream
and report beside the exact release artifact. REL-014 closes only after that real window is
reviewed; the monitor itself does not fabricate elapsed operation or public-user evidence.
