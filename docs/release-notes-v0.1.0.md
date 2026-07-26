# Orchestra v0.1.0 — engineering preview

**Status: not published and not release-ready.** These notes describe the current engineering
preview for Claude Code and Codex users, not a public v0.1.0 release. As verified on 2026-07-25,
the public npm registry returns `E404` for `orchestra-board`, and both provider hook manifests
depend on `orchestra-board@0.1.0`; npm, `npx`, and public plugin installation therefore do not
work yet.

Orchestra is a local-first coordination board where Claude Code and Codex sessions can register,
publish scoped work, detect overlapping paths, exchange messages, and stream state to a live web
kanban.

## Implemented preview

- Shared kanban, roadmap milestones, review gates, send-back notes, and approval history.
- Autonomous card launches with provider, model, effort, and access controls.
- Independent delivery verification, a serialized test-gated auto-ship queue, shipped-commit
  history, and an activity timeline.
- A mobile PWA, tunnel/QR flow, and phone notifications as a **functional beta only**. The current
  QR flow grants a reusable master operator token and does not yet provide named, scoped, expiring,
  individually revocable device sessions or step-up protection. It is not a safe remote beta; see
  the [remote/mobile threat model](./remote-mobile-threat-model.md).
- Per-agent usage accounting and compact-context mechanisms. The controlled quality-and-token
  benchmark remains open, so this preview makes no percentage-reduction claim.
- Manual and reset-time auto-wake for agents paused by Claude usage limits.
- Reversible Claude and Codex hook installation logic and bundled manifests are present in source.
  Public plugin installation remains unavailable until the package is published and clean-install
  gates pass.

## Verification

The
[exact-head functional checkpoint](./checkpoints/2026-07-26-agent-os-exact-head-95d11d5.md)
records combined local evidence at exact commit
`95d11d5892523b0f742eb098563ba92b13e65ba4`:

- serial and default-parallel Node 22.20.0 suites each passed 134 files / 979 tests, and the focused
  combined gate passed 31 files / 288 tests;
- root and web TypeScript checks, root and web production builds, and credential-free end-to-end
  smoke passed;
- in-app Browser inventory was exactly `[]`. The explicitly labeled Playwright fallback passed the
  full desktop/phone assignment and Agent Home journey at `35b68fe`; at `95d11d5` it directly
  rechecked drawer containment, the deep link, all seven phone workspace panes, real PTY
  input/output, bounded Stop, restart with a new PID, zero console errors, and all observed APIs
  returning `200`. This fallback does not close `QA-013`;
- the 35-file, 616,570-byte `orchestra-board@0.1.0` tarball had SHA-256
  `4a6fdf21238ba8d82e890cc4413f472db28c01c08f0f96a28e07aafc143393d4`, and isolated
  clean-consumer install, CLI/version/help, and doctor diagnostic smoke behaved as expected;
- Claude readiness passed, while overall both-provider readiness intentionally remained
  unsupported because installed Codex `0.145.0` correctly failed closed against the pinned
  supported `0.144.6` protocol; and
- clean-consumer audit reported four moderate dependency nodes from one transitive Hono advisory,
  with zero high or critical findings. This is not a zero-vulnerability claim.

Independent read-only combined and CSS-delta regression/security reviews passed in this
orchestration session; no retained reviewer artifact was produced. The earlier
[hosted QA-019 checkpoint](./checkpoints/2026-07-25-agent-os-hosted-qa019.md) remains the hosted
evidence for `3c543b52a32109747d5f0fa1521188380c55fa93`; neither checkpoint proves
publication, provenance, a release tag, real credentialed Claude/Codex journeys,
clean-machine install/upgrade/uninstall, or the complete intended Browser journey.

## Remaining before release

- The master program is 126 / 373 checklist boxes delivered; 247 remain open. This exact-head
  reconciliation newly closes only `JOB-010`, `PKG-002`, and `PKG-005`; milestone summaries remain
  unchanged at 2 / 15.
- `QA-001` remains open because the added tests do not cover every state machine; `QA-013` remains
  open because the intended desktop/tablet/phone Browser matrix was unavailable; and `TOOL-010`
  remains open because the readiness doctor does not yet verify installed hook state.
- Public npm and plugin artifacts, clean-machine installation, real provider journeys, safe device
  pairing, browser/mobile acceptance, operations hardening, release documentation, tagging, and
  staged dogfood remain required.

Orchestra binds its local daemon to `127.0.0.1` and stores state under `~/.orchestra` by default.
Provider CLIs, optional tunnels, and notification services retain their own documented trust
boundaries.
