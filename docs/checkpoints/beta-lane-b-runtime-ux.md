# Beta Lane B — providers, runtime, PTY, tools, and command center

Date: 2026-08-02

Lane: `codex/beta-runtime-ux`

Required base: `0dd3dd43b9f376370ee73a9e2fe4725974caaae8`

## TL;DR

Lane B's deterministic implementation and acceptance coverage is complete: declared-provider
validation, canonical cancellation/retry/timeout/capacity behavior, durable PTY/session state,
capability-aware tool permissions, Agent Home restart recovery, and the unified command-center UI
are integrated. Provider support was **not** promoted and authoritative backlog counts were not
changed. Real clean-profile provider matrices, real daemon-to-browser continuation, browser visual
QA, and ORC-020's production observation window remain exact external evidence blockers.

## Owned backlog evidence

| Scope | Deterministic lane evidence | Gate state |
|---|---|---|
| BASE-010 | Four-provider executable/version/source/platform/auth/billing/automation/overage matrix, runtime validator, doctor integration | Implementation complete; real provider evidence open |
| ORC-014 | Canonical driver runtime policy now governs new-session retry, provider capacity, native cancellation, bounded cleanup, and durable timeouts | Deterministic acceptance pass |
| ORC-020 | Legacy retirement gate, telemetry reader, rollback contract, and explicit no-delete behavior | Open: requires 14 observed production days of zero legacy writes plus rollback evidence |
| AGT-GATE | Durable Agent Home binding and daemon-restart recovery tests preserve exact provider/workspace/session identity | Deterministic restart pass; real browser continuation externally blocked |
| PTY-005/007/012/014, PTY-GATE | Durable terminal selection/history/command ledger, stable digest key, restart recipes, direct terminal coexistence, native scope validation | Deterministic acceptance pass |
| TOOL-001/002/003/005–010/012/014, TOOL-GATE | Capability registry, per-session policy, approval/readiness/doctor surfaces, explicit unsupported states, provider-contract driver | Deterministic surfaces pass; TOOL-014 real-provider matrices open |
| UX-001/003–017, UX-GATE | Command Center Work/Agents/Discussions/Knowledge/Activity navigation, URL state, search, offline/stale truth, accessibility and responsive styles | Code/test/build pass; visual device acceptance externally blocked |
| Remaining MILE-A | Declared-provider and tool gates are fail-closed and machine validated | Summary complete; provider acceptance remains open |
| MILE-B | Agent Home restart, PTY durability, provider-native cancellation, retry/capacity/time-budget parity | Deterministic summary complete; real provider/browser evidence remains open |

## Provider truth

| Provider | Declared subscription path | Observed host evidence | Support decision |
|---|---|---|---|
| Claude Code | SDK-bundled `claude` `2.1.212`, account session, personal subscription | Ambient CLI `2.1.170`; SDK/native `0.3.212`; no isolated login; automation policy unresolved | Unsupported |
| Codex CLI | exact PATH/override `0.144.6`, ChatGPT session, personal subscription | PATH CLI `0.146.0`, so exact version fails; no isolated login | Unsupported |
| Qwen Code | Coding Plan key, subscription; managed background use policy-blocked | executable/login absent | Unsupported; raw interactive terminal remains separate |
| Kimi Code | membership OAuth; optional Extra Usage requires explicit consent/metering/cap | executable/login/overage observation absent | Unsupported; ACP transport is implementation-only and unregistered |

API execution remains a separate, visibly usage-priced secondary mode with explicit consent. There
is no subscription-to-API fallback. Mocks prove implementation behavior only, never support.

Host evidence: macOS `26.5.1` / Darwin arm64, Node `22.20.0`, npm `10.9.3`; no repository `.env` or
`.env.local` files exist. No auth cache or credential content was inspected.

## Runtime and durability evidence

- Native cancellation is distinct from interrupt and stop. A cancellation can release capacity
  only after exact attached or authorized recovered provider control is confirmed; failures and
  timeouts remain durably `cancelling` and charged to capacity.
- Retry policy authorizes the actual new-session operation. Contract-aware provider automation and
  capability differences fail closed; legacy direct drivers retain their explicit behavior.
- Job Market time budgets persist via job start time, re-arm with remaining time after daemon
  recovery, apply to managed providers, and quarantine unconfirmed cleanup.
- Terminal commands are recorded before PTY delivery, scoped to the exact workspace/session, and
  return bounded validation errors before bytes are written. The terminal digest key is created
  with restrictive mode and repaired/re-read if an existing key drifts.
- Restart requests are serialized server-side and guarded in Agent Home; session capabilities are
  cleared while a newly selected session is being resolved.

## Command-center acceptance

The application mounts the canonical Command Center as the primary project surface. Deep links
cover cards, jobs, agents, conversations, sessions, deliveries, workspaces, processes, discussions,
knowledge, and events. Top-level Organization/Roadmap/Settings navigation is URL-backed and restores
with browser history. Offline state starts fail-closed, disables content and Needs You mutations,
and is visually distinct from stale saved data. The UI includes keyboard tab navigation, skip link,
single page-level heading, live regions, reduced motion, and 44px mobile Agent Home controls.

The in-app browser inventory was exactly `[]` and initialization returned `No browser is available`.
Per the browser skill, no standalone automation fallback was used. Desktop/tablet/phone screenshot
acceptance and real daemon-mid-session → browser continuation therefore remain external blockers,
not fabricated passes.

## Verification and review

- Node `22.20.0` focused lane acceptance: 18 files / 85 tests passed before final review fixes.
- Root strict TypeScript, web strict TypeScript, root production build, and web production build:
  passed. Vite emitted only its non-fatal existing large-chunk advisory.
- Complete suite: 202 files / 1,770 tests passed.
- Graphify lane-local update: 7,486 nodes / 37,603 edges. The lane-local run intentionally follows
  the user's no-shared-checkout rule; the generated untracked export is not a source artifact.
- Independent runtime/PTY and command-center reviews reported no P0. Their P1 findings—false
  cancellation confirmation, non-durable timeout cleanup, URL/top-level history drift, duplicate
  restart requests, and offline mutation exposure—were corrected and covered by focused tests.

## Exact remaining blockers

1. Run each exact executable/source/version/platform tuple in a clean isolated provider profile,
   observe auth and subscription billing safely, and persist all eight real acceptance gates.
2. Obtain provider-policy authority for Claude managed subscription automation and Qwen intended
   execution scope; prove Kimi Extra Usage/metering/cap state.
3. Repeat supported-platform evidence on Linux; Darwin evidence cannot be generalized.
4. Provide an in-app browser runtime for desktop/tablet/phone visual checks and the real
   daemon-mid-session browser-continuation proof.
5. Complete ORC-020's 14-day zero-usage observation and rollback drill before removing any legacy
   write path.

No provider label, authoritative backlog count, legacy-write deletion, or public support claim was
changed by this lane.
