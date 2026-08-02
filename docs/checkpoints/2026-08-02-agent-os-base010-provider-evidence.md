# Agent OS BASE-010 declared-provider evidence — 2026-08-02

## TL;DR

The four-provider compatibility declaration is now machine-readable and fail-closed across exact
executable source, version, platform, authentication mechanism, billing mode, automation policy,
overage behavior, source commit, and the eight real acceptance gates. This deterministic contract
does **not** promote provider support: every current provider remains blocked by exact external
evidence, policy, or implementation gaps recorded below.

Source tests, fixtures, mocks, a successful version command, or a warm doctor retry cannot satisfy
the real acceptance standard.

## Authority and isolation

- Required base: `0dd3dd43b9f376370ee73a9e2fe4725974caaae8`.
- Worktree: `/Users/arminrad/Desktop/agentboard-beta-runtime-ux-base010`.
- Branch: `codex/beta-runtime-ux-base010`.
- Required test toolchain: Node `22.20.0`, npm `10.9.3`.
- Project `.env` files: none found before dependency installation or testing.
- No provider auth cache, credential file, token, account identifier, or raw login response was
  read, copied, logged, or used as evidence.
- Authoritative backlog checkboxes and counts were not changed.

## Deterministic matrix

`environment-compatibility.json` now contains the additive
`declared_provider_matrix` schema. `src/declared-provider-compatibility.ts` validates it against the
canonical provider manifests and rejects version/source/platform drift, hidden API fallback,
billing substitution, overage-policy drift, incomplete provider coverage, mock authorization, or
an unsupported support claim.

| Provider | Exact executable declaration | Subscription auth/billing | Automation/overage | Current support blocker |
|---|---|---|---|---|
| Claude Code | SDK-bundled `claude` `2.1.212`; `darwin-arm64` | Claude account session; personal subscription | blocked by current third-party subscription policy; no overage | provider-policy clearance, Linux evidence, and real matrix missing |
| Codex CLI | PATH/explicit override `codex` `0.144.6`; `darwin-arm64` | ChatGPT account session; personal subscription | allowed; no overage | exact authenticated/billing matrix and Linux evidence missing |
| Qwen Code | PATH `qwen`; no accepted version/platform tuple | Coding Plan `/auth`; subscription-scoped key | interactive only; no overage | executable/platform/auth/adapter evidence and autonomous-use permission missing |
| Kimi Code | PATH `kimi`; no accepted version/platform tuple | membership OAuth device session; personal subscription | allowed; optional metered Extra Usage requires consent | executable/platform/auth/adapter/overage/metering/cost-cap evidence missing |

Every provider-API mode remains usage-priced, secondary, explicit-opt-in only, and unable to serve
as an automatic fallback from the subscription path.

The assessor additionally requires observed—not source-only or mock—evidence, a valid exact source
commit, matching executable/readiness fingerprints, ready authentication, verified overage state,
and an exact all-pass acceptance matrix. It keeps the canonical release state, mode support, and
environment-audit state as independent blockers.

## Credential-free host evidence

Observed on macOS `26.5.1` / Darwin `25.5.0` arm64:

- Node `22.20.0` and npm `10.9.3` match the exact Darwin toolchain profile.
- PATH Codex is `0.146.0`; it correctly fails the exact `0.144.6` declaration.
- Ambient Claude is `2.1.170` and remains experimental.
- Installed Claude SDK and native package are `0.3.212`; the bundled executable reports Claude Code
  `2.1.212`.
- Qwen and Kimi executables were not found.

The first cold combined compatibility-doctor run exceeded the existing three-second bundled-Claude
version-probe limit and returned a null version. A direct bounded-safe version command and an
immediate warm Claude-only retry returned `2.1.212`. This is recorded as an **indeterminate cold
probe**, not a missing executable, and the warm retry is not provider readiness or acceptance.
Focused assessment coverage locks that distinction in place. The TOOL/doctor stream owns any probe
semantics change.

## Exact external evidence blockers

- No clean isolated provider profile was authorized in this workstream, so authentication and
  subscription billing were not observed for any provider.
- Codex requires the official pinned `0.144.6` package, isolated ChatGPT login, and all eight real
  gates at the exact source commit and platform; the host `0.146.0` cannot substitute.
- Claude needs explicit provider/policy authority for the intended third-party managed subscription
  automation path plus its real exact matrix.
- Qwen needs an exact executable/version/platform tuple, a safe readiness mechanism, managed
  adapter acceptance, and provider confirmation that the intended autonomous/background Coding
  Plan use is permitted.
- Kimi needs an exact executable/version/platform tuple, a safe readiness mechanism, managed ACP
  acceptance, and verifiable Extra Usage disabled state or separately consented metering and cost
  cap.
- Claimed Linux support requires separate clean Linux evidence. The observed Darwin run cannot be
  generalized to another operating-system tuple.

## Verification

- Focused provider contract/registry suite: `5` files / `162` tests pass.
- Root strict TypeScript: pass.
- Root production build: pass.
- Machine-readable JSON parse and invariants: pass.

This evidence closes deterministic implementation gaps only. It does not fabricate the unavailable
external login, provider-policy, platform, billing, overage, or eight-gate observations.
