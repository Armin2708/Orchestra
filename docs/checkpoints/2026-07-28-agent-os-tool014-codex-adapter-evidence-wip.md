# Agent OS TOOL-014 Codex Adapter + Durable Evidence WIP Checkpoint — 2026-07-28

Status: **restart-safe work in progress**. This checkpoint preserves the second TOOL-014 slice.
It is not TOOL-014 delivery, Codex support acceptance, BASE-010 closure, or a plug-and-play claim.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/tool014-adapter-integration` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/tool014-adapter-integration` |
| Slice base | `03362e7` (`feat(agent-os): begin TOOL-014 adapter integration`) |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no `.env` file was present or assumed |
| Backlog truth | **128 / 375 delivered; 247 open**; TOOL-014 and BASE-010 remain open |
| Focused evidence | 6 files / 34 tests PASS |
| Complete evidence | 143 / 143 files and 1,179 / 1,179 tests PASS |
| Compile/diff evidence | Root TypeScript PASS; `git diff --check` PASS |
| Product status | Engineering preview; no provider support state changed |

## Delivered in this partial TOOL-014 batch

- Added the canonical Codex app-server adapter on top of the TOOL-013 contract and the existing
  `CodexAgentDriver`.
- Codex discovery resolves the actual executable, requires exact CLI `0.144.6` on
  `darwin-arm64`, hashes the executable bytes, and seals the pinned app-server protocol schema
  hash into the launch boundary.
- Codex readiness distinguishes ChatGPT subscription accounts, signed-out state, unknown account
  state, and API-key/Bedrock credential conflicts. Rate-limit exhaustion remains fail-closed.
- Model discovery, effective model/effort/access evidence, native fork delegation, approvals,
  safe structured event projection, and subscription usage/rate-limit projection are connected to
  existing Codex runtime services.
- The daemon now registers this real adapter in the support registry. Registration does **not**
  claim support: Codex still has a candidate manifest, an unsupported/unknown mode, and no real
  acceptance matrix.
- Added migration `019-provider-acceptance-evidence` and an append-only evidence store. Exact
  matrix JSON, matrix digest, artifact reference/digest, provider tuple, executable version,
  platform, source commit, observation time, and record time survive daemon restart.
- Migration 019 rejects incompatible pre-existing schemas, validates the eight-gate JSON shape,
  and prevents update/delete. Runtime hydration recomputes canonical hashes and rejects corrupted
  evidence before it reaches the registry.
- Added an AgentDriver-compatible production contract wrapper. It routes launch, follow-up,
  interrupt, stop, approvals, and structured events through the accepted adapter rather than
  performing a preflight followed by raw-driver fallback.
- A one-shot launch-request broker preserves trusted Agent Home/job metadata without allowing it
  to replace the authorized cwd, prompt, environment, model, effort, access profile, or cost
  boundary.
- Production Codex contract routing is explicitly opt-in with
  `ORCHESTRA_CODEX_PROVIDER_CONTRACT=1` plus an exact
  `ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT`. When enabled, daemon startup requires
  `ProviderAdapterRegistryV1.requireSupported(...)`; failure aborts startup and never falls back
  to the legacy Codex driver.
- TOOL-013 v1 identifies token-budget capability but does not seal a token amount in its action.
  The production wrapper therefore reports token-budget enforcement unavailable and rejects a
  token-budgeted dispatch before provider launch.

## Durable acceptance contract

Every persisted matrix remains keyed to the exact:

1. provider ID;
2. adapter ID and version;
3. mode/runtime/billing/credential tuple;
4. executable version;
5. platform;
6. source commit;
7. observation time; and
8. eight required gate results and evidence references.

The eight gates remain:

1. `executable_provenance`
2. `subscription_billing`
3. `credential_conflict`
4. `managed_lifecycle`
5. `restart_recovery`
6. `raw_terminal_coexistence`
7. `failure_semantics`
8. `credential_redaction`

No real acceptance record was created by this source/test slice.

## Observed verification

- Exact Node `22.20.0` / npm `10.9.3` complete serial suite: 143 / 143 files and
  1,179 / 1,179 tests PASS.
- Focused Codex adapter, production wrapper, durable evidence, migration, daemon, and generic
  registry gate: 6 files / 34 tests PASS.
- Root TypeScript: PASS.
- `git diff --check`: PASS.
- Migration coverage proves fresh install, exact inventory, marker-loss rerun, incompatible-schema
  rollback, append-only update/delete rejection, and JSON/column consistency.
- Evidence-store coverage proves persistence, multi-observation advancement, restart hydration,
  invalid-input rollback, immutable records, and digest-tamper rejection.
- Production-wrapper coverage proves full accepted dispatch and zero raw launches when acceptance
  is absent.
- Browser acceptance is N/A because this slice changes no route or UI surface.

## Why TOOL-014 remains open

- The Codex manifest is still `candidate`; its native-subscription mode is still unknown rather
  than supported.
- No clean-profile Codex `0.144.6` / `darwin-arm64` run has produced all eight real acceptance
  artifacts for this exact source commit.
- The opt-in production route therefore cannot pass `requireSupported(...)` yet; this is the
  intended support gate, not a shipped route.
- Authorized attach/resume and restart recovery remain explicitly unsupported in the version-1
  adapter surface, so the `restart_recovery` gate cannot pass yet.
- Token-budgeted dispatch remains blocked until an authorized token amount can be sealed and
  enforced through the contract.
- Claude remains policy-blocked for personal-subscription automation.
- Qwen Code and Kimi Code still have no managed adapters or exact real-provider matrices; their
  provider-specific subscription/automation/overage questions remain open.
- BASE-010 still requires the exact four-provider version/auth/billing/capability/OS evidence.

## Next dependency-ordered work

1. Add authorized durable resume/restart recovery to the bridge and production wrapper without
   exposing raw provider session IDs as public authority.
2. Run a clean-profile Codex `0.144.6` / `darwin-arm64` acceptance harness against this exact
   source commit and persist artifact digests for all eight gates.
3. Reconcile the Codex manifest and mode only if the real matrix passes; then enable the opt-in
   route in a controlled daemon test with rollback.
4. Decide and implement the sealed token-budget amount boundary before claiming that capability.
5. Repeat the same contract and matrix for Claude only after its policy permits automation, then
   implement Qwen and Kimi with their explicit provider blockers.
6. Keep TOOL-014, BASE-010, support labels, and 128 / 375 unchanged until the full acceptance
   evidence exists.

## Shared-main preservation

The dirty shared checkout remains on `main` and was not reset, cleaned, switched, staged, or
committed.

- `web/src/Board.tsx` expected SHA-256:
  `e7b01cdab3709c66730f5b790f767e19bb2ddca6df0dc9fe56847c9b0bf0e0e8`
- `web/src/styles.css` expected SHA-256:
  `f54f263c6fd0f76e025b602a9f8f812d6e7e1cb4ad3e6bd8ee7f2ec5621cb2ec`

## Exact resume procedure

1. Read `/Users/arminrad/Desktop/agentboard/AGENTS.md` and this checkpoint completely.
2. Use this isolated worktree and branch; never switch or create a branch in the shared checkout.
3. Verify branch, worktree, shared UI hashes, shared dirty status, Node/npm, and `.env` state.
4. Run GitNexus impact before every existing-symbol edit and `detect_changes` before commit.
5. Continue with authorized restart recovery and a real exact-source Codex acceptance harness.
6. Do not promote Codex, close TOOL-014/BASE-010, or change 128 / 375 from source-level tests.
7. Before committing, rerun the complete suite, TypeScript/build/diff gates, Graphify update,
   Vault synchronization, and shared-main preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/tool014-adapter-integration/docs/checkpoints/2026-07-28-agent-os-tool014-codex-adapter-evidence-wip.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue
TOOL-014 from branch codex/tool014-adapter-integration. Begin with authorized restart recovery,
then run the real exact-source Codex acceptance matrix. Keep TOOL-014, BASE-010, all provider
support labels, and 128/375 open until the complete real provider/version/platform matrix passes.
```
