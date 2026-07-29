# Agent OS Lane 2 provider-compatibility candidate

Date: 2026-07-29

## TL;DR

Lane 2 produced a reviewable, fail-closed provider-compatibility candidate for
Claude, Qwen, and Kimi while preserving the existing Codex path. This is
evidence infrastructure, not completion of `TOOL-014` or `BASE-010`.

No provider support label, backlog checkbox, acceptance state, or durable
compatibility claim is promoted by this candidate. Real authenticated
subscription evidence across the exact eight-gate matrices remains required.

## Authority and isolation

- Exact recovery base:
  `b18181a32880eda3c51242fc07d3c3ba22bd66f2`
- Lane branch: `codex/accel-provider`
- Lane worktree:
  `/Users/arminrad/.codex/worktrees/agentboard/accel-provider`
- Shared checkout was not switched, rebased, committed, or edited.
- No `.env` files exist in the lane worktree.
- Required local test toolchain was loaded explicitly:
  Node `22.20.0`, npm `10.9.3`.
- No raw provider credential, token, login file, or secret value was inspected,
  copied, logged, or placed in a prompt.

## Candidate commits

Lane 2 integrated the bounded implementor commits in this order:

1. Original Claude/Codex candidate
   `4c3681d922e2c3e4039edc29c68e22b6aaab11a6`
   became Lane 2 commit
   `063f4f1f825a0aef0d97e8bcf8f0ccbdc94d4a69`.
2. Original Qwen/Kimi candidate
   `fa595a21a569a5916dcf878700ddc6a486a13ad8`
   became Lane 2 commit
   `0d67dc58b58a5e632d38a3dc73f891c61536b3aa`.

Lane 1 must cherry-pick the Lane 2 hashes, not the implementor-worktree hashes,
and preserve this order.

## Files in the integrated implementation candidate

- `src/runtime/drivers/claude-provider-adapter.ts`
- `src/runtime/drivers/terminal-provider-discovery.ts`
- `src/runtime/drivers/qwen-provider-adapter.ts`
- `src/runtime/drivers/kimi-provider-adapter.ts`
- `test/claude-provider-adapter.test.ts`
- `test/qwen-kimi-provider-adapters.test.ts`
- `docs/checkpoints/2026-07-29-agent-os-lane2-claude-codex-candidate.md`
- `docs/checkpoints/2026-07-29-agent-os-lane2-qwen-kimi-candidate.md`

This checkpoint is the ninth changed file.

## Backlog truth

- Recovery baseline: `137 / 375` delivered; `238` open.
- `TOOL-014`: partial/open.
- `BASE-010`: partial/open.
- Completed backlog IDs in this work block: none.
- Partially advanced backlog IDs: `TOOL-014`, `BASE-010`.

## Implemented evidence behavior

### Claude

- Discovers only the SDK-bundled executable identity; it does not silently
  select an ambient `PATH` executable.
- Runs version discovery with a minimal, credential-free environment.
- Separates discovery/version evidence from the auth-status probe.
- Distinguishes missing/unparseable version evidence (`unknown`) from a parsed
  but non-exact version (`incompatible`).
- Treats native Claude subscription identity as the only ready subscription
  state; API-key conflicts remain fail-closed.
- Produces deterministic, source-bound configuration evidence.
- Redacts or suppresses thinking, user content, and raw tool results from
  normalized event output.
- Keeps fork fields sealed and clears live session bindings on stop and natural
  terminal completion.
- Leaves resume, restart, attach, and production support registration
  unsupported.

### Codex

- The existing Codex implementation was not edited.
- This lane preserves subscription-first behavior and does not introduce API
  fallback.
- Support remains gated by exact validated evidence; the host's nearby version
  is not treated as compatible.

### Qwen and Kimi

- Share a generic, capability-aware terminal discovery/evidence layer.
- Resolve direct executable paths without a shell, enforce executable
  provenance, parse exact semantic versions, bound probe time/output, and hash
  executable bytes.
- Use a minimal discovery environment without API/OAuth credentials.
- Validate provider manifests and execution-scope/capability claims.
- Keep subscription execution fail-closed when automation terms, auth,
  overage, metering, cost caps, or required capabilities are unknown.
- Require explicit consent for API-mode evidence and prohibit automatic
  subscription-to-API fallback.
- Do not launch the raw driver when any support gate is unsupported.
- Do not register either provider as supported.

## Credential-free host evidence

The lane did not authenticate or inspect account files.

- Direct host lookup found Claude `2.1.220` and Codex `0.146.0`.
- Qwen and Kimi executables were not found.
- With the required Node 22 toolchain, compatibility-only doctor evidence found:
  - Codex `0.146.0` is unsupported against the exact validated version
    `0.144.6`.
  - The managed Claude SDK/native package `0.3.212` and bundled CLI `2.1.212`
    validate.
  - The ambient Claude selected by that toolchain was `2.1.170` and remained
    experimental.
- No authenticated provider state was claimed from these checks.

## Exact verification

On the integrated Lane 2 head before this documentation-only checkpoint:

- Focused provider/contract suite: `17` files, `268` tests passed.
- Source TypeScript check: passed.
- Standalone strict TypeScript check for both candidate test files: passed.
- Production build: passed.
- `git diff --check` from the exact recovery base: passed.
- Gitleaks `8.30.1`, redacted no-git scan of all nine changed files: passed.
- GitNexus compare against the exact recovery base: `8` implementation/doc
  files, `188` changed symbols, `0` affected execution processes, `LOW` risk.
- Lane-local Graphify structural refresh: `5,881` nodes, `13,648` edges,
  `243` communities. The semantic document refresh and its final evidence are
  published in the external Lane 2 status file.

One bounded implementor inadvertently ran a broad `npm test` before handoff:
`160` files and `1,259` tests passed. This is non-authoritative Lane 2 evidence,
does not replace Lane 1's serial/default suites, and must not be used to close
any acceptance gate.

## Impact and diff hygiene

Pre-edit GitNexus impact analysis for
`defineAgentDriverProviderAdapterV1` returned `HIGH` risk: `3` direct and `12`
total upstream dependents, `2` process families, and `4` modules. Lane 2 did
not edit that shared bridge.

Pre-edit impact analysis for `ClaudeAgentDriverAdapter` returned a `MEDIUM`
lower bound with `8` direct and `44` total upstream dependents. Lane 2 did not
edit that existing class.

All implementation changes are new files. Central registration, export, and
Conductor edits are deliberately reserved for Lane 1 after exact-head review.

## Central integration edits required

Lane 1 owns any central edits. The current candidate requires:

1. Review and, only where exact evidence permits, add central exports/indexes.
2. Wire Claude Conductor callbacks without weakening the shared bridge or
   support gate.
3. Keep Qwen/Kimi transport integration out until a real transport and the
   exact subscription automation evidence exist.
4. Add manifest/reserved-fingerprint/environment-conflict data only from real
   exact provider evidence.
5. Keep every new provider unregistered as supported until the exact
   eight-gate acceptance matrices and durable evidence pass.
6. Run the authoritative complete serial/default suites after integrating the
   exact candidate head.

## Blockers

- Claude subscription automation through a third-party orchestration product
  requires product/legal confirmation against Anthropic's current account and
  third-party-use terms.
- Codex still needs a clean profile pinned to `0.144.6`, interactive
  subscription login, and the full exact eight-gate matrix; the current host
  version is `0.146.0`.
- Qwen/Kimi binaries and interactive subscription logins are unavailable in
  this lane.
- Qwen Coding Plan terms need confirmation for the intended automated,
  non-interactive Orchestra execution model.
- Kimi Extra Usage is a separate fallback/billing path and requires explicit
  consent plus verified metering and cost-cap behavior.
- Clean macOS and Linux evidence environments remain required. iOS/Android
  browser evidence is additionally required if remote/mobile work enters
  scope.

## Current provider-policy references

- Claude account login and third-party-use policy:
  <https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account>
- Claude API-key environment precedence:
  <https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code>
- Claude Code CLI/auth reference:
  <https://code.claude.com/docs/en/cli-usage>
- Qwen Coding Plan terms:
  <https://www.alibabacloud.com/help/en/model-studio/coding-plan>
- Qwen authentication:
  <https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/>
- Qwen headless execution:
  <https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/>
- Kimi CLI authentication:
  <https://www.kimi.com/help/kimi-code/cli-getting-started>
- Kimi Extra Usage:
  <https://www.kimi.com/help/kimi-code/benefits>
- Kimi ACP surface:
  <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html>

## Next dependency-ready task

Lane 1 should cherry-pick the three ordered Lane 2 commits published in
`/Users/arminrad/.codex/agentboard-sprint/lane-2.md`, perform the central review,
and run the authoritative exact-head serial/default suites. In parallel, the
resource owner should provide clean isolated provider installations and
interactive subscription logins without exposing credentials to any session.
