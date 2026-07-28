# Agent OS TOOL-014 Codex Acceptance Harness WIP Checkpoint — 2026-07-28

Status: **restart-safe work in progress**. This checkpoint preserves the fourth TOOL-014 slice.
It is not a real provider matrix, Codex support acceptance, TOOL-014 delivery, BASE-010 closure,
or a plug-and-play claim.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/tool014-adapter-integration` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/tool014-adapter-integration` |
| Slice base | `50ab980` (`feat(agent-os): authorize Codex restart recovery`) |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **128 / 375 delivered; 247 open**; TOOL-014 and BASE-010 remain open |
| Focused evidence | 4 acceptance/adapter files / 16 tests PASS |
| Complete evidence | 144 / 144 files and 1,187 / 1,187 tests PASS |
| Compile/build/diff evidence | Root/web TypeScript PASS; root/web production builds PASS; `git diff --check` PASS |
| Product status | Engineering preview; no provider support state changed |

## Delivered in this partial TOOL-014 batch

- Added a repository-owned two-phase Codex acceptance harness:
  `npm run accept:codex -- prepare|run`.
- `prepare` requires a new or empty absolute run root, installs the exact official
  `@openai/codex@0.144.6` package from the public registry with an isolated npm cache and no host
  npm user configuration, records the registry integrity, verifies `darwin-arm64`, hashes both
  the JavaScript wrapper and native executable, creates a distinct mode-0700 `CODEX_HOME`, and
  emits the official CLI device-login command.
- Preparation never reads, copies, or exports an existing Codex auth cache. `run` uses only CLI
  and app-server account methods after the isolated profile has been authorized.
- `run` requires a clean tracked exact source commit and rejects a run root inside the
  repository. It creates a disposable Git workspace and invokes the pinned app-server through the
  existing Orchestra transport, service, driver, event projection, PTY supervisor, provider
  environment, adapter, and durable evidence code.
- The harness represents all eight required gates explicitly:
  executable provenance, subscription billing, credential conflict, managed lifecycle,
  restart recovery, raw-terminal coexistence, failure semantics, and credential redaction.
- Real lifecycle checks are conservative: first and second turns, explicit model/effort/access,
  approve/deny/timeout outcomes, projected events and usage, CLI/daemon restart plus same-thread
  follow-up, active-tool interruption, concurrent shell and native Codex TUI, files/Git/package
  tools/signals/resize/ANSI, signed-out and incompatible-version failures, exhausted-quota
  negative control, unsupported capability, and support-registry fail-closed behavior.
- Gate artifacts are canonical redacted JSON with mode 0600 and individual SHA-256 digests.
  Explicit credential sentinels abort artifact creation. Raw approval/native payloads are
  projected through the existing safe event seam before inspection.
- Every gate must contain observed evidence. Source-contract-only evidence automatically fails
  its gate. Failed runs may retain an honest diagnostic matrix, but the harness refuses to write
  an acceptance record unless all eight gates pass.
- An all-pass matrix is persisted through the existing append-only migration-019 evidence store,
  then every gate and matrix digest is independently re-read and verified.

## Observed implementation evidence

- Complete exact Node `22.20.0` suite: 144 / 144 files and 1,187 / 1,187 tests PASS.
- Focused harness/store/adapter suite: 4 files and 16 tests PASS.
- Root TypeScript, root build, web TypeScript, web production build, and `git diff --check`: PASS.
- A fresh temporary prepare run installed `@openai/codex@0.144.6` with registry integrity
  `sha512-wk+2CWiBNXiJLBoN2D08N9RceWkSBnlgk5g2K1a4CXrP/C0gdlHyRUG7RFzm9y41DCK/7tvCct233JVxyFmznw==`.
- The observed wrapper SHA-256 was
  `134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477`; the Darwin arm64
  native executable SHA-256 was
  `80a3933d11a9d13ef806aa24f7bb8afc9169cfe4e9b09d6da6a92922cbde9cff`.
- The pinned executable passed the repository protocol contract: 671 generated TypeScript files
  and schema SHA-256
  `d64c8fbadf596041d29fc39a9ed6fb41c2e6eb0ecd70f03c9b544f7f99cb8b2b`.
- Through CLI/app-server methods only, the pinned executable could read the existing host
  ChatGPT Pro account state, seven available models, and rate-limit data. No email, token, auth
  cache, or credential value was read or retained.
- The prepared clean profile correctly reports signed out. No clean-profile turn was run and no
  acceptance record was created.

## Real acceptance status

The clean-profile matrix has **not** run. The official device-login step requires a brief browser
authorization by the account holder. The in-app Browser inventory was empty (`[]`) in this
session, so the agent did not attempt to bypass the official login flow or copy the existing auth
cache.

- Required tuple: Codex CLI `0.144.6`, `darwin-arm64`, ChatGPT subscription account, exact source
  commit containing this harness.
- Current global CLI remains `0.145.0` and is retained only as the independent incompatible-version
  negative control.
- The fresh pinned tool/profile roots are temporary implementation evidence, not acceptance
  artifacts for the eventual exact commit.
- Codex remains `candidate`; native subscription remains `unknown`; production contract routing
  remains fail-closed.

## Why TOOL-014 remains open

- The account holder has not authorized a fresh isolated `CODEX_HOME`.
- No exact-source clean-profile run has produced eight all-pass real artifacts.
- The candidate Codex manifest and unknown native-subscription mode remain unchanged.
- The opt-in production route still cannot pass `requireSupported(...)`.
- A successful pre-promotion matrix would still require deliberate manifest reconciliation and a
  second exact-source all-pass run of the production route before any support claim.
- Token-budgeted contract dispatch remains blocked until an authorized token amount is sealed.
- Claude remains policy-blocked for personal-subscription automation.
- Qwen Code and Kimi Code still have no managed adapters or real exact-tuple matrices.
- BASE-010 still requires the exact four-provider version/auth/billing/capability/OS evidence.

## Next dependency-ordered work

1. Commit this harness slice so the source commit is stable.
2. Create a fresh out-of-repository run root with `npm run accept:codex -- prepare`.
3. Have the account holder complete the emitted official
   `codex login --device-auth` flow for that isolated profile.
4. Run `npm run accept:codex -- run` against the exact clean commit and inspect all eight digests.
5. Reconcile Codex provider/mode only if every real gate passes, then rerun the exact matrix and
   opt-in production route from the reconciliation commit with rollback coverage.
6. Keep TOOL-014, BASE-010, support labels, and 128 / 375 unchanged until those gates pass.

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
5. Prepare a fresh run root only after this harness commit exists; never reuse the pre-commit
   temporary profile as exact-source evidence.
6. Use only official CLI/app-server login/account methods. Never read, copy, log, or export auth
   cache contents.
7. Do not promote Codex, close TOOL-014/BASE-010, or change 128 / 375 unless the complete real
   matrix and post-reconciliation rerun pass.
8. Before each commit, rerun the complete suite, TypeScript/build/diff gates, Graphify update,
   Vault synchronization, and shared-main preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/tool014-adapter-integration/docs/checkpoints/2026-07-28-agent-os-tool014-codex-acceptance-harness-wip.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue
TOOL-014 from branch codex/tool014-adapter-integration. Commit the harness if needed, prepare a
fresh out-of-repository Codex 0.144.6 profile, complete only the official device-login flow, then
run the exact-source eight-gate matrix. Keep TOOL-014, BASE-010, every support label, and 128/375
open until the complete real matrix and post-reconciliation production rerun pass.
```
