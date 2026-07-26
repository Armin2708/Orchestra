# Agent OS TOOL-013 Exact-Head Checkpoint — 2026-07-27

Status: **TOOL-013 delivered at an exact code head**. This is a provider-contract engineering
checkpoint, not adapter integration, package publication, or a public plug-and-play claim.

## TL;DR

| State | Exact evidence |
|---|---|
| Exact code head | `38d1d2f` (`feat(agent-os): complete TOOL-013 provider contract`) |
| Branch | `codex/tool013-provider-contract` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/tool013-provider-contract` |
| Backlog truth | **128 / 375 delivered; 247 open** |
| Focused evidence | 1 file / 105 tests PASS |
| Complete evidence | 139 / 139 files and 1,161 / 1,161 tests PASS |
| Source hashes | contract `243c8581ab03dc3823a70db1f0242c4166073a4500d684f3fd19317d789f2a18`; manifests `0a64d56f277428a0bfbd9af850633454a9e788e54f015c3bc2cab72411e9340c`; tests `70462797995a72d22d747fa7d671bc9a6897dd6913d40d966979e953d601ab08` |
| Product status | Engineering preview; not plug-and-play or shippable |

## Asked

Resume the TOOL-013 WIP in its isolated worktree, preserve the dirty shared checkout, close the
gateway-assigned identity/cancellation/quarantine gaps, obtain three independent exact-hash PASS
verdicts, run the complete Node 22/build/secret/diff gates, and move the backlog only from combined
observed evidence.

## Delivered

- A versioned provider-neutral contract covers executable provenance, environment construction,
  readiness, runtime/billing/credential modes, cost and overage consent, models, capabilities,
  approvals, lifecycle controls, normalized events, usage, and explicit unsupported behavior.
- Canonical Claude Code, Codex CLI, Qwen Code, and Kimi Code manifests preserve subscription-first
  product intent without promoting unverified runtime support.
- The gateway assigns the adapter/public session ID before launch or fork, seals action evidence,
  rejects identity crossover/reuse, and keeps provider-native identifiers separate from controls.
- Malformed launch/fork output triggers redacted compensating cleanup. Failed and hung cleanup
  identities are reference-counted and consume the same bounded session capacity until proven
  released.
- Public event cancellation settles pending reads, discards late values/errors, requires valid raw
  iterator completion, preserves native `AbortSignal` behavior, and makes terminal delivery,
  concurrent stop, reentrant stop, and consumer cleanup one-shot.
- Cooperative opened-stream cleanup releases identity and capacity before awaited stop returns;
  failed or hung cleanup remains quarantined without making public stop wait indefinitely.

## Exact evidence

- Required runtime: Node `22.20.0`, npm `10.9.3`; no `.env` files were present or assumed.
- Focused provider-contract gate: 105 / 105 tests PASS.
- Complete serial gate: 139 / 139 files and 1,161 / 1,161 tests PASS.
- Root TypeScript, standalone strict test TypeScript, and web TypeScript: PASS.
- Root and web production builds: PASS.
- Gitleaks `8.30.1`: contract, manifests, tests, and exact diff PASS.
- `git diff --check`: PASS.
- Three independent exact-hash contract, async-lifecycle, and identity/accounting reviews: PASS
  with no in-scope P0, P1, or P2 findings.
- GitNexus could not resolve the new TOOL-013 symbols and reported `UNKNOWN`; the change boundary
  was treated as critical and manually reviewed rather than accepting the empty mapping as safety
  evidence.
- Browser acceptance: N/A. The exact slice adds no route, UI, or existing runtime wiring.

## Boundary and remaining work

Adapter implementations are trusted in-process Orchestra code. TOOL-013 validates and redacts
their returned values and contains ordinary listener failures through the supplied signal API; it
does not claim to sandbox deliberate arbitrary code already executing inside the daemon.

`TOOL-014` remains open for capability-aware managed adapter integration. `BASE-010` remains open
for the exact provider/version/platform/authentication/billing/capability matrix. Qwen Code and
Kimi Code remain unsupported managed providers; Claude remains policy-blocked for the declared
subscription automation path; Codex remains a candidate rather than validated support.

The product remains an engineering preview. Clean-machine packaging, declared-provider native
subscription acceptance, release provenance, dogfood, public publication, and every release gate
remain open.

## Shared-main preservation

The dirty shared checkout remained on `main` and was not reset, cleaned, switched, staged, or
committed.

- `web/src/Board.tsx` SHA-256:
  `e7b01cdab3709c66730f5b790f767e19bb2ddca6df0dc9fe56847c9b0bf0e0e8`
- `web/src/styles.css` SHA-256:
  `f54f263c6fd0f76e025b602a9f8f812d6e7e1cb4ad3e6bd8ee7f2ec5621cb2ec`
- Combined tracked UI patch ID:
  `7bbddc6e6f21c48c9e8c7826b3e2f408e7ac7572`

## Next dependency-ordered slice

Continue with `TOOL-014` without claiming a provider compatible until its exact native-subscription
acceptance matrix passes. Keep reopened `BASE-010`, all clean-machine/public release work, and
plug-and-play status open.
