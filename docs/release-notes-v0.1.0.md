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

The [hosted QA-019 checkpoint](./checkpoints/2026-07-25-agent-os-hosted-qa019.md) records GitHub
Actions run `30171494794` at exact commit
`3c543b52a32109747d5f0fa1521188380c55fa93`:

- all 21 required exact-commit engineering gates passed;
- serial and default-parallel suites each passed 127 files / 890 tests;
- root and web TypeScript checks and production builds passed;
- credential-free end-to-end, package creation, retained-artifact install smoke, provider doctor,
  pinned Codex protocol, and secret-scan gates passed; and
- root and web dependency audits passed the configured high/critical threshold. This is not a
  zero-vulnerability claim.

That checkpoint proves one frozen engineering commit and its retained package bytes. It does not
prove publication, provenance, a later release head, real credentialed Claude/Codex sessions,
clean-machine install/upgrade/uninstall, or the complete desktop/phone journey.

## Remaining before release

- The master program is 123 / 373 checklist boxes delivered; 250 remain open.
- Public npm and plugin artifacts, clean-machine installation, real provider journeys, safe device
  pairing, browser/mobile acceptance, operations hardening, release documentation, tagging, and
  staged dogfood remain required.

Orchestra binds its local daemon to `127.0.0.1` and stores state under `~/.orchestra` by default.
Provider CLIs, optional tunnels, and notification services retain their own documented trust
boundaries.
