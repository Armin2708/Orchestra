# Agent OS Lane 2 — Qwen Code and Kimi Code candidate checkpoint

Date: 2026-07-29
Branch: `codex/accel-provider-qwen-kimi`
Base: `b18181a32880eda3c51242fc07d3c3ba22bd66f2`

## TLDR

This slice adds reviewable, credential-free Qwen Code and Kimi Code adapter candidates without
enabling either provider. Executable discovery is exact and fail-closed; candidate evidence keeps
authentication unknown, makes every capability state visible, and proves that no raw driver call
can occur through the current unsupported manifests.

Qwen Coding Plan remains interactive-only for this candidate and therefore blocked for managed
foreground/background use pending provider confirmation. Kimi OAuth is not represented as proof of
zero overage: Extra Usage, metering, cost-cap enforcement, and its separate consent remain
unresolved.

## Scope and ownership

This branch adds only the five Lane 2-owned files:

- `src/runtime/drivers/terminal-provider-discovery.ts`
- `src/runtime/drivers/qwen-provider-adapter.ts`
- `src/runtime/drivers/kimi-provider-adapter.ts`
- `test/qwen-kimi-provider-adapters.test.ts`
- `docs/checkpoints/2026-07-29-agent-os-lane2-qwen-kimi-candidate.md`

It does not edit provider manifests, reserved manifest fingerprints, the adapter registry, runtime
driver indexes, server wiring, package metadata, the master backlog, Graphify output, or the
Obsidian vault.

## Candidate implementation

### Shared terminal discovery

`discoverTerminalProviderExecutableV1`:

- validates its manifest through `defineProviderManifestV1` before using it;
- resolves only explicit command/PATH candidates without a shell;
- canonicalizes the result with `realpath`, requires an executable regular file, and hashes the
  actual executable bytes with SHA-256;
- runs only `--version`, with a 3-second timeout and a minimal environment limited to
  PATH/platform/locale variables;
- extracts one unambiguous semantic version from bounded output;
- reports `missing`, `unknown`, `untrusted`, `incompatible`, or `validated` rather than inferring
  readiness;
- rejects an unapproved command override as untrusted;
- redacts credential-shaped paths and never returns raw version output or caught error messages;
- treats Qwen/Kimi installations as incompatible until their canonical manifests contain an exact
  validated version/platform tuple.

The candidate evidence builder also validates the manifest and discovery object, rejects
cross-provider or inconsistent validated evidence, derives policy/overage signals from the
selected canonical mode, fixes authentication at `unknown`, and exposes all 24 capability states.

### Qwen Code

| Evidence | Candidate result |
| --- | --- |
| Default executable | `qwen` |
| Default mode | `native_subscription` |
| Billing | `personal_subscription` |
| Credential classification | `subscription_scoped_key` |
| Authentication | `unknown`; no credential or profile read |
| Automation | `interactive_only` |
| Managed foreground/background | blocked by `interactive_only` |
| Overage | `not_applicable` for the declared Coding Plan mode |
| API mode | `native_api_key`; explicit selection plus API consent required |
| API fallback | none |
| Managed transport | deliberately not implemented |

The adapter constructor can expose discovery and contract-shaped unknown readiness, but model
discovery, launch transport, and session evidence deliberately throw if a future central change
were to bypass the current contract gates.

### Kimi Code

| Evidence | Candidate result |
| --- | --- |
| Default executable | `kimi` |
| Default mode | `native_subscription` |
| Billing | `personal_subscription` |
| Credential classification | `provider_account_session` |
| Authentication | `unknown`; OAuth/profile state is not probed |
| Automation | `allowed` in the canonical manifest, but provider remains unsupported |
| Extra Usage | `unknown` |
| Extra Usage consent | `missing` and separate from OAuth |
| Metering/cost-cap evidence | `unknown` |
| API mode | `native_api_key`; explicit selection plus API consent required |
| API fallback | none |
| Managed ACP transport | deliberately not implemented |

The candidate therefore cannot convert an OAuth signal into a zero-overage claim. A separately
visible, durable Extra Usage consent and a real metering/cost-cap authority remain prerequisites.

## Capability and lifecycle evidence

The candidate evidence contains an entry for every canonical capability ID.

- Qwen and Kimi retain only `raw_terminal_coexistence: supported`.
- `attach`, `resume`, and `restart_recovery` remain explicitly unsupported.
- Kimi `token_budget` and `cost_budget` remain explicitly unsupported.
- Launch, follow-up, fork, interrupt, cancel, stop, model discovery/selection, effort, approvals,
  access profiles, structured events, usage, rate limits, MCP, plugins, skills, and hooks remain
  unknown rather than inferred.
- Adapter gateway tests exercise environment preparation, model listing, launch authorization,
  interrupt, cancel, stop, approvals, event streaming, and usage. Raw driver counters remain zero.

No model, effort, or effective access profile is fabricated. No resume, cancellation, event,
usage, approval, MCP, plugin, or skill claim is made from CLI help text alone.

## Local host evidence

The worktree had no `.env` or `.env.*` file at depth two, so no project environment file existed
to source. The verified toolchain was Node `v22.20.0` and npm `10.9.3`.

On this host:

```text
qwen_path=not-found
kimi_path=not-found
```

No clean-profile authentication test was attempted. The absence of the executables and the lack of
an authorized test account mean real authentication, quota, billing, model, event, usage, resume,
and cancellation behavior all remain unverified.

## Verification

- `npm exec vitest -- run test/qwen-kimi-provider-adapters.test.ts`
  - 1 file passed
  - 10 tests passed
- `npm exec tsc -- --noEmit`
  - passed
- `npm run build`
  - passed; `dist/cli.js` built successfully
- `npm test`
  - non-authoritative, inadvertently broad Lane 2 run: 160 files passed, 1,259 tests passed
  - the first run reached 1,236 passing tests but three UI suites could not import `react` because
    the fresh worktree lacked `web/node_modules`; `npm ci --prefix web` restored the lockfile-pinned
    dependencies and the clean rerun passed
  - Lane 1 still owns and must run the authoritative exact-head serial/default integration suites
- Gitleaks `8.30.1`, directory mode with redaction, run separately on all five owned files
  - no leaks found

## Code-intelligence checks

The worktree was indexed at the exact base before implementation. GitNexus impact analysis on the
only consumed shared bridge seam, `defineAgentDriverProviderAdapterV1`, reported HIGH upstream
risk: 3 direct dependents, 12 total dependents, 2 affected process families, and 4 modules. The
shared seam was not modified; both candidates only consume it from new files.

After reindexing the worktree with the new files, GitNexus `detect_changes(scope: "all")` reported:

- 5 changed files;
- 86 changed symbols/sections;
- 0 affected execution processes;
- LOW risk.

No existing production symbol or process was changed. The result is consistent with the intended
new-file-only candidate scope.

## Central integration still required

These candidate files are intentionally not exported or registered. A central integration change
must remain separate and must not proceed until evidence closes the provider-specific blockers:

1. Install each CLI in an isolated clean profile and record exact executable version, platform,
   provenance, authentication, and billing evidence.
2. Complete the provider environment-variable ownership/conflict audit.
3. Validate a real managed transport and capability matrix, including effective
   model/effort/access, approvals, structured events, usage, interruption, cancellation, and
   recovery.
4. Obtain provider confirmation before allowing autonomous/background Qwen Coding Plan use.
5. Add explicit Kimi Extra Usage detection, separate durable consent, metering, and enforced cost
   caps.
6. Only then update canonical manifests and reserved fingerprints, register/export the adapters,
   wire runtime/server paths, and run the provider acceptance harness.

## Claims deliberately not made

- Neither Qwen Code nor Kimi Code is a supported or candidate-release managed provider.
- No version/platform tuple is validated.
- No account is authenticated and no credential is read, stored, logged, or forwarded.
- No Coding Plan background-use permission is inferred.
- No Kimi zero-overage state is inferred from OAuth.
- No provider API is selected without explicit opt-in, and no API fallback exists.
- No live managed CLI/ACP transport is implemented.

## Source references

The provider policy remains the one already documented in
`docs/provider-subscription-strategy.md`, which links the official Qwen Code repository and
authentication/Coding Plan documentation plus the official Kimi Code repository, CLI, and
membership/Extra Usage documentation. Current CLI surface checks used the official Qwen Code and
Kimi Code documentation through Context7; help text was treated as discovery input, not support
evidence.
