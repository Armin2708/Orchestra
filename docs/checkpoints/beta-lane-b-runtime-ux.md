# Beta Lane B remediation — providers, runtime, PTY, tools, and command center

Date: 2026-08-02

Lane: `codex/beta-runtime-ux-remediation`

Ready-marker parent: `e21b2792aa6493d21ca5e9fa56542e1a2515b6f1`

Required base: `bac8264b02d8683050cb685d7a201e0db1c3f6ed`

The supplied abbreviated base ended in `...64f`; the existing Lane B ready commit resolves to the
full SHA above (`...64b`). Remediation was based on that exact commit.

## TL;DR

Lane B remediation is complete. All ten independent P1/P2 findings were corrected, the integrated
tree passes 1,789 tests in both default-parallel and one-worker modes, and the exact code head has
an independent P0/P1/P2=0 review. Provider support was **not** promoted, backlog counts were not
changed, and no public action was taken. Real provider, Linux, browser/device, and 14-day legacy
observation evidence remain central beta blockers.

## Asked

- Remediate every independent Lane B review finding without weakening offline, evidence, identity,
  provider, or restart guarantees.
- Preserve the ready lane's deterministic behavior, use the dedicated worktree, and publish an
  auditable remediation checkpoint and marker only after complete verification.
- Keep provider support fail-closed until exact native evidence exists.

## Delivered

| Review finding | Remediation |
|---|---|
| Shell restart path was unreachable after generic lost-process reconciliation | Exact cancelling shell bindings are excluded from generic reconciliation; persisted orphan recovery now proves PID start time, executable, cwd, process-group exit, and already-gone state before persisting `stopped` |
| Tool audit actor type was falsely stored as `agent/operator` | Session routes pass the complete actor identity and persist the human/operator origin |
| Provider evidence was accepted without reading retained bytes | Recording now loads the retained artifact and verifies digest plus the exact provider/mode/version/platform/source matrix before any DB or registry mutation |
| Live capability discovery ignored durable acceptance evidence | The daemon rereads verified retained evidence for exact tuples and fails closed on missing, stale, mismatched, or tampered artifacts |
| Capability discovery did not cover every claimed provider | Credential-safe discovery now covers Claude, Codex, Qwen, and Kimi; no provider support state is promoted |
| Concurrent capability refresh could overwrite newer evidence | Monotonic generation guards prevent older refreshes from replacing current state |
| Offline read-only did not cover all Agent Home, PTY, workspace, and tool mutations | `readOnly` propagates through canonical runtime surfaces; lifecycle, create, input, resize, signal, restart, context, workspace, and tool-policy mutations fail closed while retained content remains accessible |
| Saved views did not round-trip the rendered collection | Live Open Work query and filter state is lifted into “Save current”; built-in presets are limited to truthful Ready and Blocked states |
| Saved views narrowed global search | Project projection keeps global search independent of the active collection query/filter while remaining project-scoped |
| Invalid/deleted project focus and managed profile IDs leaked or drifted | Focus is normalized, missing projects render an explicit not-found state with no cross-board fallback, Needs You is project-scoped, and all links/counts use canonical opaque `AgentProfile.id` values |

Screen-reader terminal mode and an assistive-technology-readable retained transcript were also
preserved while offline input remains disabled.

## Ordered commits

| Purpose | Source commit | Integrated commit |
|---|---|---|
| Provider remediation round 1 | `c1616f6ef216cf99e1693b16a419f19e412eb5ad` | `f5f108b1993cb6c7302b375f94e695dd2f3e5d16` |
| Runtime/audit remediation round 1 | `e84d1d4d2eba9121efc4b8c0cb362808325614b9` | `1b317a30ebdead75466d55f58665f0ad494cbbe6` |
| Command Center remediation round 1 | `fe96c5e15dcb0d70d4de58f66f6366fd86ed5559` | `9d32bbab72fda142b59ef7d3ad1fdce64e32a5b0` |
| Provider evidence/live-refresh remediation | `0301123a7cadb90e78706e751c66b6403e436fde` | `18c6cae864de5aaa23945786f1631233d3f87029` |
| Restart proof and canonical attribution | `e1cff28f4b3c3331c2451461a9cb7b21ef2e99c5` | `a68eabd66ef4c4bca6ee369c6646e1a82a627c42` |
| Offline/search/focus remediation | `52651def50308b5b32297a7a28c157ba332f60c9` | `4090c4fc1673604cb5fa9bcb2f8c7940f4998007` |
| Exact security-fixture allowlist | — | `e8adba69db51ba0de7131728d82879f27e26797b` |
| Exact allowlist CI guard | — | `e21b2792aa6493d21ca5e9fa56542e1a2515b6f1` |

## Evidence

- Environment: Node `22.20.0`, npm `10.9.3`; repository `.env` and `.env.local` are absent.
- Focused integrated seam suite: 8 files / 55 tests passed.
- Independent code review at `4090c4fc1673604cb5fa9bcb2f8c7940f4998007`: P0=0, P1=0,
  P2=0; 12 files / 74 tests passed; root and web TypeScript passed. Exact security-head delta
  review at `e21b2792aa6493d21ca5e9fa56542e1a2515b6f1`: P0=0, P1=0, P2=0; all eight
  unique fingerprints and the CI guard verified.
- Complete default-parallel suite: 204 files / 1,789 tests passed in 91.27 seconds.
- Complete one-worker suite: 204 files / 1,789 tests passed in 239.40 seconds.
- Root and web strict TypeScript: passed. Root and web production builds: passed. Vite emitted
  only its existing non-fatal large-chunk advisory.
- Dependency audit: root `--audit-level=high` passed with two inherited moderate
  `@hono/node-server` findings through `@modelcontextprotocol/sdk`; web reports zero findings.
- Gitleaks `8.30.1`: 731 commits / 26.70 MB scanned, no leaks. The allowlist contains only exact
  commit:path:rule:line fingerprints for three test idempotency values and two PEM-shaped redaction
  fixtures; its SHA-256 was stable across verification:
  `9367cd6b73c531656972da1e3f8c38a205ed050566cb3d3c1449ccedd208630a`.
- GitNexus: 12,652 nodes / 36,481 edges / 815 clusters / 264 flows. Exact-base comparison reports
  CRITICAL aggregate risk (184 changed symbols, 36 affected processes), expected for daemon,
  runtime supervisor, evidence store, Agent Home, and Command Center changes; focused, complete,
  and independent evidence above exercises those high-risk flows.
- Graphify: 7,530 nodes / 18,086 edges / 273 communities. Generated `graphify-out/` remains
  intentionally untracked.

## Provider and platform truth

| Provider | Deterministic implementation | Beta support decision |
|---|---|---|
| Claude Code | Credential-safe discovery, exact tuple validation, retained evidence verification | Unsupported until clean-profile native auth/billing/policy evidence exists |
| Codex CLI | Credential-safe discovery, exact tuple validation, retained evidence verification | Unsupported until the exact declared version and clean-profile native evidence exist |
| Qwen Code | Credential-safe discovery and fail-closed managed automation policy | Unsupported until executable/login/subscription and policy authority are evidenced |
| Kimi Code | Credential-safe discovery, ACP implementation, explicit Extra Usage consent boundary | Unsupported until login, native acceptance, overage observation, and cap evidence exist |

Observed lane host: macOS `26.5.1` / Darwin arm64. Linux evidence is not inferred. No auth cache,
credential value, publication, tag, release, provider label, or stable-promotion action was used.

## Remaining

1. Run every claimed provider tuple in a clean isolated profile and retain native auth,
   subscription billing, tool, cancellation, retry, capacity, time-budget, and artifact evidence.
2. Obtain provider-policy authority for Claude managed subscription automation and Qwen's intended
   managed execution; prove Kimi Extra Usage consent, metering, and cap behavior.
3. Repeat supported-platform acceptance on Linux.
4. Complete in-app desktop/tablet/phone browser accessibility and the real daemon-mid-session
   browser-continuation journey.
5. Complete ORC-020's 14-day zero-legacy-write observation and rollback drill before deleting any
   legacy path.
6. Resolve or centrally accept the two inherited moderate root audit advisories during retained
   artifact packaging.

## Rollback

This lane is additive and has no migration or public release action. To roll back before central
integration, omit the eight ordered commits above or revert them in reverse order, then rerun the
focused runtime/provider/Command Center suites. Do not delete retained provider evidence or user
runtime data. If a post-integration regression appears, disable the affected provider/runtime/UI
surface fail-closed and restore the prior `bac8264b02d8683050cb685d7a201e0db1c3f6ed` behavior while
preserving all SQLite state and artifacts for diagnosis.
