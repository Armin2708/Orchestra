# Orchestra v0.1.0

Orchestra is a local-first coordination board for Claude Code teams. Sessions
register automatically, publish scoped work, detect overlapping paths, exchange
messages, and stream their state to a live web kanban.

## Highlights

- Shared kanban, roadmap milestones, review gates, send-back notes, and approval history.
- Autonomous card launches with model, effort, and permission-mode controls.
- Independent delivery verifier plus a serialized, test-gated auto-ship queue.
- Ground-truth card-to-commit linkage, shipped history, and activity timeline.
- Installable mobile PWA, secure tunnel/QR pairing, and phone push notifications.
- Per-agent input/cache/output usage, injected-token telemetry, and a measured 50%+ compact-mode reduction with identical compliance gates.
- Manual and reset-time auto-wake for agents paused by Claude usage limits.
- Claude Code plugin marketplace install and standalone npm CLI.

## Verification

- 48 test files / 223 tests on macOS and GitHub Actions Linux.
- Backend and web TypeScript checks clean.
- CLI/web production builds, end-to-end script, and npm package dry-run pass.
- Root and web npm audits report zero vulnerabilities.

Orchestra binds to `127.0.0.1`, stores data under `~/.orchestra`, and sends no
project data to an Orchestra service.
