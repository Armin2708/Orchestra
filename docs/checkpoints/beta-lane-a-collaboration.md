# Beta Lane A collaboration checkpoint

Date: 2026-08-02

## Asked

Complete the collaborative-intelligence lane on `codex/beta-collaboration`, based on
`0dd3dd43b9f376370ee73a9e2fe4725974caaae8`, without reconciling the authoritative master backlog
or north-star counts. The exclusive scope is:

- `JOB-012`;
- `DEL-004`, `DEL-005`, `DEL-011`, `DEL-015`, `DEL-016`, `DEL-019`, and `DEL-020`;
- `KNO-011` through `KNO-027` and `KNO-GATE`;
- `DSC-002` through `DSC-009`, `DSC-012`, `DSC-014` through `DSC-019`, and `DSC-GATE`;
- `TEAM-001` through `TEAM-020` and `TEAM-GATE`;
- MILE-B requested-versus-delivered proof and the three MILE-C acceptance summaries.

## Delivered

Verified implementation head:
`f9cb54e4d03423d51df1a61d332fd01170c07fad`.

- **Delivery Trackbook:** immutable verification, artifact-attestation, review-comment, regression,
  exact ShipQueue receipt, shipment, autoship-intent, and autoship-completion ledgers. Autoship
  persists accepted exact-source evidence before enqueue, reconciles a bounded restart outbox, and
  reports success only after worktree and branch cleanup.
- **MILE-B:** Job Detail exposes the frozen Asked snapshot beside Delivered results, claims,
  evidence, gaps, overrides, review state, shipment evidence, and an explicit requested-versus-
  delivered delta. Status labels cannot manufacture delivery proof.
- **Knowledge Compiler:** bounded repository/graph adapters, deterministic token-budgeted compiler,
  provenance and citation retention, injection-safe rendering, managed/follow-up context refresh,
  HEAD/source freshness, review controls, benchmark evidence, and operator-facing Knowledge UI.
  Whole-turn provider usage remains in job/agent totals and is not misattributed to a ContextUse
  without segment-level evidence.
- **Discussions:** durable questions, proposals, answers, replies, decisions, Q&A/review lifecycle,
  bounded notifications, APIs, CLI/UI, causal/idempotent events, and exact accepted-answer review.
  Knowledge promotion requires a separately reviewable exact source; neither arbitrary text nor an
  accepted status alone is promotable.
- **Teams and conflicts:** durable Team snapshots, capability/capacity-aware collaborative planning,
  exclusive executable assignment, bounded facilitation, overlap/conflict detection, proposals,
  arbiter-separated resolution, human override, audited integration, and exact-source Knowledge
  candidates. Managed agents authenticate through a one-time launch nonce and exact canonical
  provider-session credentials; a shared bearer cannot claim a hired identity.
- **Cross-domain composition:** migrations 030 through 037, focused services/routes, navigation,
  inventories, server composition, and collaboration contracts are integrated without changing
  authoritative backlog or north-star status counts.

## MILE-C acceptance summaries

1. **Knowledge:** a managed agent receives a bounded, cited, provenance-preserving context build;
   runtime use records the exact build and freshness state, while unsupported actual-token
   attribution stays null and review controls can suppress or restore sources.
2. **Discussions:** an agent can ask, answer, review, and accept through durable causal events;
   bounded peers are notified, and only a separately reviewed, exact-source promotion enters
   Knowledge.
3. **Teams:** an operator can form a capability-aware Team, produce a bounded plan, delegate one
   exclusive executable assignment, resolve overlapping work with arbiter/human control, and retain
   audited integration and delivery evidence.

## Evidence

Environment: Node `22.20.0`, npm `10.9.3`. No root or web `.env` file exists.

| Gate | Exact result |
|---|---|
| Focused final remediation | 10 files / 124 tests passed |
| Final Codex credential/autoship starvation remediation | 7 files / 91 tests passed |
| Crash-consistency regression proof | 2 files / 28 tests passed |
| Complete default repository suite | 208 files / 1,774 tests passed in 113.03s |
| Complete one-worker repository suite | 208 files / 1,774 tests passed in 274.07s |
| Root TypeScript and production build | passed |
| Web TypeScript and production build | passed; collaboration, knowledge, discussion, organization, Agent Home, and Open Work chunks emitted |
| Root and web dependency audits | zero vulnerabilities |
| Lane-scoped Gitleaks | 33 implementation commits and 982.68 KB scanned; no leaks found |
| Package dry-run | passed; 53 files, about 1.0 MB packed / 4.8 MB unpacked |
| GitNexus | pre-edit impact checks completed; the final implementation change set's HIGH blast radius (six execution flows) was reviewed before commit, and final documentation-only staged detection was LOW risk with no affected execution flows |
| Graphify | refreshed to 7,964 nodes, 19,498 edges, and 299 communities; generated artifacts preserved outside the worktree |

Independent review was repeated after the initial P1/P2 findings were remediated. The final review
covered the exact implementation head shown above.

## Remaining and known limitations

- No owned Beta Lane A implementation item is intentionally deferred.
- The configured in-app Browser backend was unavailable during combined lane verification. Earlier
  configured Playwright desktop/mobile acceptance covered the real Discussion and collaboration
  UI/API paths with zero console errors; a new combined screenshot set was not fabricated.
- The Knowledge benchmark is a controlled reproducible harness, not a longitudinal study of every
  provider/model combination.
- ContextUse `actual_tokens` remains null unless segment-level attribution exists; aggregate
  provider/job usage is still retained separately.
- Autoship reconciliation is deliberately bounded to 200 pending intents per startup pass. Pending
  records remain durable for a later pass rather than being discarded or inferred from card state.

## Final independent review

Clean at `f9cb54e4d03423d51df1a61d332fd01170c07fad`: no P0, P1, or P2 findings. The
reviewer independently reran the two crash-consistency regression files (28 tests) and TypeScript
checking, and confirmed the worktree evidence was clean.
