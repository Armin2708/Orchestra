# Opt-in telemetry and diagnostics-backed support

## Telemetry boundary

Orchestra has two different telemetry classes:

- local injected-context counters already stored in the local database; and
- optional external product telemetry, introduced by this lane's strict envelope.

External telemetry is **off by default**. Opting in permits only four event names and enum-only
properties: onboarding, doctor, lifecycle-demo and support-bundle outcomes. Installation identity
is a one-way SHA-256 of a local random seed. The envelope accepts no arbitrary strings, paths,
project/card/session/device identifiers, prompts, transcripts, commands, file names, credentials,
provider payloads, PTY output or error bodies. No transport is registered by this lane; the Lane D
integrator must keep capture inert unless an approved destination and privacy review exist.

Local counters are not silently converted into external events. Provider runtime network calls and
the documented Claude usage-window check are separate product behavior.

## Support workflow

Lane C/OPS owns automatic redacted diagnostics generation. Once available, it must produce a
manifest with schema version, basename (never local path), digest, generation time, included
categories, redaction attestation and zero secret findings.

`prepareSupportCase` accepts only that verified manifest, a full exact commit, safe issue text,
expected/actual behavior and reproduction steps. It refuses unverified or secret-bearing input and
emits a reviewable support-case manifest. Before sharing, the operator still reviews the bundle.

Never attach databases/WAL/SHM, state roots, bearer files, provider login output, environment dumps,
transcripts, prompts, PTY output, approval parameters, source files, local paths, raw browser storage,
remote URLs/QRs, push keys, or unreviewed screenshots/logs. If automatic diagnostics are unavailable,
do not improvise an archive; follow [support-preview.md](support-preview.md).
