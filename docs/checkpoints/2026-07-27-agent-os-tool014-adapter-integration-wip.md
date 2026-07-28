# Agent OS TOOL-014 Adapter Integration WIP Checkpoint — 2026-07-27

Status: **restart-safe work in progress**. This checkpoint preserves the first TOOL-014
capability-aware adapter integration slice. It is not TOOL-014 delivery, provider acceptance,
BASE-010 closure, or a public plug-and-play claim.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/tool014-adapter-integration` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/tool014-adapter-integration` |
| Base | `a66f1a1ad1c578b6bc661353397379b61faf71ac` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no `.env` file was present or assumed |
| Backlog truth | **128 / 375 delivered; 247 open**; TOOL-014 and BASE-010 remain open |
| Focused evidence | 9 files / 78 tests PASS; 5 provider-contract/integration files / 131 tests PASS |
| Complete evidence | 140 / 140 files and 1,167 / 1,167 tests PASS serially |
| Compile/build evidence | Root, standalone strict-test, and web TypeScript PASS; root/web production builds PASS |
| New-file hashes | environment `2a393301f503f9c7b2f85b48adf0eb9daeb4219f6767f933924c5f0bb9b20621`; registry `12bc22473c183b3982bc6d0ca223710dcbe85c4050e39a0d2e8eaa40c1f8e9d3`; bridge `71647d6bb05f66608f41ee11b0bd7229323ce8e087a0c2611852ace064d067fa`; tests `7fddade5c370c9d9825dfaa1a560c5df16be304340f9df55ead0fb7c53b93e7f` |
| Product status | Engineering preview; no provider support state changed |

## Asked

Continue from the delivered TOOL-013 provider contract, preserve the dirty shared checkout, and
begin TOOL-014 by integrating capability-aware managed adapters for Claude Code, Codex CLI, Qwen
Code, Kimi Code, and every future declared terminal agent without claiming support before one
shared acceptance matrix passes.

## Delivered in this partial TOOL-014 batch

- Added a generic bridge from the existing `AgentDriver` interface into the version-1 provider
  contract.
- The bridge rejects manifest capabilities that its driver/options cannot implement and maps
  launch, follow-up, fork, interrupt, cancel, stop, approval, structured events, and usage through
  gateway-assigned identities.
- Adapter-supplied launch requests cannot replace the authorized cwd, prompt, environment, model,
  effort, access profile, permission mode, cost boundary, or resume identity.
- Driver-internal and provider-native session IDs remain private bridge state while the
  gateway-assigned ID remains the public control/event identity.
- Added one Agent OS support-claim registry for the four canonical declarations and future
  manifests.
- A support claim now requires the exact provider, adapter/version, mode, runtime, billing,
  credential, executable-version, platform, and source-commit tuple, with all eight gates passed
  and linked to evidence.
- Wired the registry into Agent OS composition without registering a canonical adapter or changing
  the existing production dispatch path.
- Applied TOOL-013 environment preparation at the existing Claude and Codex native spawn
  boundaries. Managed personal-subscription launches strip declared usage-priced and
  cross-provider credential/endpoint conflicts before process creation.

## The common acceptance gate

Every current or future declared provider must pass these exact gate IDs:

1. `executable_provenance`
2. `subscription_billing`
3. `credential_conflict`
4. `managed_lifecycle`
5. `restart_recovery`
6. `raw_terminal_coexistence`
7. `failure_semantics`
8. `credential_redaction`

The registry rejects extra/missing matrix fields, malformed evidence, a declaration mismatch,
duplicate or stale evidence for the same tuple, incomplete gates, undeclared versions/platforms,
and evidence from another source commit.

## Observed verification

- Exact Node `22.20.0` / npm `10.9.3` complete serial suite: 140 / 140 files and 1,167 / 1,167
  tests PASS.
- Focused runtime/security gate: 9 files / 78 tests PASS.
- Combined provider-contract/integration gate: 5 files / 131 tests PASS.
- Root TypeScript: PASS.
- Standalone strict TypeScript for the new integration test: PASS.
- Web TypeScript: PASS.
- Root `tsup` and web Vite production builds: PASS.
- Gitleaks `8.30.1` per-file scans: PASS.
- `git diff --check`: PASS.
- Browser acceptance: N/A for this slice's UI surface because no route or web file changed. Real
  provider runtime acceptance is still required and is explicitly open.

The first complete-suite attempt inherited Node 22 for the test process but allowed a child npm
probe to resolve the host's npm 11. The product correctly failed that unsupported tuple. Re-running
with the exact Node 22/npm 10 PATH passed completely; no product code was weakened to hide the
toolchain mismatch.

## GitNexus critical review boundary

Impact analysis was run before every existing symbol edit. `Conductor.hire` was formally HIGH
risk (six direct callers, nine affected symbols, three modules), so its credential-boundary change
received focused launch and driver coverage. Other existing edits reported LOW or MEDIUM risk.

After re-indexing, GitNexus resolved the new bridge symbol to hundreds of unrelated methods and
reported a formally **CRITICAL** blast radius: 702 affected symbols, 512 direct, 56 processes, and
20 modules. Direct source search shows the bridge is exported once and constructed only in the new
integration test. The graph result is therefore retained as a critical manual-review boundary,
not accepted as evidence that the change is low risk and not represented as a real production
call graph.

After the final full Graphify/GitNexus refresh, the required staged `detect_changes` included all
16 intended files and reported HIGH risk: 21 changed symbols and 10 affected execution flows. The
required comparison against shared `main` included the preceding TOOL-013 commits as well as this
slice and reported 21 files, the same 21 changed symbols, and the same 10 affected flows. The
affected flows are the expected launch/wake, daemon serve, and driver event paths; the earlier
new-bridge symbol-resolution corruption remains recorded above and is not represented as
trustworthy low-risk evidence.

## Why TOOL-014 remains open

- No Claude, Codex, Qwen, or Kimi version-1 adapter is registered in the support registry.
- Production job dispatch still uses the existing `AgentDriver` registry instead of requiring
  `requireSupported(...)`.
- Acceptance matrices are in memory only; no durable, provenance-verified evidence store exists.
- No real clean-profile provider/version/platform tuple has passed all eight gates.
- Restart rehydration, real provider resume/fork/approval/usage behavior, and daemon recovery are
  not proven through the bridge.
- Claude's declared personal-subscription automation policy remains blocked.
- Codex remains a candidate, and Qwen Code/Kimi Code remain unsupported managed providers.
- Qwen autonomous/background Coding Plan permission and Kimi Extra Usage consent/cap behavior
  remain unresolved.

## Next dependency-ordered work

1. Define and register the real Codex bridge using the exact app-server version/protocol boundary.
2. Route one production managed-launch path through the support registry without bypass or
   provider/billing fallback.
3. Persist acceptance evidence with source-commit and artifact provenance.
4. Exercise restart recovery and the complete eight-gate matrix for that exact tuple.
5. Repeat the same contract for Claude only after its automation policy is allowed, then Qwen and
   Kimi only after their provider-specific blockers close.
6. Keep TOOL-014, BASE-010, support labels, and the 128 / 375 backlog count unchanged until the
   complete acceptance evidence exists.

## Shared-main preservation

The dirty shared checkout remains on `main` and was not reset, cleaned, switched, staged, or
committed.

- `web/src/Board.tsx` SHA-256:
  `e7b01cdab3709c66730f5b790f767e19bb2ddca6df0dc9fe56847c9b0bf0e0e8`
- `web/src/styles.css` SHA-256:
  `f54f263c6fd0f76e025b602a9f8f812d6e7e1cb4ad3e6bd8ee7f2ec5621cb2ec`
- Shared checkout status: `main` ahead of `origin/main` by 151 commits, with those two tracked user
  changes and the pre-existing `.codex/`, screenshots, and `graphify-out/` untracked.

## Exact resume procedure

1. Read `/Users/arminrad/Desktop/agentboard/AGENTS.md` and this checkpoint completely.
2. Use this isolated worktree and branch; do not switch or create a branch in the shared checkout.
3. Verify the base, branch, new-file hashes, shared UI hashes, and dirty shared status above.
4. Recreate only the temporary `node_modules` and `web/node_modules` symlinks if missing.
5. Verify Node `22.20.0`, npm `10.9.3`, and the absence or intentional sourcing of `.env` files.
6. Run GitNexus impact before each existing symbol edit. Treat the corrupted new-symbol graph as a
   CRITICAL review boundary until a manually verified re-index disproves it.
7. Continue with the real Codex adapter and durable exact-tuple evidence; do not promote support or
   close TOOL-014/BASE-010 from source-level tests.
8. Before committing, run the complete suite, TypeScript/build/secret/diff gates, GitNexus
   `detect_changes`, Graphify update, Vault synchronization, and shared-main preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/tool014-adapter-integration/docs/checkpoints/2026-07-27-agent-os-tool014-adapter-integration-wip.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue
TOOL-014 from branch codex/tool014-adapter-integration. Begin with the real Codex adapter, durable
exact-source acceptance evidence, and production support-gate routing. Keep TOOL-014, BASE-010,
all provider support labels, and the 128/375 delivered count open until the complete real
provider/version/platform matrix passes.
```
