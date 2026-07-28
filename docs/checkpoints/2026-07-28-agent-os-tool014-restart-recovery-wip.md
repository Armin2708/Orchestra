# Agent OS TOOL-014 Authorized Restart Recovery WIP Checkpoint — 2026-07-28

Status: **restart-safe work in progress**. This checkpoint preserves the third TOOL-014 slice.
It is not TOOL-014 delivery, Codex support acceptance, BASE-010 closure, or a plug-and-play claim.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/tool014-adapter-integration` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/tool014-adapter-integration` |
| Slice base | `c6b12f4` (`feat(agent-os): wire Codex provider acceptance`) |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no `.env` file was present or assumed |
| Backlog truth | **128 / 375 delivered; 247 open**; TOOL-014 and BASE-010 remain open |
| Focused evidence | 5 files / 123 tests PASS; 11 recovery-adjacent files / 204 tests PASS |
| Complete evidence | 143 / 143 files and 1,183 / 1,183 tests PASS |
| Compile/diff evidence | Root TypeScript PASS; `git diff --check` PASS |
| Product status | Engineering preview; no provider support state changed |

## Delivered in this partial TOOL-014 batch

- Extended the version-1 resume action so its single-use authorization seals the provider-session
  identity, Agent OS workspace scope, cwd, requested model, effort, access ceiling, and cost
  boundary.
- Enabled `resume` and `restart_recovery` only as a paired implementation capability. Raw
  `attach(providerSessionId)` remains explicitly unsupported by the provider contract.
- Added a validated gateway resume path with executable recheck, one-time authorization
  consumption, gateway-assigned session identity, provider-session/configuration validation,
  bounded cleanup, and normal event/control registration.
- Extended the capability-aware `AgentDriver` bridge with authorized resume while continuing to
  reject any supported capability the underlying driver cannot implement.
- Added a distinct optional durable `AgentDriver.recover(...)` seam. Agent OS prefers it during
  daemon reconciliation and supplies only its persisted job/session/workspace binding; existing
  raw drivers retain their legacy internal attach behavior.
- Added Codex recovery target authorization. The adapter requires the exact active workspace/cwd,
  calls the existing app-server `thread/resume` plus `thread/read` driver path only inside the
  consumed authorization, restores durable model/effort/access overrides, and detaches on any
  local binding or restoration failure.
- Added production-wrapper recovery. The wrapper re-runs executable discovery, registry
  `requireSupported(...)`, readiness, environment, and capability authorization before native
  recovery, then resumes structured event pumping under a new managed session identity.
- Codex's canonical native-subscription manifest now truthfully declares resume/restart recovery
  implemented. The provider remains `candidate`, the mode remains `unknown`, and no exact
  acceptance matrix exists, so production support remains fail-closed.

## Security and authority boundary

The durable provider ID alone is not resume authority. A successful recovery requires all of:

1. a current durable Agent OS job/session/workspace binding;
2. the exact active workspace and cwd;
3. the persisted model, effort, and access ceiling;
4. current executable/configuration/environment/readiness evidence;
5. paired `resume` plus `restart_recovery` capability declarations;
6. an unconsumed short-lived provider action authorization; and
7. the exact provider/version/platform/source-commit eight-gate acceptance record.

The first six are implemented and source-tested. The seventh is intentionally absent for the
canonical Codex tuple, so the opt-in production route still cannot enable.

## Observed verification

- Exact Node `22.20.0` / npm `10.9.3` complete serial suite: 143 / 143 files and
  1,183 / 1,183 tests PASS.
- Focused contract/bridge/wrapper/Codex/Agent OS recovery suite: 5 files / 123 tests PASS.
- Wider daemon, migration, assignment, Agent Home, and recovery suite: 11 files / 204 tests PASS.
- Root TypeScript and `git diff --check`: PASS.
- Recovery tests prove single-use authorization, sealed configuration/access, raw attach
  rejection, zero native recovery without acceptance, and Agent OS preference for the durable
  recovery seam.
- Browser acceptance is N/A because this slice changes no route or UI surface.

## Real acceptance status

The clean exact-tuple matrix has **not** run and no record was persisted.

- Required tuple: Codex CLI `0.144.6`, `darwin-arm64`, ChatGPT subscription account, exact source
  commit containing this slice.
- Current host CLI: `0.145.0`.
- `npm run check:codex-protocol` correctly fails closed before schema comparison.
- `orchestra doctor --provider codex --json` reports the CLI unsupported and deliberately skips
  login probing.

Do not widen the supported version range or use the intentional unsupported-version comparison as
acceptance evidence.

## Why TOOL-014 remains open

- No clean-profile Codex `0.144.6` / `darwin-arm64` run has produced all eight real acceptance
  artifacts for this exact source commit.
- The Codex manifest is still `candidate`; its native-subscription mode is still `unknown`.
- The opt-in production route therefore cannot pass `requireSupported(...)`.
- Token-budgeted contract dispatch remains blocked until an authorized token amount is sealed.
- Claude remains policy-blocked for personal-subscription automation.
- Qwen Code and Kimi Code still have no managed adapters or exact real-provider matrices.
- BASE-010 still requires the exact four-provider version/auth/billing/capability/OS evidence.

## Next dependency-ordered work

1. Build and run the clean-profile Codex `0.144.6` / `darwin-arm64` acceptance harness against the
   exact source commit and persist artifact digests for all eight gates.
2. Reconcile the Codex provider/mode only if the real matrix passes, then run the opt-in
   production route with rollback coverage.
3. Define and enforce a sealed token-budget amount before claiming that capability.
4. Repeat the contract/matrix for Claude only after its policy permits automation, then implement
   Qwen and Kimi with their explicit provider blockers.
5. Keep TOOL-014, BASE-010, support labels, and 128 / 375 unchanged until the complete evidence
   exists.

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
5. Continue with the real exact-source Codex acceptance harness; never treat synthetic fixtures or
   the unsupported-version comparison as acceptance.
6. Do not promote Codex, close TOOL-014/BASE-010, or change 128 / 375 without the complete real
   provider matrix.
7. Before committing, rerun the complete suite, TypeScript/build/diff gates, Graphify update,
   Vault synchronization, and shared-main preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/tool014-adapter-integration/docs/checkpoints/2026-07-28-agent-os-tool014-restart-recovery-wip.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue
TOOL-014 from branch codex/tool014-adapter-integration. Begin with the real clean-profile Codex
0.144.6/darwin-arm64 exact-source acceptance harness. Keep TOOL-014, BASE-010, all provider support
labels, and 128/375 open until the complete real provider/version/platform matrix passes.
```
