# Agent OS Hosted QA-019 Checkpoint — 2026-07-25

Status: **hosted exact-commit engineering evidence only**. GitHub Actions verified
`3c543b52a32109747d5f0fa1521188380c55fa93` on
`codex/northstar-program`. This closes `QA-019`; it is not package publication, a release, or a
public plug-and-play claim.

## TL;DR

| State | Observed result |
|---|---|
| Backlog reconciliation | **123 / 373 delivered; 250 open** |
| Hosted run | `30171494794` — PASS |
| Exact commit | `3c543b52a32109747d5f0fa1521188380c55fa93` |
| Required gates | 21 / 21 passed; 0 failed, missing, unexpected, or SHA-inconsistent |
| Test suites | Serial and default-parallel: 127 files / 890 tests each |
| Independent review | PASS — zero P0–P2 findings |
| Publication/release | Open — publish job skipped; no tag, public npm package, provenance, or release proof |

## Asked

Prove on hosted infrastructure that one exact frozen commit passes the required tests, builds,
package, audit, protocol, security, and smoke gates, with independently reproducible artifacts.

## Delivered

- GitHub Actions run `30171494794`, job `89713294560`, completed successfully from a push to
  `codex/northstar-program` at the exact expected SHA.
- The evidence manifest reports 21 required gates, all passed, with no failed, missing, unexpected,
  SHA-inconsistent, or package-inconsistent result.
- Both the serial and default-parallel Node 22 suites passed 127 files / 890 tests.
- Root/web TypeScript, production builds, audits, Gitleaks, pinned Codex `0.144.6` protocol,
  provider doctor, shell E2E, package creation, and install-smoke gates passed.
- An independent read-only reviewer reproduced both retained downloads, package identity, and a
  fresh `--ignore-scripts` install smoke, with zero P0–P2 findings.

## Retained evidence identity

| Artifact | Identity |
|---|---|
| Evidence artifact | ID `8623066008`; GitHub SHA-256 `d103adb0f3548f8b9919e26f8521086dc5396c8a809ab57e0788450a5ee114a8` |
| Package artifact | ID `8623065814`; GitHub SHA-256 `1d221cc6ae1cbd407ba9adfe515823d789455139c305d060225a281b370a1360` |
| Evidence manifest | SHA-256 `e762fed11a06cb7e741b60b2a4a0952a7683557fbe2e33f749730e88ebd8a96b` |
| Tarball | `orchestra-board@0.1.0`; 551,926 bytes; SHA-256 `c1492e82c08cb33f6dd8a05b0558bb00dd722f2b95575111e8e4389fc1f905b0` |
| npm identity | SHA-1 `24e70e52ca3028a64a26deff6c26afafff96c514`; integrity `sha512-FcNorV1MFhzvHWqEYkgySiIoQUYQI1SIiG1cEPNSRy0MctqSXyiKm9dSYDuwBQqkBDFqrxcYoZueCT+kQpYzvw==` |

The retained artifacts have the configured 30-day lifetime. Their independent reproduction is
evidence for this exact checkpoint, not a promise that they are a permanent distribution channel.

## Asked versus Delivered

| Asked outcome | Delivered now | Remaining |
|---|---|---|
| Exact-commit hosted evidence | All 21 required gates passed and artifacts reproduced | Run the same gate again for any later release-candidate head |
| Installable package proof | Retained tarball identity and fresh isolated install smoke | Public npm/plugin publication, credentials, provenance, tag, and clean-machine release journey |
| Agent OS release | No release claim requested or inferred | JOB-010 phase two, Knowledge Compiler, browser/remote/mobile, operations, and remaining release backlog |

`QA-019` is the only backlog item closed by this checkpoint.
