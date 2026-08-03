# Orchestra v0.1.0 — beta candidate notes

**Status: source candidate only; not published and not approved for public beta.** The package
version remains `0.1.0`, not an explicit SemVer prerelease. These notes describe the integrated
engineering candidate and do not claim provider, platform, npm, plugin, mobile, or stable support.

Orchestra is a local-first operating system for a software-development team of human-directed AI
agents. It turns product work into durable contracts, jobs, sessions, discussions, deliveries,
evidence, knowledge, and approvals while preserving real terminals, provider-native behavior,
isolated worktrees, and an auditable human release boundary.

## Candidate features

- Project command center with Work, Agents, Discussions, Knowledge, Activity, global attention,
  saved views, search, responsive navigation, and explicit offline/error states.
- Durable Agent Home with provider conversation history, real PTY, work/context/tools/usage/history,
  lifecycle controls, recovery, search, export, and exact deep links.
- Canonical contract, dependency, Job Market, assignment, scheduling, retry, cancellation, recovery,
  delivery verification, review, ShipQueue, and shipment evidence flows.
- Knowledge Compiler with bounded repository/graph retrieval, citations, freshness, prompt-injection
  defenses, managed context use, review controls, and operator UI.
- Structured Discussions, accepted-answer review, Teams, bounded planning, conflict detection,
  arbiter-separated resolution, human override, and audited integration.
- Provider-neutral capability/evidence boundaries for Claude, Codex, Qwen, and Kimi, with every
  unaccepted provider failing closed and no usage-priced API fallback.
- Secure DeviceSession remote architecture with one-time pairing, P-256-bound credentials, scopes,
  resource grants, exact step-up, selective revoke, emergency rollback, safe phone controls,
  network-only authenticated data, and generic push notifications.
- Recovery and operations controls covering daemon reconciliation, durable outbox behavior,
  backup/verify/restore, retention, redacted logs/diagnostics, rate limits, health, metrics, alerts,
  capacity, shutdown coordination, and local support-case export.
- Outcome analytics for tokens per accepted delivery, cache/context reuse, delivery speed, evidence
  gaps, retries/overrides, budgets, digests, and quality-aware dashboards.
- First-run onboarding, real lifecycle demo, provider doctor, reversible hooks, privacy-safe opt-in
  telemetry contract, support docs, and reproducible exact-source packaging.

## Verified integration evidence

- Accepted Lane A, B, C, and Lane D lineages are ancestors of the central beta branch.
- Combined code integration passed complete default-parallel and one-worker suites at 273 files /
  2,261 tests on Node `22.20.0` / npm `10.9.3`; root/web TypeScript and production builds passed.
- Independent code-integration and packaged-document reviews reported P0/P1/P2 = 0/0/0.
- The packaged-document phase passed 21 files / 123 focused tests, root/web types/builds, audits,
  Gitleaks, package inventory/source identity, GitNexus, and Graphify.
- Disposable exact-source packaging produced byte-identical 1,222,371-byte tarballs with expected
  candidate SHA-256
  `38ab73f75566fcd9977183390a53860bec135a1d5d8313033bb70e005e3a8c96`.
- Local artifact lifecycle passed, while release status correctly remained incomplete because no
  distinct signed prior artifact and trusted evidence bundle were supplied.

The post-commit approval packet must bind the resolved `[beta-release-candidate]` SHA and one
retained artifact with the exact digest above. Exact run IDs and timestamps are deliberately kept
outside tracked source so recording them cannot mutate the tested candidate.

## Known limitations and blockers

- **No managed provider is beta-supported.** Claude lacks automation-policy authority and a real
  native matrix; Codex `0.146.0` passes the exact protocol and signed-out lifecycle gates but still
  lacks the clean-profile native-subscription matrix; Qwen managed
  automation is policy-blocked without an accepted tuple; Kimi lacks native login/Extra Usage
  metering and cap evidence.
- **Platform acceptance is incomplete.** This macOS arm64 host is observed, but clean retained-
  artifact macOS/Linux lifecycle evidence is absent; Windows is unsupported.
- **Browser/mobile acceptance is incomplete.** The repaired standalone CDP harness has no passing
  final-head desktop/tablet/phone capture, the in-app Browser is untested, and exact-candidate
  iOS/Android installed-PWA evidence is absent.
- **Duration gates are incomplete.** Production-bound chaos tests do not replace the required
  long-running daemon/provider/network dogfood or 14-day legacy-write observation.
- **Metrics proof is incomplete.** Exact context-injection token totals, model acknowledgements,
  complete high-fanout/event-driven coverage, and a representative before/after quality benchmark
  remain open. No percentage token-reduction claim is made.
- **Release provenance is incomplete.** Production QA-018 and prior-artifact trust roots are empty;
  there is no distinct signed prior package, approved prerelease version, hosted exact-head CI,
  public artifact, npm provenance, tag, GitHub release, or staged beta monitoring evidence.

## Safety and data

Orchestra binds locally by default and stores its state under the configured local Orchestra home.
External provider CLIs, private/public tunnels, Web Push, optional telemetry, npm, and GitHub retain
their separate trust boundaries. Back up and restore local state explicitly; preserve worktrees
separately; never down-migrate or delete canonical evidence to simulate rollback.

See [beta release operations](./beta-release-operations.md),
[supported environments](./supported-environments.md),
[remote access security](./remote-access-security.md), and the
[candidate checkpoint](./checkpoints/beta-release-candidate.md).
